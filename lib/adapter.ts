// /lib/adapter.ts
import { DataBundle, Metrics } from "./types";

function trailingReturnFromSeries(
  series: { ts: number[]; closes: number[] } | undefined,
  days: number
): number | null {
  if (!series?.closes?.length) return null;
  const closes = series.closes;
  if (closes.length <= days) return null;
  const last = closes[closes.length - 1];
  const past = closes[closes.length - 1 - days];
  if (typeof last !== "number" || typeof past !== "number" || past <= 0) return null;
  return last / past - 1;
}

function rsi14FromCloses(closes: number[] | undefined): number | null {
  if (!closes || closes.length < 15) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i < 15; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gains += d; else losses -= d;
  }
  let avgG = gains / 14, avgL = losses / 14;
  for (let i = 15; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    const g = d > 0 ? d : 0;
    const l = d < 0 ? -d : 0;
    avgG = (avgG * 13 + g) / 14;
    avgL = (avgL * 13 + l) / 14;
  }
  if (avgL === 0) return 100;
  const rs = avgG / avgL;
  return 100 - 100 / (1 + rs);
}

/** Approx ROIC (décimal, ex: 0.25 = 25%) à partir de proxies quand Yahoo ne donne rien. */
function estimateRoicFromProxies(d: DataBundle): number | null {
  const f = d.fundamentals;
  const roe = f.roe?.value;                 // décimal (0.20 = 20%)
  const opm = f.op_margin?.value;           // décimal
  const conv = f.fcf_over_netincome?.value; // ~1 idéal
  const dte = f.debt_to_equity?.value;      // ratio

  // Besoin d'au moins ROE ou marge pour tenter quelque chose
  if ((roe == null || !isFinite(roe)) && (opm == null || !isFinite(opm))) {
    return null;
  }

  // Normalisations 0..1 (bornes larges et robustes)
  const lin = (v: number | null | undefined, a: number, b: number) => {
    if (v == null || !isFinite(v)) return 0;
    const lo = Math.min(a, b), hi = Math.max(a, b);
    const t = Math.max(0, Math.min(1, (v - lo) / (hi - lo)));
    return t;
  };

  const s_roe  = lin(roe, 0.08, 0.35);      // 8% → 35%
  const s_opm  = lin(opm, 0.08, 0.30);      // 8% → 30%
  const s_conv = lin(conv, 0.6, 1.2);       // 0.6 → 1.2

  // Score proxy 0..1
  const score01 = 0.6 * s_roe + 0.3 * s_opm + 0.1 * s_conv;

  // Map vers une plage plausible de ROIC (8%..45%)
  let roic_est = 0.08 + score01 * (0.45 - 0.08); // décimal

  // Pénalité simple du levier si très élevé
  if (dte != null && isFinite(dte) && dte > 1.5) {
    const penalty = Math.min(0.25, 0.05 * (dte - 1.5)); // jusqu'à -25 bps
    roic_est = Math.max(0, roic_est - penalty);
  }

  // Clamp final de sécurité
  roic_est = Math.max(0, Math.min(0.6, roic_est)); // 0%..60%

  return roic_est;
}

/**
 * Convertit un DataBundle (Yahoo v8/v10) en Metrics pour computePillars().
 * Couvre les 8 piliers quand les champs Fundamentals sont présents.
 */
export function bundleToMetrics(d: DataBundle): Metrics {
  const f = d.fundamentals;
  const p = d.prices;

  // Rendements “réels” dérivés de la série (prioritaires)
  const perf6mFromSeries  = trailingReturnFromSeries(p.series, 126); // ~6 mois boursiers
  const perf12mFromSeries = trailingReturnFromSeries(p.series, 252); // ~12 mois boursiers

  const m: Metrics = {};

  // --- Quality ---
  m.roe = f.roe?.value ?? null;
  // ✅ ROIC: valeur Yahoo si dispo, sinon fallback estimé
  m.roic = (f.roic?.value ?? null);
  if (m.roic == null || !isFinite(m.roic)) {
    const est = estimateRoicFromProxies(d);
    if (est != null && isFinite(est)) m.roic = est;
  }
  m.netMargin = f.op_margin.value ?? null;                 // proxy net margin
  m.fcfOverNetIncome = f.fcf_over_netincome?.value ?? null;
  m.marginStability = null;                                // à nourrir plus tard (séries pluriannuelles)

  // --- Safety ---
  m.currentRatio     = f.current_ratio.value ?? null;
  m.debtToEquity     = f.debt_to_equity?.value ?? null;
  m.netDebtToEbitda  = f.net_debt_to_ebitda?.value ?? null;
  m.interestCoverage = f.interest_coverage?.value ?? null;

  // --- Valuation ---
  m.fcfYield      = f.fcf_yield.value ?? null;
  m.earningsYield = f.earnings_yield.value ?? null;
  m.pe = typeof f.earnings_yield.value === "number" && f.earnings_yield.value > 0
    ? 1 / f.earnings_yield.value
    : null;
  m.evToEbitda = f.ev_to_ebitda?.value ?? null;

  // --- Growth ---
  m.forwardRevGrowth = f.rev_growth?.value ?? null;  // YoY proxy
  m.cagrEps3y = f.eps_growth?.value ?? null;         // YoY proxy pour 3y
  m.cagrRevenue3y = null;

  // --- Momentum ---
  m.perf6m  = perf6mFromSeries  ?? (p.ret_60d.value ?? null);
  m.perf12m = perf12mFromSeries ?? null;
  m.above200dma = (p.px_vs_200dma.value ?? 0) >= 0;
  m.rsi = rsi14FromCloses(p.series?.closes);

  // --- Moat (proxy unifié + placeholders) ---
  m.moatProxy = f.moat_proxy?.value ?? null;
  m.roicPersistence = null;
  m.grossMarginLevel = null;
  m.marketShareTrend = null;

  // --- ESG ---
  m.esgScore = f.esg_score?.value ?? null;
  m.controversiesLow =
    f.controversies_low?.value == null ? null : f.controversies_low.value > 0;

  // --- Governance ---
  m.payoutRatio      = f.payout_ratio?.value ?? null;
  m.dividendCagr3y   = f.dividend_cagr_3y?.value ?? null;
  m.buybackYield     = f.buyback_yield?.value ?? null;
  m.insiderOwnership = f.insider_ownership?.value ?? null;

  return m;
}