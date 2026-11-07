// Tools the chat agent can call. Each is a thin wrapper over the same code the brief page uses.
import type OpenAI from "openai";
import { getQuote } from "./alpaca";
import { getBrief, searchFiling } from "./brief";
import { listFilings, lookupTicker, searchCompanies } from "./edgar";

const fn = (
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
): OpenAI.Chat.Completions.ChatCompletionFunctionTool => ({
  type: "function",
  function: {
    name,
    description,
    strict: true,
    parameters: { type: "object", properties, required, additionalProperties: false },
  },
});

const ticker = { type: "string", description: "Exact stock ticker, e.g. AAPL" };

export const TOOLS = [
  fn(
    "resolve_company",
    "Find a public company's ticker and SEC CIK from a name or ticker. Returns up to 5 candidates, best match first.",
    { query: { type: "string", description: "Company name or ticker, e.g. 'Apple'" } },
    ["query"],
  ),
  fn(
    "get_stock_quote",
    "Latest stock quote: price, change vs previous close, day range, bid/ask. Shown to the user as a quote card.",
    { ticker },
    ["ticker"],
  ),
  fn(
    "get_sec_filings",
    "List the company's recent SEC filings (dates and links) of the given form types.",
    {
      ticker,
      forms: {
        type: "array",
        items: { type: "string", enum: ["10-K", "10-Q", "8-K", "DEF 14A", "4"] },
        description: "Form types to include",
      },
    },
    ["ticker", "forms"],
  ),
  fn(
    "summarize_10k",
    "Structured, cited summary of the latest Form 10-K: one-liner, business snapshot, key financials, top risks, MD&A highlights, what to watch. Each bullet cites its 10-K Item. Shown to the user as a brief card. Takes 10-20s the first time per filing.",
    { ticker },
    ["ticker"],
  ),
  fn(
    "search_filing",
    "Keyword search over the latest 10-K's Business, Risk Factors and MD&A sections. Use for specific questions the summary doesn't answer (e.g. 'tariffs', 'China', 'buybacks').",
    { ticker, query: { type: "string", description: "Keywords to search for" } },
    ["ticker", "query"],
  ),
];

/** Run a tool by name. Errors are returned as data so the model can explain what's unavailable. */
export async function runTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  try {
    switch (name) {
      case "resolve_company":
        return { matches: await searchCompanies(String(args.query)) };
      case "get_stock_quote": {
        const t = String(args.ticker).toUpperCase();
        const [company, quote] = await Promise.all([
          lookupTicker(t),
          getQuote(t).catch((e: Error) => ({ error: e.message })),
        ]);
        return { company: company ?? { ticker: t, name: t, cik: "" }, quote };
      }
      case "get_sec_filings": {
        const company = await lookupTicker(String(args.ticker));
        if (!company) return { error: `No SEC registrant found for ${args.ticker}.` };
        return { company, filings: await listFilings(company.cik, args.forms as string[]) };
      }
      case "summarize_10k":
        return await getBrief(String(args.ticker));
      case "search_filing":
        return await searchFiling(String(args.ticker), String(args.query));
      default:
        return { error: `Unknown tool: ${name}` };
    }
  } catch (e) {
    return { error: (e as Error).message };
  }
}
