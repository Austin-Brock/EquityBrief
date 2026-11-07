import { NextRequest } from "next/server";
import { getQuote } from "@/lib/alpaca";
import { fetchFilingSections, latestFiling, lookupTicker } from "@/lib/edgar";
import { summarize10K, type Brief } from "@/lib/summarize";

export const maxDuration = 120;

// 10-Ks change once a year: cache summaries by accession number (in-memory; swap for KV/DB in prod).
const briefCache = new Map<string, Brief>();

export async function GET(req: NextRequest) {
  const ticker = (req.nextUrl.searchParams.get("ticker") ?? "").trim().toUpperCase();
  if (!/^[A-Z][A-Z.\-]{0,9}$/.test(ticker)) {
    return Response.json({ error: "Enter a valid ticker symbol." }, { status: 400 });
  }

  try {
    const company = await lookupTicker(ticker);
    if (!company) return Response.json({ error: `No SEC registrant found for ${ticker}.` }, { status: 404 });

    // Quote and filing work are independent: run in parallel; a quote failure shouldn't kill the brief.
    const quoteP = getQuote(ticker).catch((e: Error) => ({ error: e.message }));
    const filing = await latestFiling(company.cik, "10-K");

    let brief: Brief | null = null;
    let sectionsFound: Record<string, boolean> = {};
    if (filing) {
      brief = briefCache.get(filing.accession) ?? null;
      if (!brief) {
        const sections = await fetchFilingSections(filing.url);
        sectionsFound = Object.fromEntries(Object.entries(sections).map(([k, v]) => [k, !!v]));
        if (!Object.values(sections).some(Boolean)) {
          throw new Error("Could not locate Items 1, 1A, or 7 in the 10-K document.");
        }
        brief = await summarize10K(company.name, filing.reportDate, sections);
        briefCache.set(filing.accession, brief);
      }
    }

    return Response.json({ company, quote: await quoteP, filing, brief, sectionsFound });
  } catch (e) {
    console.error(e);
    return Response.json({ error: (e as Error).message }, { status: 502 });
  }
}
