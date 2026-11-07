import { NextRequest } from "next/server";
import { getQuote } from "@/lib/alpaca";
import { getBrief, NotFoundError } from "@/lib/brief";

export const maxDuration = 120;

export async function GET(req: NextRequest) {
  const ticker = (req.nextUrl.searchParams.get("ticker") ?? "").trim().toUpperCase();
  if (!/^[A-Z][A-Z.\-]{0,9}$/.test(ticker)) {
    return Response.json({ error: "Enter a valid ticker symbol." }, { status: 400 });
  }

  try {
    // Quote and filing work are independent; a quote failure shouldn't kill the brief.
    const quoteP = getQuote(ticker).catch((e: Error) => ({ error: e.message }));
    const result = await getBrief(ticker);
    return Response.json({ ...result, quote: await quoteP });
  } catch (e) {
    if (e instanceof NotFoundError) return Response.json({ error: e.message }, { status: 404 });
    console.error(e);
    return Response.json({ error: (e as Error).message }, { status: 502 });
  }
}
