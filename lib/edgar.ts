// SEC EDGAR: free, no key, but requires a descriptive User-Agent with contact info
// and a max of 10 req/s. https://www.sec.gov/os/accessing-edgar-data
import * as cheerio from "cheerio";

const UA = () => {
  const ua = process.env.SEC_USER_AGENT;
  if (!ua) throw new Error("SEC_USER_AGENT is not configured (e.g. 'EquityBrief you@example.com')");
  return ua;
};

async function secFetch(url: string) {
  const res = await fetch(url, {
    headers: { "User-Agent": UA(), "Accept-Encoding": "gzip, deflate" },
    next: { revalidate: 3600 },
  });
  if (!res.ok) throw new Error(`SEC ${res.status} for ${url}`);
  return res;
}

export type Company = { cik: string; ticker: string; name: string };

export async function lookupTicker(ticker: string): Promise<Company | null> {
  const data: Record<string, { cik_str: number; ticker: string; title: string }> = await (
    await secFetch("https://www.sec.gov/files/company_tickers.json")
  ).json();
  const t = ticker.toUpperCase();
  const hit = Object.values(data).find((c) => c.ticker === t);
  return hit ? { cik: String(hit.cik_str), ticker: hit.ticker, name: hit.title } : null;
}

export type FilingRef = {
  form: string;
  accession: string;
  filingDate: string;
  reportDate: string;
  url: string;
};

export async function latestFiling(cik: string, form = "10-K"): Promise<FilingRef | null> {
  const padded = cik.padStart(10, "0");
  const sub = await (await secFetch(`https://data.sec.gov/submissions/CIK${padded}.json`)).json();
  const r = sub.filings.recent;
  for (let i = 0; i < r.form.length; i++) {
    if (r.form[i] === form) {
      const acc: string = r.accessionNumber[i];
      return {
        form,
        accession: acc,
        filingDate: r.filingDate[i],
        reportDate: r.reportDate[i],
        url: `https://www.sec.gov/Archives/edgar/data/${cik}/${acc.replace(/-/g, "")}/${r.primaryDocument[i]}`,
      };
    }
  }
  return null;
}

/** Convert filing HTML (usually inline XBRL) to plain text with line breaks preserved. */
export function htmlToText(html: string): string {
  const $ = cheerio.load(html);
  $("script, style, ix\\:header, [style*='display:none'], [style*='display: none']").remove();
  $("p, div, tr, li, br, h1, h2, h3, h4, h5, h6, table").each((_, el) => {
    $(el).append("\n");
  });
  return $("body")
    .text()
    .replace(/ /g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

export type SectionKey = "Item 1" | "Item 1A" | "Item 7";

// Headings must start a line, which skips inline cross-references like "see Item 1A. Risk Factors".
const SEP = String.raw`\s*[.:\-–—]?\s*`;
const START: Record<SectionKey, RegExp> = {
  "Item 1": new RegExp(String.raw`^[ \t]*item\s*1${SEP}business\b`, "gim"),
  "Item 1A": new RegExp(String.raw`^[ \t]*item\s*1a${SEP}risk\s*factors`, "gim"),
  "Item 7": new RegExp(String.raw`^[ \t]*item\s*7${SEP}management['’]?s\s*discussion`, "gim"),
};
const END: Record<SectionKey, RegExp> = {
  "Item 1": new RegExp(String.raw`^[ \t]*item\s*1a${SEP}risk\s*factors`, "gim"),
  "Item 1A": new RegExp(String.raw`^[ \t]*item\s*(1b|1c|2)${SEP}(unresolved|cybersecurity|properties)`, "gim"),
  "Item 7": new RegExp(String.raw`^[ \t]*item\s*(7a|8)${SEP}(quantitative|financial\s*statements)`, "gim"),
};

/**
 * Item headings appear twice: once in the table of contents, once as the real heading.
 * For each start match, find the next end match and keep the longest span — the ToC
 * entry spans only a line or two, the real section spans pages.
 */
export function extractSection(text: string, key: SectionKey): string | null {
  const starts = [...text.matchAll(START[key])].map((m) => m.index!);
  const ends = [...text.matchAll(END[key])].map((m) => m.index!);
  let best: [number, number] | null = null;
  for (const s of starts) {
    const e = ends.find((x) => x > s) ?? text.length;
    if (!best || e - s > best[1] - best[0]) best = [s, e];
  }
  if (!best || best[1] - best[0] < 500) return null;
  return text.slice(best[0], best[1]).trim();
}

export async function fetchFilingSections(url: string) {
  const html = await (await secFetch(url)).text();
  const text = htmlToText(html);
  const sections = {} as Record<SectionKey, string | null>;
  for (const k of Object.keys(START) as SectionKey[]) sections[k] = extractSection(text, k);
  return sections;
}
