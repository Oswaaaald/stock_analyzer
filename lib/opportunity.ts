// /lib/opportunity.ts
import { Fundamentals, OppPoint } from "./types";
import { clamp01, linMap } from "./utils";

export function buildOpportunitySeries(closes: number[], ts: number[], f: Fundamentals): OppPoint[] {
  const n = Math.min(closes.length, ts.length);
  if (n === 0) return [];

  // MM200
  const roll200: (number | null)[] = Array(n).fill(null);
  let runSum = 0;
  for (let i = 0; i < n; i++) {
    runSum += closes[i];
    if (i >= 200) runSum -= closes[i - 200];
    if (i >= 199) roll200[i] = runSum / 200;
  }

  // plus bas / hauts roulants 252
  const low252: number[] = Array(n).fill(NaN);
  const high252: number[] = Array(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    const start = Math.max(0, i - 251);
    const slice = closes.slice(start, i + 1);
    low252[i] = Math.min(...slice);
    high252[i] = Math.max(...slice);
  }

  const fcfy = typeof f.fcf_yield.value === "number" ? f.fcf_yield.value : null;
  const ey   = typeof f.earnings_yield.value === "number" ? f.earnings_yield.value : null;
  const valFrom = (y: number | null) =>
    y == null
      ? 0.0
      : y <= 0.00 ? 0.0
      : y <= 0.02 ? linMap(y, 0.00, 0.02) * 0.3
      : y <= 0.04 ? 0.3 + linMap(y, 0.02, 0.04) * 0.3
      : y <= 0.06 ? 0.6 + linMap(y, 0.04, 0.06) * 0.2
      :             0.8 + linMap(Math.min(y, 0.08), 0.06, 0.08) * 0.2;
  const valuationScore = fcfy != null ? valFrom(fcfy) : valFrom(ey);

  const qualityOk = typeof f.op_margin.value === "number" ? linMap(f.op_margin.value, 0.05, 0.25) : 0.5;
  const safetyOk = (() => {
    const cr = typeof f.current_ratio.value === "number" ? f.current_ratio.value : null;
    const nc = typeof f.net_cash.value === "number" ? f.net_cash.value : null;
    const crScore = cr == null ? 0.5 : cr >= 1.5 ? 1 : cr >= 1 ? 0.6 : 0.2;
    const ncScore = nc == null ? 0.5 : nc > 0 ? 1 : 0.3;
    return crScore * 0.6 + ncScore * 0.4;
  })();

  const W = { pricePct: 0.4, valuation: 0.4, momentum: 0.15, quality: 0.05 };

  const hotPenalty = (pct: number) => (pct >= 0.95 ? 0.25 : pct >= 0.9 ? 0.5 : pct >= 0.85 ? 0.75 : 1.0);
  const coldBoost  = (pct: number) => (pct <= 0.05 ? 1.15 : pct <= 0.1 ? 1.1 : pct <= 0.2 ? 1.05 : 1.0);

  const out: OppPoint[] = [];
  for (let i = 0; i < n; i++) {
    const px = closes[i];
    const ma = roll200[i];
    const dist200 = ma && ma > 0 ? (px - ma) / ma : 0;
    const momScore = 1 - linMap(dist200, -0.2, +0.1); // sous MM200 → plus vert

    const lo = low252[i], hi = high252[i];
    const pct52w = Number.isFinite(lo) && Number.isFinite(hi) && hi > lo ? (px - lo) / (hi - lo) : 0.5;
    const pctPrice = 1 - clamp01(pct52w); // bas du range → 1

    const qualScore = (qualityOk + safetyOk) / 2;

    let opp01 =
      W.pricePct * pctPrice +
      W.valuation * valuationScore +
      W.momentum * momScore +
      W.quality * qualScore;

    opp01 *= hotPenalty(pct52w);
    opp01 *= coldBoost(pct52w);
    opp01 = Math.pow(clamp01(opp01), 0.95);

    out.push({ t: ts[i], close: px, opp: Math.round(opp01 * 100) });
  }
  return out;
}