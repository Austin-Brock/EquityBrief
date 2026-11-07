# EquityBrief

An AI-powered stock research tool that helps wealth-management advisors get up to speed on a public company in under a minute: a **current quote** plus a **sourced summary of the latest 10-K**.

Two ways to use it:
- **Brief** (`/`): type a ticker, get a quote card and a cited 10-K brief.
- **Chat** (`/chat`): ask in plain English, e.g. *"Tell me what I should know about Apple for my 10am meeting."* An agent calls tools (company lookup, quote, filings, 10-K summary, filing search), shows the same cards inline, and writes meeting-prep talking points grounded in what it found.

## Quick start

```bash
cp .env.example .env.local   # fill in Alpaca, OpenAI, and SEC User-Agent
npm install
npm run dev                  # http://localhost:3000
```

| Variable | Notes |
| --- | --- |
| `ALPACA_API_KEY_ID` / `ALPACA_API_SECRET_KEY` | Paper-trading keys work for market data. |
| `ALPACA_DATA_FEED` | `iex` (free) or `sip` (paid). |
| `SEC_USER_AGENT` | SEC requires `"AppName contact@email"`; requests without it get 403s. |
| `OPENAI_API_KEY` / `OPENAI_MODEL` | Defaults to `gpt-4.1-mini`. |

## How it works

```
ticker ─┬─> Alpaca /v2/stocks/{sym}/snapshot ──────────────> quote card
        └─> SEC company_tickers.json (ticker → CIK)
             └─> data.sec.gov submissions (latest 10-K)
                  └─> 10-K HTML → text → extract Items 1, 1A, 7
                       └─> OpenAI (strict JSON schema) → grounding check → brief
```

- `lib/alpaca.ts`: one snapshot call returns the latest trade, quote, and daily/previous bars.
- `lib/edgar.ts`: ticker→CIK lookup, finding the latest 10-K, HTML→text, and section extraction.
- `lib/summarize.ts`: the prompt, JSON schema, and evidence verification.
- `lib/brief.ts`: the shared 10-K pipeline and caches, used by both the brief page and the chat tools.
- `app/api/brief/route.ts`: the brief page's endpoint. The quote is fetched in parallel, and a quote failure doesn't block the brief.

### Chat agent

The agent loop is hand-written on OpenAI tool calling, with no agent framework (`lib/agent.ts`, ~60 lines): call the model → run any requested tools in parallel → return the results to the model → repeat until it answers, with a maximum of 6 steps. `app/api/chat/route.ts` streams newline-delimited JSON events (`tool_start`, `tool_result`, `text`) so the UI can show live progress and render tool results as the same quote and brief cards.

| Tool | Does |
| --- | --- |
| `resolve_company` | "Apple" → AAPL / CIK (ignores punctuation and suffixes like Inc. and Co.) |
| `get_stock_quote` | Alpaca snapshot |
| `get_sec_filings` | Recent 10-K / 10-Q / 8-K list with links |
| `summarize_10k` | The same verified, cited brief as the brief page (cached) |
| `search_filing` | Keyword search over Items 1, 1A, 7 for follow-up questions |

Tool errors are returned to the model as data, so it can say what's unavailable instead of failing. See `docs/architecture.html` for a diagram.

## Design decisions

**Summarize sections, not the whole 10-K.** A 10-K is often 100k+ tokens, mostly boilerplate and financial statement tables. Items 1 (Business), 1A (Risk Factors), and 7 (MD&A) carry the information an advisor needs. Each is capped in length to keep cost and latency bounded.

**Finding the real section headings.** Each "Item" heading appears in the table of contents and also in cross-references ("see Item 1A. Risk Factors"). The extractor only counts headings that start a line, then keeps the *longest* span between a start heading and the next end heading. Tested on AAPL, NVDA, TSLA, KO, and JPM.

**Every claim is traceable.** The model must return each bullet with its source Item and a *verbatim* evidence excerpt. The server then checks that the excerpt actually appears in the cited section, and the UI flags any bullet whose quote can't be found. Advisors may repeat this material to clients, so traceability matters more than eloquence.

**Compliance tone.** The prompt forbids outside knowledge, ratings, and price targets, and the UI labels the output as an AI-generated summary that is not investment advice.

**Honest data labeling.** Alpaca's free IEX feed covers a small share of consolidated volume, so the quote card names the feed and its as-of time.

**No agent framework.** Tool calling is built into the OpenAI API, so the loop, tool schemas, and event stream are plain code you can read end to end. That's one less dependency and easier to explain.

**The agent gets finished briefs, not raw filings.** `summarize_10k` returns the already-verified brief instead of putting 100k tokens of filing text in the chat model's context. This keeps the citation check, caps cost, and makes chat output match the brief page.

## Data & storage

Nothing is written to a database. Everything lives in server memory, the Next.js fetch cache, or the browser tab:

| Data | Where | Keyed by | Lifetime |
| --- | --- | --- | --- |
| SEC ticker → company list | Server memory | — (one shared list) | Until restart |
| Company filing index | Next.js fetch cache (`.next/cache`) | SEC URL (includes CIK) | 1 hour |
| Extracted 10-K sections | Server memory (`lib/brief.ts`) | 10-K accession number | Until restart |
| 10-K brief (summary) | Server memory (`lib/brief.ts`) | 10-K accession number | Until restart |
| Stock quotes | Not cached; fetched live every time | — | — |
| 10-K HTML (2MB+) | Not cached; only the extracted sections are kept | — | — |
| Chat conversation | Browser tab (React state) | — | Lost on refresh |

**Companies are isolated by key.** Each accession number (e.g. `0000320193-26-000026` for Apple's FY2026 10-K) identifies exactly one filing by one company, so Amazon and Microsoft data can never be mixed. Repeat lookups of the same company reuse the cached brief (~0.15s instead of ~12s, with no OpenAI cost). A new 10-K has a new accession number, so it's summarized fresh. Concurrent requests for the same filing share one summarization.

**The cache is shared across users.** That's deliberate: SEC filings are public and identical for every advisor. There's no per-user data because there are no user accounts.

**What leaves the server.** Chat messages and filing text are sent to OpenAI to generate answers. EquityBrief doesn't store them, but anything an advisor types (including client names) goes to OpenAI. A production deployment would need an enterprise data agreement or guidance against entering client information.

**Production changes:** move the brief cache to Postgres/Redis so it survives deploys and is shared across instances; cap in-memory caches with LRU eviction; persist chat history if the firm's record-keeping rules require research records to be retained.

## How this scales

Measured on the Apple run: a 10-K brief is ~2k tokens in the agent's context, a quote ~90. The context window isn't the limit. These are:

- **Summarization cost and OpenAI rate limits:** each uncached 10-K sends ~50k tokens to the model. 30 new companies at once is ~1.5M tokens in a burst.
- **SEC fair-access limit (10 req/s):** parallel lookups need a concurrency limiter.
- **Request timeout** (120s on the chat route).

Since a 10-K brief is identical for every advisor and changes once a year, the scalable design is to **precompute** briefs for the firm's coverage universe (e.g. S&P 500 + client holdings) in a nightly job that only re-summarizes when a new 10-K appears, and store them in a database. A portfolio/watchlist view would then load 30 companies instantly, with chat kept for one-or-a-few-company questions.

## Known limitations

- Some filers (e.g. JPM) place MD&A outside the standard Item 7 location. The UI reports the missing section rather than guessing.
- Foreign filers that file 20-F/40-F instead of a 10-K aren't supported yet.
- The in-memory cache is per process and unbounded. Production would use Redis/Postgres with eviction.
- Chat sends only the text of earlier turns (capped at the last 20 messages); the agent re-calls tools for follow-ups, which is cheap because briefs are cached.
- The agent occasionally makes an unnecessary tool call (e.g. refetching a quote on a follow-up).
- The final chat answer arrives in one piece, not streamed word by word.
- Verbatim matching can produce false negatives when the model normalizes punctuation. Those bullets are flagged, not hidden.

## Next steps

1. **XBRL financial trends** from `data.sec.gov/api/xbrl/companyfacts`: 5-year revenue, net income, and EPS straight from structured data, with no LLM involved for the numbers.
2. **Latest 10-Q** for "what changed since the 10-K", plus **8-Ks** for material events.
3. **Form 4** insider activity.
4. **Precomputed briefs + portfolio view** (see "How this scales").
5. **Smaller tool results for the agent:** send bullet text + Item only (~750 vs ~2,050 tokens per brief); the UI keeps the full version.
6. **Better filing search:** embeddings-based retrieval instead of keyword matching for `search_filing`.
7. Evaluation set: spot-check briefs against filings and track the evidence-verification rate as a quality metric.
