// /lib/opportunity.ts
import { Fundamentals, OppPoint } from "./types";
import { clamp01, linMap } from "./utils";

/**
 * Construit la série d'opportunité (opp 0..100)
 * en combinant valorisation, momentum et fondamentaux.
 */
export function buildOpportunitySeries(
  closes: number[],
  ts: number[],
  f: Fundamentals
): OppPoint[] {
  const n = Math.min(closes.length, ts.length);
  if (n === 0) return [];

  // ---- Moyenne mobile 200 jours ----
  const roll200: (number | null)[] = Array(n).fill(null);
  let runSum = 0;
  for (let i = 0; i < n; i++) {
    runSum += closes[i];
    if (i >= 200) runSum -= closes[i - 200];
    if (i >= 199) roll200[i] = runSum / 200;
  }

  // ---- Plus bas/hauts roulants sur 252 jours ----
  const low252: number[] = Array(n).fill(NaN);
  const high252: number[] = Array(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    const start = Math.max(0, i - 251);
    const slice = closes.slice(start, i + 1);
    low252[i] = Math.min(...slice);
    high252[i] = Math.max(...slice);
  }

  // ---- Valorisation : FCF yield ou Earnings yield ----
  const fcfy = typeof f.fcf_yield.value === "number" ? f.fcf_yield.value : null;
  const ey = typeof f.earnings_yield.value === "number" ? f.earnings_yield.value : null;
  const valFrom = (y: number | null) =>
    y == null
      ? 0.0
      : y <= 0.00 ? 0.0
      : y <= 0.02 ? linMap(y, 0.00, 0.02) * 0.3
      : y <= 0.04 ? 0.3 + linMap(y, 0.02, 0.04) * 0.3
      : y <= 0.06 ? 0.6 + linMap(y, 0.04, 0.06) * 0.2
      : 0.8 + linMap(Math.min(y, 0.08), 0.06, 0.08) * 0.2;
  const valuationScore = fcfy != null ? valFrom(fcfy) : valFrom(ey);

  // ---- Qualité & sécurité simplifiées (cohérentes avec pillars.ts) ----
  const qualityScore = (() => {
    const opm = typeof f.op_margin.value === "number" ? f.op_margin.value : null;
    const fcf = typeof f.fcf_over_netincome?.value === "number" ? f.fcf_over_netincome.value : null;
    const q_opm = opm == null ? 0.5 : linMap(opm, 0.05, 0.25);
    const q_fcf = fcf == null ? 0.5 : linMap(fcf, 0.6, 1.2);
    return (q_opm * 0.6 + q_fcf * 0.4);
  })();

  const safetyScore = (() => {
    const cr = typeof f.current_ratio.value === "number" ? f.current_ratio.value : null;
    const nc = typeof f.net_cash.value === "number" ? f.net_cash.value : null;
    const s_cr = cr == null ? 0.5 : cr >= 1.5 ? 1 : cr >= 1 ? 0.7 : 0.3;
    const s_nc = nc == null ? 0.5 : nc > 0 ? 1 : 0.3;
    return (s_cr * 0.6 + s_nc * 0.4);
  })();

  // ---- Pondérations finales ----
  const W = { pricePct: 0.4, valuation: 0.35, momentum: 0.15, fundamentals: 0.1 };

  const hotPenalty = (pct: number) =>
    pct >= 0.95 ? 0.25 : pct >= 0.9 ? 0.5 : pct >= 0.85 ? 0.75 : 1.0;
  const coldBoost = (pct: number) =>
    pct <= 0.05 ? 1.15 : pct <= 0.1 ? 1.1 : pct <= 0.2 ? 1.05 : 1.0;

  // ---- Génération de la série ----
  const out: OppPoint[] = [];
  for (let i = 0; i < n; i++) {
    const px = closes[i];
    const ma = roll200[i];
    const dist200 = ma && ma > 0 ? (px - ma) / ma : 0;
    const momScore = 1 - linMap(dist200, -0.2, +0.1); // sous MM200 → plus vert

    const lo = low252[i],
      hi = high252[i];
    const pct52w =
      Number.isFinite(lo) && Number.isFinite(hi) && hi > lo
        ? (px - lo) / (hi - lo)
        : 0.5;
    const pctPrice = 1 - clamp01(pct52w); // bas du range → 1

    const fundaScore = (qualityScore + safetyScore) / 2;

    let opp01 =
      W.pricePct * pctPrice +
      W.valuation * valuationScore +
      W.momentum * momScore +
      W.fundamentals * fundaScore;

    opp01 *= hotPenalty(pct52w);
    opp01 *= coldBoost(pct52w);
    opp01 = Math.pow(clamp01(opp01), 0.95);

    out.push({ t: ts[i], close: px, opp: Math.round(opp01 * 100) });
  }

  return out;
}