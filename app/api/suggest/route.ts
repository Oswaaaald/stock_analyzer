// app/api/suggest/route.ts
export const runtime = "nodejs";

import { NextResponse } from "next/server";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";
const AL = "en-US,en;q=0.9";

// GET /api/suggest?q=apple
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const q = (searchParams.get("q") || "").trim();
  if (!q) return NextResponse.json({ suggestions: [] });

  try {
    const suggestions = await fetchYahooSuggestions(q);
    return NextResponse.json({ suggestions });
  } catch (e: any) {
    const msg = typeof e?.message === "string" ? e.message : "Suggest provider error";
    return NextResponse.json({ suggestions: [], error: msg }, { status: 200 });
  }
}

// POST /api/suggest  { q: "apple" }
export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const q = (body?.q || "").trim();
    if (!q) return NextResponse.json({ suggestions: [] });
    const suggestions = await fetchYahooSuggestions(q);
    return NextResponse.json({ suggestions });
  } catch (e: any) {
    const msg = typeof e?.message === "string" ? e.message : "Suggest provider error";
    return NextResponse.json({ suggestions: [], error: msg }, { status: 200 });
  }
}

type Suggest = {
  symbol: string;
  name?: string | null;
  exchange?: string | null;
  type?: string | null;       // 'EQUITY', 'ETF', ...
  score?: number | null;      // pertinence Yahoo
  region?: string | null;     // US, FR, ...
  currency?: string | null;
};

// ------------ Impl ------------
async function fetchYahooSuggestions(q: string): Promise<Suggest[]> {
  const params = new URLSearchParams({
    q,
    lang: "en-US",
    region: "US",
    quotesCount: "10",
    newsCount: "0",
  });

  const headers: Record<string, string> = {
    "User-Agent": UA,
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": AL,
    // pas de cookie requis
    Referer: "https://finance.yahoo.com/",
    Origin: "https://finance.yahoo.com",
  };

  const urls = [
    `https://query2.finance.yahoo.com/v1/finance/search?${params.toString()}`,
    `https://query1.finance.yahoo.com/v1/finance/search?${params.toString()}`,
  ];

  let js: any = null;
  for (const u of urls) {
    try {
      const r = await fetch(u, { headers });
      if (!r.ok) continue;
      js = await r.json();
      if (js?.quotes?.length) break;
    } catch {
      // on tente l'autre host
    }
  }

  const quotes: any[] = Array.isArray(js?.quotes) ? js.quotes : [];
  if (!quotes.length) return [];

  // Filtrage & mapping
  const out: Suggest[] = quotes
    .filter((it) => {
      // on garde surtout les actions et les trackers, pas les devises/crypto/options
      const qt = (it?.quoteType || "").toUpperCase();
      const sym = (it?.symbol || "").trim();
      return sym && ["EQUITY", "ETF", "MUTUALFUND", "INDEX"].includes(qt);
    })
    .map((it) => ({
      symbol: (it?.symbol || "").trim(),
      name: it?.shortname || it?.longname || it?.name || null,
      exchange: it?.exchDisp || it?.exch || null,
      type: it?.quoteType || null,
      score: typeof it?.score === "number" ? it.score : null,
      region: it?.region || null,
      currency: it?.currency || null,
    }))
    // tri basique : score desc, puis symbol match prefix
    .sort((a, b) => {
      const sa = a.score ?? -1;
      const sb = b.score ?? -1;
      if (sb !== sa) return sb - sa;
      const qa = a.symbol.toLowerCase().startsWith(q.toLowerCase()) ? 0 : 1;
      const qb = b.symbol.toLowerCase().startsWith(q.toLowerCase()) ? 0 : 1;
      return qa - qb;
    })
    // dédoublonne par symbol
    .filter((s, idx, arr) => arr.findIndex((x) => x.symbol === s.symbol) === idx)
    .slice(0, 10);

  return out;
}