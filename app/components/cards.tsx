// Cards shared by the brief page and the chat page, so both render tool results identically.
import type { Quote } from "@/lib/alpaca";
import type { Company, FilingRef } from "@/lib/edgar";
import type { Brief, Bullet } from "@/lib/summarize";

export type QuoteResult = Quote | { error: string };

const usd = (n: number | null | undefined) =>
  n == null ? "—" : n.toLocaleString("en-US", { style: "currency", currency: "USD" });

export function QuoteCard({ company, quote }: { company: Company; quote: QuoteResult }) {
  return (
    <section className="rounded-lg border border-neutral-200 bg-white p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold">{company.name}</h2>
          <p className="font-mono text-sm text-neutral-500">
            {company.ticker} · CIK {company.cik}
          </p>
        </div>
        {"error" in quote ? (
          <p className="text-sm text-red-700">Quote unavailable: {quote.error}</p>
        ) : (
          <div className="text-right">
            <p className="font-mono text-3xl font-semibold tabular-nums">{usd(quote.price)}</p>
            {quote.change != null && (
              <p className={`font-mono text-sm tabular-nums ${quote.change >= 0 ? "text-green-700" : "text-red-700"}`}>
                {quote.change >= 0 ? "+" : ""}
                {quote.change.toFixed(2)} ({quote.changePct!.toFixed(2)}%)
              </p>
            )}
          </div>
        )}
      </div>
      {!("error" in quote) && (
        <>
          <dl className="mt-4 grid grid-cols-3 gap-x-6 gap-y-2 text-sm sm:grid-cols-6">
            {[
              ["Open", usd(quote.dayOpen)],
              ["High", usd(quote.dayHigh)],
              ["Low", usd(quote.dayLow)],
              ["Prev close", usd(quote.prevClose)],
              ["Bid / Ask", `${usd(quote.bid)} / ${usd(quote.ask)}`],
              [quote.feed === "IEX" ? "IEX volume" : "Volume", quote.volume?.toLocaleString() ?? "—"],
            ].map(([k, v]) => (
              <div key={k}>
                <dt className="text-xs text-neutral-500">{k}</dt>
                <dd className="font-mono tabular-nums">{v}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-3 text-xs text-neutral-500">
            Alpaca {quote.feed} feed · last trade {new Date(quote.asOf).toLocaleString()}
            {quote.feed === "IEX" && " · IEX covers a fraction of consolidated volume; prices may differ slightly from SIP."}
          </p>
        </>
      )}
    </section>
  );
}

const SECTIONS: [keyof Brief, string][] = [
  ["businessSnapshot", "Business snapshot"],
  ["keyFinancials", "Key financials"],
  ["topRisks", "Top risks"],
  ["mdnaHighlights", "MD&A highlights"],
  ["whatToWatch", "What to watch"],
];

export function BriefView({
  brief,
  filing,
  sectionsFound,
}: {
  brief: Brief;
  filing: FilingRef;
  sectionsFound: Record<string, boolean>;
}) {
  const missing = Object.entries(sectionsFound).filter(([, v]) => !v).map(([k]) => k);
  return (
    <section>
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-semibold">10-K brief</h2>
        <a href={filing.url} target="_blank" rel="noreferrer" className="text-sm text-neutral-600 underline">
          Form 10-K · period ended {filing.reportDate} · filed {filing.filingDate} ↗
        </a>
      </div>
      <p className="mb-6 text-neutral-800">{brief.oneLiner}</p>
      {missing.length > 0 && (
        <p className="mb-6 rounded-md bg-amber-50 p-3 text-sm text-amber-900">
          Could not locate {missing.join(", ")} in this filing (some issuers incorporate sections by reference); the
          brief omits content from those sections.
        </p>
      )}
      <div className="grid gap-6 md:grid-cols-2">
        {SECTIONS.map(([key, label]) => (
          <div key={key} className="rounded-lg border border-neutral-200 bg-white p-5">
            <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-neutral-500">{label}</h3>
            <ul className="space-y-3">
              {(brief[key] as Bullet[]).map((b, i) => (
                <BulletItem key={i} b={b} />
              ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}

function BulletItem({ b }: { b: Bullet }) {
  return (
    <li className="text-sm leading-relaxed">
      <p>{b.text}</p>
      <details className="mt-1 text-xs text-neutral-500">
        <summary className="cursor-pointer select-none">
          {b.source}
          {b.verified ? " · quote verified" : " · ⚠ quote not found verbatim — check source"}
        </summary>
        <blockquote className="mt-1 border-l-2 border-neutral-300 pl-2 italic">“{b.evidence}”</blockquote>
      </details>
    </li>
  );
}
