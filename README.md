# EquityBrief

An AI-powered stock research tool that helps wealth-management advisors get up to speed on a public company in under a minute: a **current quote** plus a **sourced summary of the latest 10-K**.

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
- `app/api/brief/route.ts`: runs the steps in order. The quote is fetched in parallel, and a quote failure doesn't block the brief.

## Design decisions

**Summarize sections, not the whole 10-K.** A 10-K is often 100k+ tokens, mostly boilerplate and financial statement tables. Items 1 (Business), 1A (Risk Factors), and 7 (MD&A) carry the information an advisor needs. Each is capped in length to keep cost and latency bounded.

**Finding the real section headings.** Each "Item" heading appears in the table of contents and also in cross-references ("see Item 1A. Risk Factors"). The extractor only counts headings that start a line, then keeps the *longest* span between a start heading and the next end heading. Tested on AAPL, NVDA, TSLA, KO, and JPM.

**Every claim is traceable.** The model must return each bullet with its source Item and a *verbatim* evidence excerpt. The server then checks that the excerpt actually appears in the cited section, and the UI flags any bullet whose quote can't be found. Advisors may repeat this material to clients, so traceability matters more than eloquence.

**Compliance tone.** The prompt forbids outside knowledge, ratings, and price targets, and the UI labels the output as an AI-generated summary that is not investment advice.

**Honest data labeling.** Alpaca's free IEX feed covers a small share of consolidated volume, so the quote card names the feed and its as-of time.

**Caching.** Briefs are cached in memory by 10-K accession number, since a 10-K is filed once a year. SEC metadata is revalidated hourly. Quotes are never cached.

## Known limitations

- Some filers (e.g. JPM) place MD&A outside the standard Item 7 location. The UI reports the missing section rather than guessing.
- Foreign filers that file 20-F/40-F instead of a 10-K aren't supported yet.
- The in-memory cache is per process. Production would use Redis/KV.
- Verbatim matching can produce false negatives when the model normalizes punctuation. Those bullets are flagged, not hidden.

## Next steps

1. **XBRL financial trends** from `data.sec.gov/api/xbrl/companyfacts`: 5-year revenue, net income, and EPS straight from structured data, with no LLM involved for the numbers.
2. **Latest 10-Q** for "what changed since the 10-K", plus **8-Ks** for material events.
3. **Form 4** insider activity.
4. **Follow-up Q&A** over the filing (retrieval over chunks, with the same citation rules).
5. Evaluation set: spot-check briefs against filings and track the evidence-verification rate as a quality metric.
