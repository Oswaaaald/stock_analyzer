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

  // --- ROIC fallback (approximation si manquant) ---
  if (m.roic == null && m.roe != null && f.debt_to_equity?.value != null) {
    // Approximation économique : ROIC ≈ ROE / (1 + D/E)
    const de = f.debt_to_equity.value;
    if (typeof de === "number" && isFinite(de)) {
      m.roic = m.roe / (1 + de);
    }
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
  // Yahoo financialData.revenueGrowth / earningsGrowth (YoY) → proxies
  m.forwardRevGrowth = f.rev_growth?.value ?? null;
  m.cagrEps3y = f.eps_growth?.value ?? null;
  m.cagrRevenue3y = null; // restera null tant qu'on n'a pas une série revenue multi-années

  // --- Momentum ---
  m.perf6m  = perf6mFromSeries  ?? (p.ret_60d.value ?? null); // fallback 60j ≈ 3 mois
  m.perf12m = perf12mFromSeries ?? null;                      // 12m depuis série uniquement
  m.above200dma = (p.px_vs_200dma.value ?? 0) >= 0;
  m.rsi = rsi14FromCloses(p.series?.closes);                 // RSI(14) depuis la série des prix

  // --- Moat (proxy unifié + placeholders) ---
  m.moatProxy = f.moat_proxy?.value ?? null; // ✅ nouveau proxy (0..1 si dispo)
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