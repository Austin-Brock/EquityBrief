// The agent loop, written by hand on OpenAI tool calling (no agent framework):
// ask the model -> run any tools it requests -> feed results back -> repeat until it answers.
import OpenAI from "openai";
import { runTool, TOOLS } from "./tools";

type Msg = OpenAI.Chat.Completions.ChatCompletionMessageParam;
export type ChatTurn = { role: "user" | "assistant"; content: string };

export type AgentEvent =
  | { type: "tool_start"; id: string; name: string; args: Record<string, unknown> }
  | { type: "tool_result"; id: string; name: string; output: unknown }
  | { type: "text"; text: string }
  | { type: "error"; message: string };

const MAX_STEPS = 6;

const system = () => `You are EquityBrief, a research assistant for wealth-management advisors preparing for client meetings. Today is ${new Date().toDateString()}.

How to work:
- If the user names a company rather than giving an exact ticker, call resolve_company first. If several matches are plausible and the top one is not clearly right, ask which they mean.
- For "what should I know" / meeting prep: call get_stock_quote and summarize_10k (in the same turn, in parallel).
- For specific questions about the business, risks or results, use search_filing, and summarize_10k if you haven't already.
- The user automatically sees quote cards and 10-K brief cards for those tool results, so don't repeat them in full. Write a short meeting-prep note instead: 3-5 talking points and 2-3 questions the client may ask, each grounded in the tool results. Cite the 10-K Item in parentheses, e.g. (Item 7).

Rules:
- Use only facts and figures from tool results. Never fill gaps with outside knowledge; if a tool failed or data is missing, say what's unavailable.
- Be neutral and factual. No investment advice, ratings, price targets, or buy/sell/hold language.
- Quote data comes from Alpaca's IEX feed and may differ slightly from consolidated prices.
- Format: plain text with short paragraphs and "- " bullets. No markdown headings, bold, or tables.`;

export async function runAgent(history: ChatTurn[], emit: (e: AgentEvent) => void): Promise<void> {
  const openai = new OpenAI();
  const messages: Msg[] = [{ role: "system", content: system() }, ...history];

  for (let step = 0; step < MAX_STEPS; step++) {
    const res = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL ?? "gpt-4.1-mini",
      messages,
      tools: TOOLS,
      parallel_tool_calls: true,
    });
    const msg = res.choices[0].message;
    messages.push(msg);

    const calls = (msg.tool_calls ?? []).filter((c) => c.type === "function");
    if (calls.length === 0) {
      emit({ type: "text", text: msg.content ?? "" });
      return;
    }

    // Run every requested tool in parallel, stream progress to the UI, and hand results back to the model.
    const results = await Promise.all(
      calls.map(async (call): Promise<Msg> => {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(call.function.arguments || "{}");
        } catch {
          /* model sent malformed JSON; tool will report the missing args */
        }
        emit({ type: "tool_start", id: call.id, name: call.function.name, args });
        const output = await runTool(call.function.name, args);
        emit({ type: "tool_result", id: call.id, name: call.function.name, output });
        return { role: "tool", tool_call_id: call.id, content: JSON.stringify(output) };
      }),
    );
    messages.push(...results);
  }

  emit({ type: "text", text: "I stopped after several research steps without finishing. Try a more specific question." });
}
