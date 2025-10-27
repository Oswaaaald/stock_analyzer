// /lib/yahooV10.ts
import { Fundamentals } from "./types";
import { asMetric, num, clip } from "./utils";
import { UA, AL, YSession, getYahooSession } from "./yahooSession";

/**
 * Récupère le module Yahoo Finance v10 (quoteSummary) et gère le refresh de cookie/crumb
 */
export async function fetchYahooV10(ticker: string, sess: YSession, retryOnce: boolean): Promise<any> {
  const base = {
    "User-Agent": UA,
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": AL,
    Origin: "https://finance.yahoo.com",
    Referer: "https://finance.yahoo.com/",
    ...(sess.cookie ? ({ Cookie: sess.cookie } as any) : {}),
  };
  const crumbQS = sess.crumb ? `&crumb=${encodeURIComponent(sess.crumb)}` : "";
  const modules =
    "financialData,defaultKeyStatistics,price,summaryDetail,defaultKeyStatistics,quoteType,incomeStatementHistory,balanceSheetHistory,cashflowStatementHistory";
  const urls = [
    `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(
      ticker
    )}?modules=${modules}${crumbQS}`,
    `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(
      ticker
    )}?modules=${modules}${crumbQS}`,
  ];

  for (const u of urls) {
    const res = await fetch(u, { headers: base });
    if (res.status === 401 && retryOnce) {
      const s2 = await getYahooSession();
      return fetchYahooV10(ticker, s2, /*retryOnce*/ false);
    }
    if (res.ok) {
      const js = await res.json();
      const r = js?.quoteSummary?.result?.[0];
      if (r) return r;
    }
  }
  throw new Error("QuoteSummary indisponible");
}

/**
 * Extrait et calcule les fondamentaux Yahoo v10 dans un format unifié
 * - D/E: priorité bilan (totalDebt / equity), fallback totalLiab / equity, fallback Yahoo financialData.debtToEquity (% → ratio)
 * - Interest coverage: ebit / |interestExpense|, fallback operatingIncome
 * - Buyback yield approx depuis cashflow (repurchaseOfCommonStock*)
 * - ROIC neutralisé si invested ≤ 0
 */
export function computeFundamentalsFromV10(r: any): Fundamentals {
  // --- Données brutes -------------------------------------------------------
  const price  = num(r?.price?.regularMarketPrice?.raw ?? r?.price?.regularMarketPrice);
  const shares = num(r?.defaultKeyStatistics?.sharesOutstanding?.raw ?? r?.defaultKeyStatistics?.sharesOutstanding);

  const trailingPE   = num(r?.summaryDetail?.trailingPE?.raw ?? r?.defaultKeyStatistics?.trailingPE?.raw);
  const priceToBook  = num(r?.defaultKeyStatistics?.priceToBook?.raw ?? r?.defaultKeyStatistics?.priceToBook);
  const currentRatio = num(r?.financialData?.currentRatio?.raw ?? r?.financialData?.currentRatio);
  const fcf          = num(r?.financialData?.freeCashflow?.raw ?? r?.financialData?.freeCashflow);
  const opm          = num(r?.financialData?.operatingMargins?.raw ?? r?.financialData?.operatingMargins);
  const cash         = num(r?.financialData?.totalCash?.raw ?? r?.financialData?.totalCash);
  const debt         = num(r?.financialData?.totalDebt?.raw ?? r?.financialData?.totalDebt);
  const ebitda       = num(r?.financialData?.ebitda?.raw ?? r?.financialData?.ebitda);
  const ebit         = num(r?.financialData?.ebit?.raw ?? r?.financialData?.ebit);

  // Yahoo fournit parfois debtToEquity en % (ex: 154.48 → 154.48%)
  const debtToEquityYahooPct = num(r?.financialData?.debtToEquity?.raw ?? r?.financialData?.debtToEquity);

  // --- Croissance -----------------------------------------------------------
  const revGrowth = num(r?.financialData?.revenueGrowth?.raw ?? r?.financialData?.revenueGrowth);
  const epsGrowth = num(r?.financialData?.earningsGrowth?.raw ?? r?.financialData?.earningsGrowth);

  // --- États financiers ------------------------------------------------------
  const ishs: any[] = r?.incomeStatementHistory?.incomeStatementHistory || [];
  const bsh:  any[] = r?.balanceSheetHistory?.balanceSheetStatements || [];
  const cfsh: any[] = r?.cashflowStatementHistory?.cashflowStatements || [];

  const ni0          = num(ishs?.[0]?.netIncome?.raw ?? ishs?.[0]?.netIncome);
  const opInc0       = num(ishs?.[0]?.operatingIncome?.raw ?? ishs?.[0]?.operatingIncome);
  const interestExp  = num(ishs?.[0]?.interestExpense?.raw ?? ishs?.[0]?.interestExpense);
  const preTax0      = num(ishs?.[0]?.incomeBeforeTax?.raw ?? ishs?.[0]?.incomeBeforeTax);
  const taxExp0      = num(ishs?.[0]?.incomeTaxExpense?.raw ?? ishs?.[0]?.incomeTaxExpense);
  const eq0          = num(bsh?.[0]?.totalStockholderEquity?.raw ?? bsh?.[0]?.totalStockholderEquity);
  const eq1          = num(bsh?.[1]?.totalStockholderEquity?.raw ?? bsh?.[1]?.totalStockholderEquity);
  const assets0      = num(bsh?.[0]?.totalAssets?.raw ?? bsh?.[0]?.totalAssets);
  const totalLiab0   = num(bsh?.[0]?.totalLiab?.raw ?? bsh?.[0]?.totalLiab);

  // --- Market cap et yields -------------------------------------------------
  const mc   = price && shares ? price * shares : null;
  const ey   = trailingPE && trailingPE > 0 ? 1 / trailingPE : null;
  const fcfy = mc && fcf != null ? clip(fcf / mc, -0.05, 0.08) : null;

  // --- EV et dérivés --------------------------------------------------------
  const enterpriseValue = mc != null && debt != null && cash != null ? mc + debt - cash : null;
  const evToEbitda = ebitda && ebitda !== 0 && enterpriseValue != null ? enterpriseValue / ebitda : null;

  // --- Safety ratios (multi-fallbacks) -------------------------------------
  // 1) privilégier totalDebt, 2) sinon totalLiab, 3) sinon fallback Yahoo % si equity connu
  const debtLike = (debt != null) ? debt : (totalLiab0 ?? null);
  const d2e_bs   = (eq0 != null && eq0 !== 0 && debtLike != null) ? (debtLike / eq0) : null;
  const d2e_yh   = (debtToEquityYahooPct != null) ? (debtToEquityYahooPct / 100) : null;

  const debtToEquity_value = (d2e_bs != null) ? d2e_bs : (d2e_yh != null ? d2e_yh : null);
  const debtToEquity_src   = (d2e_bs != null) ? "calc" : ((d2e_yh != null) ? "yahoo-v10" : "calc");

  const netDebt = (debtLike != null && cash != null) ? (debtLike - cash) : null;

  const netDebtToEbitda =
    ebitda && ebitda !== 0 && netDebt != null ? netDebt / ebitda : null;

  // Interest coverage : fallback operatingIncome si ebit indispo
  const ebitOrOp = (ebit != null ? ebit : opInc0);
  const interestCoverage =
    (ebitOrOp != null && interestExp != null && interestExp !== 0)
      ? (ebitOrOp as number) / Math.abs(interestExp)
      : null;

  // --- Net cash proxy -------------------------------------------------------
  let netCash: number | null = null;
  if (cash != null && debtLike != null) {
    netCash = cash - debtLike > 0 ? 1 : 0;
  } else if (priceToBook && priceToBook > 0) {
    netCash = priceToBook < 1.2 ? 1 : 0;
  }

  // --- ROE / ROA / ROIC ----------------------------------------------------
  const roe_direct = num(r?.financialData?.returnOnEquity?.raw ?? r?.financialData?.returnOnEquity);
  const avgEq      = (eq0 != null && eq1 != null) ? (eq0 + eq1) / 2 : (eq0 ?? null);
  const roe_calc   = (ni0 != null && avgEq) ? (avgEq !== 0 ? ni0 / avgEq : null) : null;
  const roe        = roe_direct ?? roe_calc;

  const roa_direct = num(r?.financialData?.returnOnAssets?.raw ?? r?.financialData?.returnOnAssets);
  const roa        = roa_direct ?? ((ni0 != null && assets0) ? (assets0 !== 0 ? ni0 / assets0 : null) : null);

  const fcf_over_ni = (fcf != null && ni0 != null && ni0 !== 0) ? fcf / ni0 : null;
  const taxRate =
    preTax0 && taxExp0 != null && preTax0 !== 0 ? Math.min(0.5, Math.max(0, taxExp0 / preTax0)) : 0.21;

  const nopat = opInc0 != null ? opInc0 * (1 - taxRate) : (ni0 != null ? ni0 : null);

  // Invested: neutralise si ≤ 0
  const investedRaw =
    (debtLike ?? null) != null || (eq0 ?? null) != null ? ((debtLike ?? 0) + (eq0 ?? 0) - (cash ?? 0)) : null;

  let roic: number | null = null;
  if (nopat != null && investedRaw != null && investedRaw !== 0) {
    roic = investedRaw > 0 ? (nopat / investedRaw) : null;
  }

  // --- Governance -----------------------------------------------------------
  const payoutRatio      = num(r?.summaryDetail?.payoutRatio?.raw ?? r?.summaryDetail?.payoutRatio);
  const insiderOwnership = num(
    r?.defaultKeyStatistics?.heldPercentInsiders?.raw ?? r?.defaultKeyStatistics?.heldPercentInsiders
  );

  // --- ESG placeholders -----------------------------------------------------
  const esgScore         = null;
  const controversiesLow = null;

  // --- Buyback yield approx (repurchaseOfCommonStock*) ----------------------
  const cfs0 = cfsh?.[0] ?? {};
  const repurchaseKeys = Object.keys(cfs0).filter(k => /repurchase.*stock/i.test(k));
  let repurchase: number | null = null;
  for (const k of repurchaseKeys) {
    const v = num((cfs0 as any)[k]?.raw ?? (cfs0 as any)[k]);
    if (typeof v === "number") { repurchase = v; break; }
  }
  // v < 0 (sortie de cash) → approx |v| / market cap, clamp pour éviter outliers
  let buybackYieldApprox: number | null = null;
  if (mc && typeof repurchase === "number" && repurchase < 0) {
    buybackYieldApprox = Math.min(0.10, Math.max(-0.12, Math.abs(repurchase) / mc));
  }

  // --- Construction finale --------------------------------------------------
  return {
    // Core
    op_margin:         asMetric(opm,          opm != null ? 0.45 : 0, "yahoo-v10"),
    current_ratio:     asMetric(currentRatio, currentRatio != null ? 0.4 : 0, "yahoo-v10"),
    fcf_yield:         asMetric(fcfy,         fcfy != null ? 0.45 : 0, "yahoo-v10"),
    earnings_yield:    asMetric(ey,           ey != null ? 0.45 : 0, "yahoo-v10"),
    net_cash:          asMetric(netCash,      netCash != null ? 0.35 : 0, "yahoo-v10"),

    // Quality
    roe:                asMetric(roe ?? null,               roe != null ? 0.45 : 0, roe_direct != null ? "yahoo-v10" : "calc"),
    roa:                asMetric(roa ?? null,               roa != null ? 0.4  : 0, roa_direct != null ? "yahoo-v10" : "calc"),
    fcf_over_netincome: asMetric(fcf_over_ni,               fcf_over_ni != null ? 0.35 : 0, "calc"),
    roic:               asMetric(roic,                      roic != null ? 0.3  : 0, "calc"),

    // Growth
    rev_growth:  asMetric(revGrowth, revGrowth != null ? 0.4 : 0, "yahoo-v10"),
    eps_growth:  asMetric(epsGrowth, epsGrowth != null ? 0.4 : 0, "yahoo-v10"),

    // Safety
    debt_to_equity:     asMetric(debtToEquity_value, debtToEquity_value != null ? 0.35 : 0, debtToEquity_src),
    net_debt_to_ebitda: asMetric(netDebtToEbitda,    netDebtToEbitda    != null ? 0.35 : 0, "calc"),
    interest_coverage:  asMetric(interestCoverage,   interestCoverage   != null ? 0.35 : 0, "calc"),

    // Valuation
    ev_to_ebitda: asMetric(evToEbitda, evToEbitda != null ? 0.35 : 0, "calc"),

    // Governance
    payout_ratio:      asMetric(payoutRatio,      payoutRatio != null ? 0.3 : 0, "yahoo-v10"),
    dividend_cagr_3y:  asMetric(null,             0, "none"),
    buyback_yield:     asMetric(buybackYieldApprox, buybackYieldApprox != null ? 0.25 : 0, "calc"),
    insider_ownership: asMetric(insiderOwnership, insiderOwnership != null ? 0.3 : 0, "yahoo-v10"),

    // ESG
    esg_score:         asMetric(esgScore, 0, "none"),
    controversies_low: asMetric(controversiesLow, 0, "none"),
  };
}