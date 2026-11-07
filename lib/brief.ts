// Shared 10-K pipeline used by both the brief page (/api/brief) and the chat agent's tools.
import {
  fetchFilingSections,
  latestFiling,
  lookupTicker,
  type Company,
  type FilingRef,
  type SectionKey,
} from "./edgar";
import { summarize10K, type Brief } from "./summarize";

type Sections = Record<SectionKey, string | null>;

// Keyed by accession number: a 10-K never changes once filed. Promises are cached so
// concurrent requests for the same filing share one fetch/summarization. In-memory only;
// production would use Redis/KV.
const sectionsCache = new Map<string, Promise<Sections>>();
const briefCache = new Map<string, Promise<Brief>>();

function memo<T>(cache: Map<string, Promise<T>>, key: string, fn: () => Promise<T>): Promise<T> {
  let p = cache.get(key);
  if (!p) {
    p = fn().catch((e) => {
      cache.delete(key);
      throw e;
    });
    cache.set(key, p);
  }
  return p;
}

export class NotFoundError extends Error {}

export async function resolveLatest10K(ticker: string): Promise<{ company: Company; filing: FilingRef | null }> {
  const company = await lookupTicker(ticker);
  if (!company) throw new NotFoundError(`No SEC registrant found for ${ticker}.`);
  return { company, filing: await latestFiling(company.cik, "10-K") };
}

export function getSections(filing: FilingRef): Promise<Sections> {
  return memo(sectionsCache, filing.accession, () => fetchFilingSections(filing.url));
}

export type BriefResult = {
  company: Company;
  filing: FilingRef | null;
  brief: Brief | null;
  sectionsFound: Record<string, boolean>;
};

export async function getBrief(ticker: string): Promise<BriefResult> {
  const { company, filing } = await resolveLatest10K(ticker);
  if (!filing) return { company, filing: null, brief: null, sectionsFound: {} };

  const sections = await getSections(filing);
  const sectionsFound = Object.fromEntries(Object.entries(sections).map(([k, v]) => [k, !!v]));
  if (!Object.values(sections).some(Boolean)) {
    throw new Error("Could not locate Items 1, 1A, or 7 in the 10-K document.");
  }
  const brief = await memo(briefCache, filing.accession, () =>
    summarize10K(company.name, filing.reportDate, sections),
  );
  return { company, filing, brief, sectionsFound };
}

const STOP = new Set("the and for with that this what did they about from have has are was were their its company".split(" "));

/** Keyword search over the extracted 10-K sections; returns the best-matching passages with their Item. */
export async function searchFiling(ticker: string, query: string, limit = 5) {
  const { company, filing } = await resolveLatest10K(ticker);
  if (!filing) return { company, filing: null, passages: [] };
  const sections = await getSections(filing);

  const terms = query.toLowerCase().split(/\W+/).filter((t) => t.length > 2 && !STOP.has(t));
  const passages: { item: SectionKey; text: string; score: number }[] = [];
  for (const [item, text] of Object.entries(sections) as [SectionKey, string | null][]) {
    if (!text) continue;
    // Group lines into ~1,000-char passages so each result has enough context.
    let buf = "";
    const flush = () => {
      const lower = buf.toLowerCase();
      const score = terms.reduce((n, t) => n + (lower.split(t).length - 1), 0);
      if (score > 0) passages.push({ item, text: buf.trim(), score });
      buf = "";
    };
    for (const line of text.split("\n")) {
      buf += line + "\n";
      if (buf.length > 1000) flush();
    }
    flush();
  }
  passages.sort((a, b) => b.score - a.score);
  return { company, filing, passages: passages.slice(0, limit).map(({ item, text }) => ({ item, text })) };
}
