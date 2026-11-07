import { runAgent, type AgentEvent, type ChatTurn } from "@/lib/agent";

export const maxDuration = 120;

// Streams newline-delimited JSON events (see AgentEvent) so the UI can show tool progress live.
export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const history: ChatTurn[] = Array.isArray(body?.messages)
    ? body.messages
        .filter(
          (m: ChatTurn) => (m?.role === "user" || m?.role === "assistant") && typeof m.content === "string",
        )
        .slice(-20)
        .map((m: ChatTurn) => ({ role: m.role, content: m.content.slice(0, 4000) }))
    : [];
  if (history.at(-1)?.role !== "user") {
    return Response.json({ error: "Expected messages ending with a user message." }, { status: 400 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const emit = (e: AgentEvent) => {
        try {
          controller.enqueue(encoder.encode(JSON.stringify(e) + "\n"));
        } catch {
          /* client disconnected */
        }
      };
      try {
        await runAgent(history, emit, { debug: body?.debug === true });
      } catch (e) {
        console.error(e);
        emit({ type: "error", message: (e as Error).message });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-cache" },
  });
}
