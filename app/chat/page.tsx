"use client";

import { useEffect, useRef, useState } from "react";
import { BriefView, QuoteCard } from "@/app/components/cards";
import type { AgentEvent, ChatTurn } from "@/lib/agent";
import type { BriefResult } from "@/lib/brief";
import type { Company, FilingRef } from "@/lib/edgar";
import type { QuoteResult } from "@/app/components/cards";

type Item =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "error"; text: string }
  | { kind: "tool"; id: string; name: string; args: Record<string, unknown>; output?: unknown };

const EXAMPLES = [
  "Tell me what I should know about Apple for my 10am meeting",
  "What does Nvidia say about export restrictions?",
  "Show me Coca-Cola's recent SEC filings",
];

const STATUS: Record<string, (a: Record<string, unknown>) => string> = {
  resolve_company: (a) => `Looking up “${a.query}”`,
  get_stock_quote: (a) => `Fetching ${a.ticker} quote from Alpaca`,
  get_sec_filings: (a) => `Listing ${a.ticker} SEC filings`,
  summarize_10k: (a) => `Reading and summarizing ${a.ticker}'s latest 10-K`,
  search_filing: (a) => `Searching ${a.ticker}'s 10-K for “${a.query}”`,
};

export default function ChatPage() {
  const [items, setItems] = useState<Item[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => bottom.current?.scrollIntoView({ behavior: "smooth" }), [items]);

  async function send(text: string) {
    text = text.trim();
    if (!text || busy) return;
    const next: Item[] = [...items, { kind: "user", text }];
    setItems(next);
    setInput("");
    setBusy(true);

    // The server is stateless: send the text of the conversation so far. Tool results aren't
    // resent; the agent re-calls tools if needed (10-K summaries are cached server-side).
    const history = next.flatMap<ChatTurn>((i) =>
      i.kind === "user" || i.kind === "assistant" ? [{ role: i.kind, content: i.text }] : [],
    );

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: history }),
      });
      if (!res.ok || !res.body) throw new Error((await res.json().catch(() => null))?.error ?? "Request failed");

      // Read newline-delimited JSON events as they arrive.
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += value;
        const lines = buf.split("\n");
        buf = lines.pop()!;
        for (const line of lines) if (line.trim()) apply(JSON.parse(line) as AgentEvent);
      }
    } catch (e) {
      setItems((cur) => [...cur, { kind: "error", text: (e as Error).message }]);
    } finally {
      setBusy(false);
    }
  }

  function apply(e: AgentEvent) {
    setItems((cur) => {
      switch (e.type) {
        case "tool_start":
          return [...cur, { kind: "tool", id: e.id, name: e.name, args: e.args }];
        case "tool_result":
          return cur.map((i) => (i.kind === "tool" && i.id === e.id ? { ...i, output: e.output } : i));
        case "text":
          return [...cur, { kind: "assistant", text: e.text }];
        case "error":
          return [...cur, { kind: "error", text: e.message }];
      }
    });
  }

  return (
    <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col px-6 py-8 font-sans">
      <div className="flex-1 space-y-4 pb-6">
        {items.length === 0 && (
          <div className="py-10">
            <h1 className="text-2xl font-semibold tracking-tight">Ask about a company</h1>
            <p className="mb-6 text-sm text-neutral-600">
              The assistant looks up quotes and SEC filings with tools, then writes meeting-prep notes grounded in
              what it found.
            </p>
            <div className="flex flex-col items-start gap-2">
              {EXAMPLES.map((ex) => (
                <button
                  key={ex}
                  onClick={() => send(ex)}
                  className="rounded-full border border-neutral-300 bg-white px-4 py-1.5 text-left text-sm hover:border-neutral-800"
                >
                  {ex}
                </button>
              ))}
            </div>
          </div>
        )}

        {items.map((item, i) => (
          <ChatItem key={i} item={item} />
        ))}
        {busy && items.at(-1)?.kind !== "tool" && <p className="text-sm text-neutral-500">Thinking…</p>}
        <div ref={bottom} />
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          send(input);
        }}
        className="sticky bottom-0 flex gap-2 bg-[#f7f7f5] py-4"
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="e.g. What should I know about Microsoft before my 2pm?"
          aria-label="Message"
          className="flex-1 rounded-md border border-neutral-300 bg-white px-3 py-2 outline-none focus:border-neutral-800"
        />
        <button
          disabled={busy || !input.trim()}
          className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          Send
        </button>
      </form>
      <p className="pb-2 text-xs text-neutral-500">
        AI-generated from public SEC filings and IEX market data for internal research only. Not investment advice.
      </p>
    </main>
  );
}

function ChatItem({ item }: { item: Item }) {
  if (item.kind === "user")
    return (
      <div className="flex justify-end">
        <p className="max-w-[80%] rounded-lg bg-neutral-900 px-4 py-2 text-sm text-white">{item.text}</p>
      </div>
    );
  if (item.kind === "assistant")
    return (
      <div className="whitespace-pre-wrap rounded-lg border border-neutral-200 bg-white p-4 text-sm leading-relaxed">
        {item.text}
      </div>
    );
  if (item.kind === "error")
    return <p className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">{item.text}</p>;
  return <ToolItem item={item} />;
}

function ToolItem({ item }: { item: Extract<Item, { kind: "tool" }> }) {
  const label = STATUS[item.name]?.(item.args) ?? item.name;
  const out = item.output as Record<string, unknown> | undefined;

  if (!out)
    return (
      <p className="flex items-center gap-2 text-sm text-neutral-500">
        <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-neutral-400" />
        {label}…
      </p>
    );
  if ("error" in out && !("quote" in out))
    return <p className="text-sm text-amber-800">⚠ {label}: {String(out.error)}</p>;

  switch (item.name) {
    case "get_stock_quote":
      return <QuoteCard company={out.company as Company} quote={out.quote as QuoteResult} />;
    case "summarize_10k": {
      const r = out as BriefResult;
      return r.brief && r.filing ? (
        <BriefView brief={r.brief} filing={r.filing} sectionsFound={r.sectionsFound} />
      ) : (
        <p className="text-sm text-neutral-600">No 10-K found for {r.company.name}.</p>
      );
    }
    case "get_sec_filings":
      return (
        <details className="text-sm text-neutral-600">
          <summary className="cursor-pointer">✓ {label}</summary>
          <ul className="mt-2 space-y-1 pl-4">
            {(out.filings as FilingRef[]).map((f) => (
              <li key={f.accession}>
                <a href={f.url} target="_blank" rel="noreferrer" className="underline">
                  {f.form}
                </a>{" "}
                filed {f.filingDate}
                {f.reportDate && ` · period ${f.reportDate}`}
              </li>
            ))}
          </ul>
        </details>
      );
    case "search_filing": {
      const passages = (out.passages as { item: string; text: string }[]) ?? [];
      return (
        <details className="text-sm text-neutral-600">
          <summary className="cursor-pointer">
            ✓ {label}: {passages.length} passage{passages.length === 1 ? "" : "s"}
          </summary>
          <div className="mt-2 space-y-2">
            {passages.map((p, i) => (
              <blockquote key={i} className="border-l-2 border-neutral-300 pl-3 text-xs">
                <span className="font-medium">{p.item}</span> · {p.text.slice(0, 600)}
                {p.text.length > 600 && "…"}
              </blockquote>
            ))}
          </div>
        </details>
      );
    }
    case "resolve_company": {
      const top = (out.matches as Company[])?.[0];
      return (
        <p className="text-sm text-neutral-600">
          ✓ {label}: {top ? `${top.name} (${top.ticker})` : "no match"}
        </p>
      );
    }
    default:
      return <p className="text-sm text-neutral-600">✓ {label}</p>;
  }
}
