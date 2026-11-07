"use client";

import { useState } from "react";
import { BriefView, QuoteCard, type QuoteResult } from "@/app/components/cards";
import type { Company, FilingRef } from "@/lib/edgar";
import type { Brief } from "@/lib/summarize";

type Result = {
  company: Company;
  quote: QuoteResult;
  filing: FilingRef | null;
  brief: Brief | null;
  sectionsFound: Record<string, boolean>;
};

export default function Home() {
  const [ticker, setTicker] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<Result | null>(null);

  async function run(e: React.FormEvent) {
    e.preventDefault();
    if (!ticker.trim()) return;
    setLoading(true);
    setError(null);
    setData(null);
    try {
      const res = await fetch(`/api/brief?ticker=${encodeURIComponent(ticker.trim())}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Request failed");
      setData(json);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="mx-auto w-full max-w-4xl px-6 py-12 font-sans">
      <header className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight">Stock brief</h1>
        <p className="text-sm text-neutral-600">
          Current quote plus a sourced summary of the latest 10-K, for getting up to speed fast.
        </p>
      </header>

      <form onSubmit={run} className="mb-10 flex gap-2">
        <input
          value={ticker}
          onChange={(e) => setTicker(e.target.value.toUpperCase())}
          placeholder="Ticker, e.g. AAPL"
          aria-label="Ticker symbol"
          className="w-48 rounded-md border border-neutral-300 bg-white px-3 py-2 font-mono uppercase outline-none focus:border-neutral-800"
        />
        <button
          disabled={loading}
          className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {loading ? "Building brief…" : "Get brief"}
        </button>
      </form>

      {loading && (
        <p className="text-sm text-neutral-500">
          Fetching quote and latest 10-K from SEC EDGAR, then summarizing. First run per filing takes ~20–40s.
        </p>
      )}
      {error && <p className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</p>}

      {data && (
        <div className="space-y-8">
          <QuoteCard company={data.company} quote={data.quote} />
          {data.filing && data.brief ? (
            <BriefView brief={data.brief} filing={data.filing} sectionsFound={data.sectionsFound} />
          ) : (
            <p className="text-sm text-neutral-600">No 10-K found for this registrant (it may file 20-F/40-F).</p>
          )}
          <p className="border-t border-neutral-200 pt-4 text-xs text-neutral-500">
            AI-generated summary of public SEC filings for internal research only. Not investment advice. Verify
            against the source filing before client use.
          </p>
        </div>
      )}
    </main>
  );
}
