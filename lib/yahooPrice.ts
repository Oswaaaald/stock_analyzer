// /lib/yahooPrice.ts
import { asMetric } from "./utils";
import { Prices } from "./types";
import { UA, AL } from "./yahooSession";
import { fetchJsonSafe } from "./utils";

export async function fetchYahooChartAndEnrich(ticker: string): Promise<Prices> {
  const urls = [
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=2y&interval=1d`,
    `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=2y&interval=1d`,
  ];
  let js: any = null;
  for (const u of urls) {
    js = await fetchJsonSafe(u, {
      "User-Agent": UA,
      "Accept": "application/json, text/plain, */*",
      "Accept-Language": AL,
    });
    if (js?.chart?.result?.[0]) break;
  }
  const r = js?.chart?.result?.[0];
  if (!r) throw new Error("Aucune donnée de prix (v8)");

  const tsRaw: number[] = (r.timestamp || []).map((t: number) => t * 1000);
  const closesRaw: number[] =
    ((r.indicators?.quote?.[0]?.close || r.indicators?.adjclose?.[0]?.adjclose) || []) as number[];
  const ts: number[] = [];
  const closes: number[] = [];
  for (let i = 0; i < Math.min(tsRaw.length, closesRaw.length); i++) {
    const v = closesRaw[i];
    if (typeof v === "number" && Number.isFinite(v)) {
      ts.push(tsRaw[i]);
      closes.push(v);
    }
  }
  if (!closes.length) throw new Error("Clôtures vides (v8)");

  const enriched = enrichCloses(closes);
  return {
    px: asMetric(enriched.px, confFromPts(closes.length), "yahoo"),
    px_vs_200dma: asMetric(enriched.px_vs_200dma, confFromPts(closes.length), "yahoo"),
    pct_52w: asMetric(enriched.pct_52w, confFromPts(closes.length), "yahoo"),
    max_dd_1y: asMetric(enriched.max_dd_1y, confFromPts(closes.length), "yahoo"),
    ret_20d: asMetric(enriched.ret_20d, confFromPts(closes.length), "yahoo"),
    ret_60d: asMetric(enriched.ret_60d, confFromPts(closes.length), "yahoo"),
    meta: {
      source_primary: "yahoo",
      points: closes.length,
      recency_days: Math.round((Date.now() - (ts.at(-1) ?? Date.now())) / (1000 * 3600 * 24)),
    },
    series: { ts, closes },
  };
}

function enrichCloses(closes: number[]) {
  const last = closes.at(-1) ?? null;
  let px_vs_200dma: number | null = null;
  if (closes.length >= 200 && typeof last === "number") {
    const avg = closes.slice(-200).reduce((a, b) => a + b, 0) / 200;
    if (avg > 0) px_vs_200dma = (last - avg) / avg;
  }
  const last252 = closes.slice(-252);
  let pct_52w: number | null = null, max_dd_1y: number | null = null;
  if (last252.length >= 30 && typeof last === "number") {
    const hi = Math.max(...last252), lo = Math.min(...last252);
    if (hi > lo) pct_52w = (last - lo) / (hi - lo);
    let peak = last252[0], mdd = 0;
    for (const c of last252) { peak = Math.max(peak, c); mdd = Math.min(mdd, (c - peak) / peak); }
    max_dd_1y = mdd;
  }
  let ret_20d: number | null = null, ret_60d: number | null = null;
  if (closes.length >= 21 && typeof last === "number") {
    const prev20 = closes[closes.length - 21]; if (prev20 > 0) ret_20d = last / prev20 - 1;
  }
  if (closes.length >= 61 && typeof last === "number") {
    const prev60 = closes[closes.length - 61]; if (prev60 > 0) ret_60d = last / prev60 - 1;
  }
  return { px: last, px_vs_200dma, pct_52w, max_dd_1y, ret_20d, ret_60d };
}

function confFromPts(pts: number) {
  if (pts >= 400) return 0.95;
  if (pts >= 250) return 0.85;
  if (pts >= 120) return 0.7;
  return 0.4;
}