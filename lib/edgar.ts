// SEC EDGAR: free, no key, but requires a descriptive User-Agent with contact info
// and a max of 10 req/s. https://www.sec.gov/os/accessing-edgar-data
import * as cheerio from "cheerio";

const UA = () => {
  const ua = process.env.SEC_USER_AGENT;
  if (!ua) throw new Error("SEC_USER_AGENT is not configured (e.g. 'EquityBrief you@example.com')");
  return ua;
};

async function secFetch(url: string, init: RequestInit = { next: { revalidate: 3600 } }) {
  const res = await fetch(url, {
    ...init,
    headers: { "User-Agent": UA(), "Accept-Encoding": "gzip, deflate" },
  });
  if (!res.ok) throw new Error(`SEC ${res.status} for ${url}`);
  return res;
}

export type Company = { cik: string; ticker: string; name: string };

let companiesMemo: Promise<Company[]> | null = null;
function allCompanies(): Promise<Company[]> {
  companiesMemo ??= secFetch("https://www.sec.gov/files/company_tickers.json")
    .then((r) => r.json())
    .then((data: Record<string, { cik_str: number; ticker: string; title: string }>) =>
      Object.values(data).map((c) => ({ cik: String(c.cik_str), ticker: c.ticker, name: c.title })),
    )
    .catch((e) => {
      companiesMemo = null; // don't cache failures
      throw e;
    });
  return companiesMemo;
}

// SEC uses dashes for share classes (BRK-B); people often type BRK.B.
const normTicker = (t: string) => t.trim().toUpperCase().replace(/\./g, "-");

export async function lookupTicker(ticker: string): Promise<Company | null> {
  const t = normTicker(ticker);
  return (await allCompanies()).find((c) => c.ticker === t) ?? null;
}

// "Coca-Cola Company" and "COCA COLA CO" should compare equal: drop punctuation and corporate suffixes.
const SUFFIX = /\b(inc|incorporated|corp|corporation|co|company|ltd|limited|plc|holdings?|group|sa|nv|ag|the)\b/g;
const baseName = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(SUFFIX, " ").replace(/\s+/g, " ").trim();

/** Fuzzy company search by ticker or name, e.g. "apple" -> Apple Inc. (AAPL) first. */
export async function searchCompanies(query: string, limit = 5): Promise<Company[]> {
  const q = baseName(query);
  if (!q) return [];
  const qTicker = normTicker(query);
  const scored: [number, Company][] = [];
  for (const c of await allCompanies()) {
    const name = baseName(c.name);
    let score = 0;
    if (c.ticker === qTicker) score = 100;
    else if (name === q) score = 90;
    else if (name.startsWith(q + " ")) score = 70;
    else if (name.includes(q)) score = 30;
    if (score) scored.push([score - c.name.length / 100, c]); // shorter names win ties
  }
  return scored.sort((a, b) => b[0] - a[0]).slice(0, limit).map(([, c]) => c);
}

export type FilingRef = {
  form: string;
  accession: string;
  filingDate: string;
  reportDate: string;
  url: string;
};

async function recentFilings(cik: string) {
  const padded = cik.padStart(10, "0");
  const sub = await (await secFetch(`https://data.sec.gov/submissions/CIK${padded}.json`)).json();
  const r = sub.filings.recent;
  const out: FilingRef[] = [];
  for (let i = 0; i < r.form.length; i++) {
    const acc: string = r.accessionNumber[i];
    out.push({
      form: r.form[i],
      accession: acc,
      filingDate: r.filingDate[i],
      reportDate: r.reportDate[i],
      url: `https://www.sec.gov/Archives/edgar/data/${cik}/${acc.replace(/-/g, "")}/${r.primaryDocument[i]}`,
    });
  }
  return out; // newest first
}

export async function latestFiling(cik: string, form = "10-K"): Promise<FilingRef | null> {
  return (await recentFilings(cik)).find((f) => f.form === form) ?? null;
}

export async function listFilings(cik: string, forms: string[], limit = 10): Promise<FilingRef[]> {
  return (await recentFilings(cik)).filter((f) => forms.includes(f.form)).slice(0, limit);
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
  // 10-K documents are 2MB+, over the Next.js data-cache limit; lib/brief.ts caches the extracted sections instead.
  const html = await (await secFetch(url, { cache: "no-store" })).text();
  const text = htmlToText(html);
  const sections = {} as Record<SectionKey, string | null>;
  for (const k of Object.keys(START) as SectionKey[]) sections[k] = extractSection(text, k);
  return sections;
}
