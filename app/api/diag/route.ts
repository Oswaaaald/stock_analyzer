// app/api/diag/route.ts
export const runtime = "nodejs";
import { NextResponse } from "next/server";

const UA = { "User-Agent": "Mozilla/5.0 (compatible; StockAnalyzer/1.0)", "Accept": "application/json, text/plain, */*" };

async function fetchJson(url: string, headers?: Record<string, string>) {
  try {
    const r = await fetch(url, { headers });
    const text = await r.text(); // on lit le texte pour voir si ce n'est pas du HTML d'erreur
    let json: any = null;
    try { json = JSON.parse(text); } catch {}
    return { ok: r.ok, status: r.status, len: text.length, json, hint: text.slice(0, 120) };
  } catch (e: any) {
    return { ok: false, status: 0, len: 0, json: null, hint: String(e?.message || e) };
  }
}

async function fetchText(url: string, accept = "text/html") {
  try {
    const r = await fetch(url, { headers: { ...UA, Accept: accept } });
    const t = await r.text();
    return { ok: r.ok, status: r.status, len: t.length, hasRootApp: /root\.App\.main/.test(t) };
  } catch (e: any) {
    return { ok: false, status: 0, len: 0, hasRootApp: false, hint: String(e?.message || e) };
  }
}

export async function GET(req: Request) {
  const u = new URL(req.url);
  const t = u.searchParams.get("symbol") || "AAPL";

  const out: any = { symbol: t, when: new Date().toISOString() };

  // Yahoo v8 chart (prix)
  out.v8 = await fetchJson(`https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(t)}?range=2y&interval=1d`, UA);

  // Yahoo v7 quote
  out.v7 = await fetchJson(`https://query2.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(t)}&lang=en-US&region=US&corsDomain=finance.yahoo.com`, UA);

  // Yahoo quoteSummary
  out.summary = await fetchJson(`https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(t)}?modules=financialData,defaultKeyStatistics,price,summaryDetail&lang=en-US&region=US&corsDomain=finance.yahoo.com`, UA);

  // Yahoo fundamentals-timeseries (3 variantes)
  out.ftsA = await fetchJson(`https://query2.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/${encodeURIComponent(t)}?type=trailingPeTTM,priceToFreeCashFlowTTM,priceToBook&padTimeSeries=true&lang=en-US&region=US&corsDomain=finance.yahoo.com`, UA);
  out.ftsB = await fetchJson(`https://query2.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/${encodeURIComponent(t)}?types=trailingPeTTM,priceToFreeCashFlowTTM,priceToBook&padTimeSeries=true&lang=en-US&region=US&corsDomain=finance.yahoo.com`, UA);
  out.ftsC = await fetchJson(`https://query2.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/${encodeURIComponent(t)}?type=trailingPeTTM&type=priceToFreeCashFlowTTM&type=priceToBook&padTimeSeries=true&lang=en-US&region=US&corsDomain=finance.yahoo.com`, UA);

  // Yahoo key statistics HTML (pour voir si la page est complète)
  out.keyStats = await fetchText(`https://finance.yahoo.com/quote/${encodeURIComponent(t)}/key-statistics`, "text/html");

  // Stooq prix CSV (fallback)
  const stooqCand = [t.toLowerCase(), t.toLowerCase().replace(/\./g, "-"), `${t.toLowerCase()}.us`];
  const stq: any[] = [];
  for (const sym of stooqCand) {
    const r = await fetch(`https://stooq.com/q/d/l/?s=${encodeURIComponent(sym)}&i=d`).then(x => x.text()).catch(()=>"");
    stq.push({ sym, ok: !!r && r.length > 50, len: r.length });
  }
  out.stooq = stq;

  return NextResponse.json(out, { headers: { "Cache-Control": "no-store" } });
}