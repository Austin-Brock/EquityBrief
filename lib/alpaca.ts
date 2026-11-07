// Alpaca Market Data v2 — snapshot gives latest trade/quote + daily bars in one call.
// Free accounts only get the IEX feed (~2-3% of US volume), so we label it in the UI.

export type Quote = {
  symbol: string;
  price: number;
  change: number | null;
  changePct: number | null;
  bid: number | null;
  ask: number | null;
  dayOpen: number | null;
  dayHigh: number | null;
  dayLow: number | null;
  volume: number | null;
  prevClose: number | null;
  asOf: string;
  feed: string;
};

export async function getQuote(symbol: string): Promise<Quote> {
  symbol = symbol.toUpperCase().replace(/-/g, "."); // SEC writes BRK-B; Alpaca expects BRK.B
  const key = process.env.ALPACA_API_KEY_ID;
  const secret = process.env.ALPACA_API_SECRET_KEY;
  if (!key || !secret) throw new Error("Alpaca credentials are not configured");
  const feed = process.env.ALPACA_DATA_FEED ?? "iex";

  const res = await fetch(
    `https://data.alpaca.markets/v2/stocks/${encodeURIComponent(symbol)}/snapshot?feed=${feed}`,
    {
      headers: { "APCA-API-KEY-ID": key, "APCA-API-SECRET-KEY": secret },
      cache: "no-store",
    },
  );
  if (!res.ok) throw new Error(`Alpaca ${res.status}: ${await res.text()}`);
  const s = await res.json();

  const price: number = s.latestTrade?.p ?? s.dailyBar?.c;
  const prevClose: number | null = s.prevDailyBar?.c ?? null;
  const change = prevClose != null ? price - prevClose : null;

  return {
    symbol,
    price,
    change,
    changePct: change != null && prevClose ? (change / prevClose) * 100 : null,
    bid: s.latestQuote?.bp || null, // IEX returns 0 when there is no standing bid/ask (e.g. market closed)
    ask: s.latestQuote?.ap || null,
    dayOpen: s.dailyBar?.o ?? null,
    dayHigh: s.dailyBar?.h ?? null,
    dayLow: s.dailyBar?.l ?? null,
    volume: s.dailyBar?.v ?? null,
    prevClose,
    asOf: s.latestTrade?.t ?? s.dailyBar?.t,
    feed: feed.toUpperCase(),
  };
}
