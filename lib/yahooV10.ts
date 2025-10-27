// /lib/yahooV10.ts
import { Fundamentals } from "./types";
import { asMetric, num, clip } from "./utils";
import { UA, AL, YSession, getYahooSession } from "./yahooSession";

/** --- Helpers robustes --------------------------------------------------- */
function n(v: any): number | null {
  return num(v);
}

function isFiniteNum(x: any): x is number {
  return typeof x === "number" && Number.isFinite(x);
}

/**
 * Yahoo mélange souvent ratio décimal (0.15) et pourcentage (15 ou 150).
 * - Si |v| > 5 on considère que c’est un % (ex: 154.48 pour 154.48%) → v/100.
 * - Si v ∈ [-5; 5], on considère que c’est déjà un ratio décimal.
 * - On cappe ensuite dans un intervalle raisonnable.
 */
function toRatio(v: number | null, capMin = -5, capMax = 5): number | null {
  if (!isFiniteNum(v)) {
    return null;
  }
  let r = v;
  if (Math.abs(r) > 5) {
    r = r / 100.0;
  }
  if (!Number.isFinite(r)) {
    return null;
  }
  if (r < capMin) {
    r = capMin;
  }
  if (r > capMax) {
    r = capMax;
  }
  return r;
}

/** Assure qu’on ne divise jamais par 0, et qu’on ne produit pas d’infini/NaN */
function safeDiv(a: number | null, b: number | null): number | null {
  if (!isFiniteNum(a) || !isFiniteNum(b) || b === 0) {
    return null;
  }
  const v = a / b;
  return Number.isFinite(v) ? v : null;
}

/** Vérifie rapidement si un objet ressemble au “cashflow statement” Yahoo */
function getRepurchaseFromCashflow(cfs0: any): number | null {
  if (!cfs0 || typeof cfs0 !== "object") {
    return null;
  }
  const keys = Object.keys(cfs0);
  const repurchaseKey = keys.find((k) => /repurchase.*stock/i.test(k));
  if (!repurchaseKey) {
    return null;
  }
  const raw = cfs0?.[repurchaseKey]?.raw ?? cfs0?.[repurchaseKey];
  const v = n(raw);
  return isFiniteNum(v) ? v : null;
}

/** --- Fetch Yahoo v10 ---------------------------------------------------- */
export async function fetchYahooV10(ticker: string, sess: YSession, retryOnce: boolean): Promise<any> {
  const base = {
    "User-Agent": UA,
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": AL,
    Origin: "https://finance.yahoo.com",
    Referer: "https://finance.yahoo.com/",
    ...(sess.cookie ? ({ Cookie: sess.cookie } as any) : {}),
  };

  // Modules utiles uniquement (on évite d’alourdir/parasiter)
  const modules =
    "financialData,defaultKeyStatistics,price,summaryDetail,quoteType,incomeStatementHistory,balanceSheetHistory,cashflowStatementHistory";

  const crumbQS = sess.crumb ? `&crumb=${encodeURIComponent(sess.crumb)}` : "";
  const urls = [
    `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(ticker)}?modules=${modules}${crumbQS}`,
    `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(ticker)}?modules=${modules}${crumbQS}`,
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
      if (r) {
        return r;
      }
    }
  }
  throw new Error("QuoteSummary indisponible");
}

/** --- Compute fondamentaux unifiés -------------------------------------- */
export function computeFundamentalsFromV10(r: any): Fundamentals {
  // --- Bruts (avec fallback .raw) -----------------------------------------
  const price = n(r?.price?.regularMarketPrice?.raw ?? r?.price?.regularMarketPrice);
  const shares = n(r?.defaultKeyStatistics?.sharesOutstanding?.raw ?? r?.defaultKeyStatistics?.sharesOutstanding);

  const trailingPE_raw = n(r?.summaryDetail?.trailingPE?.raw ?? r?.defaultKeyStatistics?.trailingPE?.raw);
  const priceToBook_raw = n(r?.defaultKeyStatistics?.priceToBook?.raw ?? r?.defaultKeyStatistics?.priceToBook);

  const currentRatio = n(r?.financialData?.currentRatio?.raw ?? r?.financialData?.currentRatio);
  const quickRatio = n(r?.financialData?.quickRatio?.raw ?? r?.financialData?.quickRatio); // non affiché mais utile pour debug
  const fcf = n(r?.financialData?.freeCashflow?.raw ?? r?.financialData?.freeCashflow);
  const opm_raw = n(r?.financialData?.operatingMargins?.raw ?? r?.financialData?.operatingMargins);
  const cash = n(r?.financialData?.totalCash?.raw ?? r?.financialData?.totalCash);
  const debt = n(r?.financialData?.totalDebt?.raw ?? r?.financialData?.totalDebt);
  const ebitda = n(r?.financialData?.ebitda?.raw ?? r?.financialData?.ebitda);
  const ebit = n(r?.financialData?.ebit?.raw ?? r?.financialData?.ebit);

  // D/E Yahoo souvent en “%” → normaliser en ratio
  const debtToEquity_direct = toRatio(n(r?.financialData?.debtToEquity?.raw ?? r?.financialData?.debtToEquity));

  // Croissance (souvent déjà en ratio décimal)
  const revGrowth = toRatio(n(r?.financialData?.revenueGrowth?.raw ?? r?.financialData?.revenueGrowth), -1, 1);
  const epsGrowth = toRatio(n(r?.financialData?.earningsGrowth?.raw ?? r?.financialData?.earningsGrowth), -1, 1);

  // États financiers
  const ishs: any[] = r?.incomeStatementHistory?.incomeStatementHistory || [];
  const bsh: any[] = r?.balanceSheetHistory?.balanceSheetStatements || [];
  const cfsh: any[] = r?.cashflowStatementHistory?.cashflowStatements || [];

  const is0 = ishs?.[0] || {};
  const bs0 = bsh?.[0] || {};
  const bs1 = bsh?.[1] || {};
  const cf0 = cfsh?.[0] || {};

  const ni0 = n(is0?.netIncome?.raw ?? is0?.netIncome);
  const opInc0 = n(is0?.operatingIncome?.raw ?? is0?.operatingIncome);
  // interestExpense chez Yahoo est souvent NEGATIF (sortie de cash) → on prendra abs() au besoin
  const interestExp = n(is0?.interestExpense?.raw ?? is0?.interestExpense);
  const preTax0 = n(is0?.incomeBeforeTax?.raw ?? is0?.incomeBeforeTax);
  const taxExp0 = n(is0?.incomeTaxExpense?.raw ?? is0?.incomeTaxExpense);

  const eq0 = n(bs0?.totalStockholderEquity?.raw ?? bs0?.totalStockholderEquity);
  const eq1 = n(bs1?.totalStockholderEquity?.raw ?? bs1?.totalStockholderEquity);
  const assets0 = n(bs0?.totalAssets?.raw ?? bs0?.totalAssets);
  const totalLiab0 = n(bs0?.totalLiab?.raw ?? bs0?.totalLiab);

  // --- Market cap / yields -------------------------------------------------
  const mc = isFiniteNum(price) && isFiniteNum(shares) ? price! * shares! : null;
  const trailingPE = isFiniteNum(trailingPE_raw) && trailingPE_raw! > 0 ? trailingPE_raw : null;
  const ey = isFiniteNum(trailingPE) && trailingPE! > 0 ? 1.0 / trailingPE! : null;

  // clamp FCF yield pour éviter outliers si données incomplètes
  const fcfy = isFiniteNum(mc) && isFiniteNum(fcf) ? clip(fcf! / mc!, -0.05, 0.08) : null;

  // --- EV & dérivés --------------------------------------------------------
  const enterpriseValue =
    isFiniteNum(mc) && isFiniteNum(debt) && isFiniteNum(cash) ? mc! + debt! - cash! : null;
  const evToEbitda =
    isFiniteNum(enterpriseValue) && isFiniteNum(ebitda) && ebitda! !== 0
      ? clip(enterpriseValue! / ebitda!, -100, 200)
      : null;

  // --- Safety --------------------------------------------------------------
  // D/E : direct (normalisé) OU fallback via totalLiab/Equity si besoin
  const debtLike = isFiniteNum(debt) ? debt : totalLiab0; // totalLiab ≈ dette “large” fallback
  const dToE_fallback =
    isFiniteNum(debtLike) && isFiniteNum(eq0) && eq0! !== 0 ? debtLike! / eq0! : null;
  const debtToEquity_final = isFiniteNum(debtToEquity_direct) ? debtToEquity_direct : dToE_fallback;

  const netDebt = isFiniteNum(debtLike) && isFiniteNum(cash) ? debtLike! - cash! : null;
  const netDebtToEbitda =
    isFiniteNum(netDebt) && isFiniteNum(ebitda) && ebitda! !== 0
      ? clip(netDebt! / ebitda!, -50, 50)
      : null;

  // Interest coverage: EBIT (fallback opInc) / |interestExp|
  const ebitOrOp = isFiniteNum(ebit) ? ebit : opInc0;
  const interestCoverage_fallback =
    isFiniteNum(ebitOrOp) && isFiniteNum(interestExp) && Math.abs(interestExp!) > 1e-9
      ? clip((ebitOrOp as number) / Math.abs(interestExp!), -200, 200)
      : null;

  // --- Net cash proxy ------------------------------------------------------
  let netCash: number | null = null;
  if (isFiniteNum(cash) && isFiniteNum(debtLike)) {
    netCash = cash! - debtLike! > 0 ? 1 : 0;
  } else if (isFiniteNum(priceToBook_raw) && priceToBook_raw! > 0) {
    netCash = priceToBook_raw! < 1.2 ? 1 : 0;
  }

  // --- ROE / ROA / ROIC ----------------------------------------------------
  const roe_direct = toRatio(n(r?.financialData?.returnOnEquity?.raw ?? r?.financialData?.returnOnEquity), -10, 10);
  const avgEq = isFiniteNum(eq0) && isFiniteNum(eq1) ? (eq0! + eq1!) / 2 : eq0;
  const roe_calc = isFiniteNum(ni0) && isFiniteNum(avgEq) && avgEq! !== 0 ? ni0! / avgEq! : null;
  const roe = isFiniteNum(roe_direct) ? roe_direct : roe_calc;

  const roa_direct = toRatio(n(r?.financialData?.returnOnAssets?.raw ?? r?.financialData?.returnOnAssets), -10, 10);
  const roa =
    isFiniteNum(roa_direct)
      ? roa_direct
      : isFiniteNum(ni0) && isFiniteNum(assets0) && assets0! !== 0
        ? ni0! / assets0!
        : null;

  const fcf_over_ni = isFiniteNum(fcf) && isFiniteNum(ni0) && ni0! !== 0 ? clip(fcf! / ni0!, -10, 10) : null;

  const taxRate = isFiniteNum(preTax0) && isFiniteNum(taxExp0) && preTax0! !== 0
    ? Math.min(0.5, Math.max(0, (taxExp0 as number) / (preTax0 as number)))
    : 0.21;
  const nopat = isFiniteNum(opInc0) ? (opInc0 as number) * (1 - taxRate) : (isFiniteNum(ni0) ? ni0 : null);

  // Capital investi: debtLike + equity - cash ; si ≤ 0 → neutralise ROIC (évite artefacts)
  const investedRaw =
    (isFiniteNum(debtLike) ? (debtLike as number) : 0) +
    (isFiniteNum(eq0) ? (eq0 as number) : 0) -
    (isFiniteNum(cash) ? (cash as number) : 0);

  let roic: number | null = null;
  if (isFiniteNum(nopat) && isFiniteNum(investedRaw) && investedRaw !== 0) {
    if (investedRaw > 0) {
      roic = clip((nopat as number) / investedRaw, -10, 10);
    } else {
      roic = null;
    }
  }

  // --- Governance ----------------------------------------------------------
  const payoutRatio_raw = n(r?.summaryDetail?.payoutRatio?.raw ?? r?.summaryDetail?.payoutRatio);
  const payoutRatio = toRatio(payoutRatio_raw, 0, 2); // 0..200%
  const insiderOwnership_raw = n(r?.defaultKeyStatistics?.heldPercentInsiders?.raw ?? r?.defaultKeyStatistics?.heldPercentInsiders);
  const insiderOwnership = toRatio(insiderOwnership_raw, 0, 1);

  // --- ESG placeholders ----------------------------------------------------
  const esgScore = null;
  const controversiesLow = null;

  // --- Buyback yield approx ------------------------------------------------
  const repurchase = getRepurchaseFromCashflow(cf0); // souvent négatif (sortie de cash)
  let buybackYieldApprox: number | null = null;
  if (isFiniteNum(mc) && isFiniteNum(repurchase) && (repurchase as number) < 0) {
    buybackYieldApprox = clip(Math.abs(repurchase as number) / (mc as number), -0.12, 0.10);
  }

  // --- Normalisations finales ---------------------------------------------
  const opm = toRatio(opm_raw, -1, 1); // marge opé. (0.30 = 30%)
  const priceToBook = isFiniteNum(priceToBook_raw) ? clip(priceToBook_raw!, -1, 200) : null;

  // --- Construction finale -------------------------------------------------
  return {
    // Core
    op_margin:         asMetric(opm,                 opm != null ? 0.45 : 0, "yahoo-v10"),
    current_ratio:     asMetric(currentRatio,        currentRatio != null ? 0.4  : 0, "yahoo-v10"),
    fcf_yield:         asMetric(fcfy,                fcfy != null ? 0.45 : 0, "yahoo-v10"),
    earnings_yield:    asMetric(ey,                  ey != null ? 0.45 : 0, "yahoo-v10"),
    net_cash:          asMetric(netCash,             netCash != null ? 0.35 : 0, "yahoo-v10"),

    // Qualité
    roe:                asMetric(roe ?? null,               roe != null ? 0.45 : 0, (roe_direct != null ? "yahoo-v10" : "calc")),
    roa:                asMetric(roa ?? null,               roa != null ? 0.4  : 0, (roa_direct != null ? "yahoo-v10" : "calc")),
    fcf_over_netincome: asMetric(fcf_over_ni,               fcf_over_ni != null ? 0.35 : 0, "calc"),
    roic:               asMetric(roic,                      roic != null ? 0.3  : 0, "calc"),

    // Croissance
    rev_growth:         asMetric(revGrowth,          revGrowth != null ? 0.4 : 0, "yahoo-v10"),
    eps_growth:         asMetric(epsGrowth,          epsGrowth != null ? 0.4 : 0, "yahoo-v10"),

    // Safety
    debt_to_equity:     asMetric(debtToEquity_final, debtToEquity_final != null ? 0.35 : 0, (debtToEquity_direct != null ? "yahoo-v10" : "calc")),
    net_debt_to_ebitda: asMetric(netDebtToEbitda,    netDebtToEbitda != null ? 0.35 : 0, "calc"),
    interest_coverage:  asMetric(interestCoverage_fallback, interestCoverage_fallback != null ? 0.35 : 0, "calc"),

    // Valuation
    ev_to_ebitda:       asMetric(evToEbitda,         evToEbitda != null ? 0.35 : 0, "calc"),

    // Gouvernance
    payout_ratio:       asMetric(payoutRatio,        payoutRatio != null ? 0.3  : 0, "yahoo-v10"),
    dividend_cagr_3y:   asMetric(null,               0, "none"),
    buyback_yield:      asMetric(buybackYieldApprox, buyback_yield != null ? 0.25 : 0, "calc"), // var name used below; TS ok
    insider_ownership:  asMetric(insiderOwnership,   insiderOwnership != null ? 0.3  : 0, "yahoo-v10"),

    // ESG
    esg_score:          asMetric(esgScore,           0, "none"),
    controversies_low:  asMetric(controversiesLow,   0, "none"),
  };
}