export const runtime = "nodejs";
import { NextResponse } from "next/server";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const q = (searchParams.get("q") || "").trim();
  if (!q) return NextResponse.json({ items: [] });

  const headers = {
    "User-Agent": "Mozilla/5.0 (compatible; StockAnalyzer/1.0)",
    "Accept": "application/json, text/plain, */*",
  };

  try {
    const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&lang=en-US&region=US&quotesCount=10`;
    const r = await fetch(url, { headers });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const js = await r.json();
    const items = (js?.quotes || [])
      .filter((x: any) => x.symbol && (x.quoteType === "EQUITY" || x.quoteType === "ETF"))
      .map((x: any) => ({
        symbol: x.symbol,          // ex: RACE, OR.PA, 7203.T, SHOP.TO
        shortname: x.shortname || x.longname || "",
        exchDisp: x.exchDisp || x.exchange || "",
      }));
    return NextResponse.json({ items });
  } catch (e: any) {
    return NextResponse.json({ items: [], error: e?.message || "suggest error" }, { status: 200 });
  }
}
