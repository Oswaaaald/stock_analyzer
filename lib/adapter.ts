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
  m.roic = f.roic?.value ?? null;
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
  // Yahoo financialData.revenueGrowth / earningsGrowth (YoY) → proxies
  m.forwardRevGrowth = f.rev_growth?.value ?? null;
  m.cagrEps3y = f.eps_growth?.value ?? null;
  m.cagrRevenue3y = null; // calculable plus tard avec historiques

  // --- Momentum ---
  m.perf6m  = perf6mFromSeries  ?? (p.ret_60d.value ?? null); // fallback 60j ≈ 3 mois
  m.perf12m = perf12mFromSeries ?? null;                      // 12m depuis série uniquement
  m.above200dma = (p.px_vs_200dma.value ?? 0) >= 0;
  m.rsi = null; // non disponible pour l’instant

  // --- Moat (placeholders) ---
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