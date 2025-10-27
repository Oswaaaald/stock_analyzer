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

/** Convertit un pourcentage "grand" en ratio (ex: 154.4 => 1.544). */
function percentishToRatio(v: number | null): number | null {
  if (v == null) return null;
  return v > 5 ? v / 100 : v;
}

/**
 * Extrait et calcule les fondamentaux Yahoo v10 dans un format unifié
 * (avec fallbacks robustes : D/E via totalLiab, interest coverage via operatingIncome,
 *  buyback yield approx depuis cashflow, ROIC neutralisé si invested ≤ 0, etc.)
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
  const debtToEquity_direct = num(r?.financialData?.debtToEquity?.raw ?? r?.financialData?.debtToEquity);

  // --- Croissance -----------------------------------------------------------
  const revGrowth = num(r?.financialData?.revenueGrowth?.raw ?? r?.financialData?.revenueGrowth);
  const epsGrowth = num(r?.financialData?.earningsGrowth?.raw ?? r?.financialData?.earningsGrowth);

  // --- États financiers pour ratios avancés --------------------------------
  const ishs: any[] = r?.incomeStatementHistory?.incomeStatementHistory || [];
  const bsh:  any[] = r?.balanceSheetHistory?.balanceSheetStatements || [];
  const cfsh: any[] = r?.cashflowStatementHistory?.cashflowStatements || [];

  const ni0          = num(ishs?.[0]?.netIncome?.raw ?? ishs?.[0]?.netIncome);
  const opInc0       = num(ishs?.[0]?.operatingIncome?.raw ?? ishs?.[0]?.operatingIncome);
  const interestExp  = num(ishs?.[0]?.interestExpense?.raw ?? ishs?.[0]?.interestExpense);
  const interestExpAlt = num(ishs?.[0]?.interestExpenseNonOperating?.raw ?? ishs?.[0]?.interestExpenseNonOperating);
  const preTax0      = num(ishs?.[0]?.incomeBeforeTax?.raw ?? ishs?.[0]?.incomeBeforeTax);
  const taxExp0      = num(ishs?.[0]?.incomeTaxExpense?.raw ?? ishs?.[0]?.incomeTaxExpense);

  const eq0          = num(bsh?.[0]?.totalStockholderEquity?.raw ?? bsh?.[0]?.totalStockholderEquity);
  const eq1          = num(bsh?.[1]?.totalStockholderEquity?.raw ?? bsh?.[1]?.totalStockholderEquity);
  const assets0      = num(bsh?.[0]?.totalAssets?.raw ?? bsh?.[0]?.totalAssets);
  const totalLiab0   = num(bsh?.[0]?.totalLiab?.raw ?? bsh?.[0]?.totalLiab); // fallback dette “large”

  // --- Market cap / Yields --------------------------------------------------
  const mc   = price && shares ? price * shares : null;
  const ey   = trailingPE && trailingPE > 0 ? 1 / trailingPE : null;
  const fcfy = mc && fcf != null ? clip(fcf / mc, -0.05, 0.08) : null; // clamp pr éviter outliers

  // --- EV & dérivés ---------------------------------------------------------
  const enterpriseValue = mc != null && debt != null && cash != null ? mc + debt - cash : null;
  const evToEbitda = ebitda && ebitda !== 0 && enterpriseValue != null ? enterpriseValue / ebitda : null;

  // --- Safety ratios (direct + fallbacks) ----------------------------------
  // D/E : on privilégie la valeur directe Yahoo. À défaut, fallback via totalLiab/Equity.
  const debtLike = debt != null ? debt : (totalLiab0 ?? null);
  const dToE_fallback =
    eq0 != null && eq0 !== 0 && debtLike != null ? debtLike / eq0 : null;

  // Yahoo renvoie souvent en % (ex: 154.4) -> normaliser
  const debtToEquity_final = percentishToRatio(
    debtToEquity_direct != null ? debtToEquity_direct : dToE_fallback
  );

  const netDebt = (debtLike != null && cash != null) ? (debtLike - cash) : null;
  const netDebtToEbitda =
    ebitda && ebitda !== 0 && netDebt != null ? netDebt / ebitda : null;

  // Interest coverage : fallback EBIT → operatingIncome ; si interest ≈ 0 ⇒ null (pas d’infini)
  const interest = (interestExp != null ? interestExp : interestExpAlt);
  const ebitOrOp = (ebit != null ? ebit : opInc0);
  const interestCoverage_fallback =
    (ebitOrOp != null && interest != null && interest !== 0)
      ? (ebitOrOp as number) / Math.abs(interest)
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

  // Capital investi : si ≤ 0 (net cash énorme…), on neutralise le ROIC pour éviter des artefacts
  const investedRaw =
    (debtLike ?? null) != null || (eq0 ?? null) != null ? ((debtLike ?? 0) + (eq0 ?? 0) - (cash ?? 0)) : null;

  let roic: number | null = null;
  if (nopat != null && investedRaw != null && investedRaw !== 0) {
    if (investedRaw > 0) roic = nopat / investedRaw;
    else roic = null; // neutralise cas invested ≤ 0
  }

  // --- Governance -----------------------------------------------------------
  const payoutRatio = num(r?.summaryDetail?.payoutRatio?.raw ?? r?.summaryDetail?.payoutRatio);
  const insiderOwnership = num(
    r?.defaultKeyStatistics?.heldPercentInsiders?.raw ?? r?.defaultKeyStatistics?.heldPercentInsiders
  );

  // --- ESG / controverses (placeholders) -----------------------------------
  const esgScore = null;
  const controversiesLow = null;

  // --- Buyback yield approx -------------------------------------------------
  // On cherche *une* clé repurchase*stock sur le dernier cashflow et approx le rendement
  const cfs0 = cfsh?.[0] ?? {};
  const repurchaseKeys = Object.keys(cfs0).filter(k => /repurchase.*stock/i.test(k));
  let repurchase: number | null = null;
  for (const k of repurchaseKeys) {
    const v = num((cfs0 as any)[k]?.raw ?? (cfs0 as any)[k]);
    if (typeof v === "number") { repurchase = v; break; }
  }
  let buybackYieldApprox: number | null = null;
  if (mc && typeof repurchase === "number" && repurchase < 0) {
    // sortie de cash → on utilise |repurchase| / market cap (clamp ± raisonnable)
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

    // Qualité
    roe:                asMetric(roe ?? null,               roe != null ? 0.45 : 0, roe_direct != null ? "yahoo-v10" : "calc"),
    roa:                asMetric(roa ?? null,               roa != null ? 0.4  : 0, roa_direct != null ? "yahoo-v10" : "calc"),
    fcf_over_netincome: asMetric(fcf_over_ni,               fcf_over_ni != null ? 0.35 : 0, "calc"),
    roic:               asMetric(roic,                      roic != null ? 0.3  : 0, "calc"),

    // Croissance
    rev_growth:  asMetric(revGrowth, revGrowth != null ? 0.4 : 0, "yahoo-v10"),
    eps_growth:  asMetric(epsGrowth, epsGrowth != null ? 0.4 : 0, "yahoo-v10"),

    // Safety (direct + fallback)
    debt_to_equity: asMetric(
      debtToEquity_final,
      debtToEquity_final != null ? (debtToEquity_direct != null ? 0.45 : 0.35) : 0,
      debtToEquity_direct != null ? "yahoo-v10" : "calc"
    ),
    net_debt_to_ebitda: asMetric(netDebtToEbitda,            netDebtToEbitda != null ? 0.35 : 0, "calc"),
    interest_coverage:  asMetric(interestCoverage_fallback,  interestCoverage_fallback != null ? 0.35 : 0, "calc"),

    // Valorisation
    ev_to_ebitda: asMetric(evToEbitda, evToEbitda != null ? 0.35 : 0, "calc"),

    // Gouvernance
    payout_ratio:      asMetric(payoutRatio,        payoutRatio != null ? 0.3 : 0, "yahoo-v10"),
    dividend_cagr_3y:  asMetric(null,               0, "none"),
    buyback_yield:     asMetric(buybackYieldApprox, buybackYieldApprox != null ? 0.25 : 0, "calc"),
    insider_ownership: asMetric(insiderOwnership,   insiderOwnership != null ? 0.3 : 0, "yahoo-v10"),

    // ESG
    esg_score:         asMetric(esgScore,         0, "none"),
    controversies_low: asMetric(controversiesLow, 0, "none"),
  };
}