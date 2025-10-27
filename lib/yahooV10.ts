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
  // modules étendus : on garde les tiens; timeSeries/ESG restent optionnels côté YF
  const modules =
    "financialData,defaultKeyStatistics,price,summaryDetail,quoteType,incomeStatementHistory,balanceSheetHistory,cashflowStatementHistory";
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

/* ---------- helpers locaux ---------- */
function cagr(series: Array<number | null>, years: number): number | null {
  const arr = series.filter((x): x is number => typeof x === "number" && isFinite(x));
  if (arr.length < years + 1) return null;
  const a = arr.at(-1)!;
  const b = arr.at(-(years + 1))!;
  if (!(a > 0 && b > 0)) return null;
  return Math.pow(a / b, 1 / years) - 1;
}

/**
 * Extrait et calcule les fondamentaux Yahoo v10 dans un format unifié
 */
export function computeFundamentalsFromV10(r: any): Fundamentals {
  // --- Données brutes
  const price = num(r?.price?.regularMarketPrice?.raw ?? r?.price?.regularMarketPrice);
  const shares = num(r?.defaultKeyStatistics?.sharesOutstanding?.raw ?? r?.defaultKeyStatistics?.sharesOutstanding);

  const trailingPE = num(r?.summaryDetail?.trailingPE?.raw ?? r?.defaultKeyStatistics?.trailingPE?.raw);
  const priceToBook = num(r?.defaultKeyStatistics?.priceToBook?.raw ?? r?.defaultKeyStatistics?.priceToBook);
  const currentRatio = num(r?.financialData?.currentRatio?.raw ?? r?.financialData?.currentRatio);
  const fcf = num(r?.financialData?.freeCashflow?.raw ?? r?.financialData?.freeCashflow);
  const opm = num(r?.financialData?.operatingMargins?.raw ?? r?.financialData?.operatingMargins);
  const cash = num(r?.financialData?.totalCash?.raw ?? r?.financialData?.totalCash);
  const debt = num(r?.financialData?.totalDebt?.raw ?? r?.financialData?.totalDebt);
  const ebitda = num(r?.financialData?.ebitda?.raw ?? r?.financialData?.ebitda);
  const ebit = num(r?.financialData?.ebit?.raw ?? r?.financialData?.ebit);

  // --- Croissance
  const revGrowth = num(r?.financialData?.revenueGrowth?.raw ?? r?.financialData?.revenueGrowth);
  const epsGrowth = num(r?.financialData?.earningsGrowth?.raw ?? r?.financialData?.earningsGrowth);

  // --- États financiers pour ratios avancés
  const ishs: any[] = r?.incomeStatementHistory?.incomeStatementHistory || [];
  const bsh:  any[] = r?.balanceSheetHistory?.balanceSheetStatements || [];
  const cfsh: any[] = r?.cashflowStatementHistory?.cashflowStatements || [];

  const ni0     = num(ishs?.[0]?.netIncome?.raw ?? ishs?.[0]?.netIncome);
  const opInc0  = num(ishs?.[0]?.operatingIncome?.raw ?? ishs?.[0]?.operatingIncome);
  const interestExp = num(ishs?.[0]?.interestExpense?.raw ?? ishs?.[0]?.interestExpense);
  const preTax0 = num(ishs?.[0]?.incomeBeforeTax?.raw ?? ishs?.[0]?.incomeBeforeTax);
  const taxExp0 = num(ishs?.[0]?.incomeTaxExpense?.raw ?? ishs?.[0]?.incomeTaxExpense);
  const eq0     = num(bsh?.[0]?.totalStockholderEquity?.raw ?? bsh?.[0]?.totalStockholderEquity);
  const eq1     = num(bsh?.[1]?.totalStockholderEquity?.raw ?? bsh?.[1]?.totalStockholderEquity);
  const assets0 = num(bsh?.[0]?.totalAssets?.raw ?? bsh?.[0]?.totalAssets);

  // --- Market cap et yields
  const mc = price && shares ? price * shares : null;
  const ey = trailingPE && trailingPE > 0 ? 1 / trailingPE : null;
  const fcfy = mc && fcf != null ? clip(fcf / mc, -0.05, 0.08) : null;

  // --- EV et ratios dérivés
  const enterpriseValue = mc != null && debt != null && cash != null ? mc + debt - cash : null;
  const evToEbitda = ebitda && ebitda !== 0 && enterpriseValue != null ? enterpriseValue / ebitda : null;

  // --- Safety ratios
  const debtToEquity = eq0 && eq0 !== 0 && debt != null ? debt / eq0 : null;
  const netDebt = debt != null && cash != null ? debt - cash : null;
  const netDebtToEbitda =
    ebitda && ebitda !== 0 && netDebt != null ? netDebt / ebitda : null;
  const interestCoverage =
    ebit != null && interestExp != null && interestExp !== 0 ? ebit / Math.abs(interestExp) : null;

  // --- Net cash proxy
  let netCash: number | null = null;
  if (cash != null && debt != null) netCash = cash - debt > 0 ? 1 : 0;
  else if (priceToBook && priceToBook > 0) netCash = priceToBook < 1.2 ? 1 : 0;

  // --- ROE / ROA / ROIC
  const roe_direct = num(r?.financialData?.returnOnEquity?.raw ?? r?.financialData?.returnOnEquity);
  const avgEq = eq0 != null && eq1 != null ? (eq0 + eq1) / 2 : eq0 ?? null;
  const roe_calc = ni0 != null && avgEq ? (avgEq !== 0 ? ni0 / avgEq : null) : null;
  const roe = roe_direct ?? roe_calc;

  const roa_direct = num(r?.financialData?.returnOnAssets?.raw ?? r?.financialData?.returnOnAssets);
  const roa = roa_direct ?? (ni0 != null && assets0 ? (assets0 !== 0 ? ni0 / assets0 : null) : null);

  const fcf_over_ni = fcf != null && ni0 != null && ni0 !== 0 ? fcf / ni0 : null;
  const taxRate =
    preTax0 && taxExp0 != null && preTax0 !== 0 ? Math.min(0.5, Math.max(0, taxExp0 / preTax0)) : 0.21;
  const nopat = opInc0 != null ? opInc0 * (1 - taxRate) : (ni0 != null ? ni0 : null);
  const invested =
    (debt ?? null) != null || (eq0 ?? null) != null ? ((debt ?? 0) + (eq0 ?? 0) - (cash ?? 0)) : null;
  const roic = nopat != null && invested && invested !== 0 ? nopat / invested : null;

  // --- Governance de base
  const payoutRatio = num(r?.summaryDetail?.payoutRatio?.raw ?? r?.summaryDetail?.payoutRatio);
  const insiderOwnership = num(
    r?.defaultKeyStatistics?.heldPercentInsiders?.raw ?? r?.defaultKeyStatistics?.heldPercentInsiders
  );

  // --- Governance avancée : buybacks & dividend CAGR (approximations robustes)
  // Buyback yield via cashflow (repurchaseOfStock est souvent négatif)
  const repurchase0 = num(cfsh?.[0]?.repurchaseOfStock?.raw ?? cfsh?.[0]?.repurchaseOfStock);
  const buyback_yield =
    (repurchase0 != null && mc && mc > 0)
      ? Math.max(0, -(repurchase0 as number) / mc)
      : null;

  // Dividend CAGR 3y (approx par flux "dividendsPaid" total – pas par action, mais corrélé)
  const divPaid0 = num(cfsh?.[0]?.dividendsPaid?.raw ?? cfsh?.[0]?.dividendsPaid);
  const divPaid1 = num(cfsh?.[1]?.dividendsPaid?.raw ?? cfsh?.[1]?.dividendsPaid);
  const divPaid2 = num(cfsh?.[2]?.dividendsPaid?.raw ?? cfsh?.[2]?.dividendsPaid);
  const divPaid3 = num(cfsh?.[3]?.dividendsPaid?.raw ?? cfsh?.[3]?.dividendsPaid);
  // on passe en valeurs positives (cash-out)
  const divSeries = [divPaid0, divPaid1, divPaid2, divPaid3].map(v => (v == null ? null : Math.abs(v)));
  const dividend_cagr_3y = cagr(divSeries, 3);

  // --- ESG / controverses (non dispo ici, placeholders)
  const esgScore = null;
  const controversiesLow = null;

  // --- Construction finale
  return {
    // Core
    op_margin: asMetric(opm, opm != null ? 0.45 : 0, "yahoo-v10"),
    current_ratio: asMetric(currentRatio, currentRatio != null ? 0.4 : 0, "yahoo-v10"),
    fcf_yield: asMetric(fcfy, fcfy != null ? 0.45 : 0, "yahoo-v10"),
    earnings_yield: asMetric(ey, ey != null ? 0.45 : 0, "yahoo-v10"),
    net_cash: asMetric(netCash, netCash != null ? 0.35 : 0, "yahoo-v10"),

    // Ratios qualité
    roe: asMetric(roe ?? null, roe != null ? 0.45 : 0, roe_direct != null ? "yahoo-v10" : "calc"),
    roa: asMetric(roa ?? null, roa != null ? 0.4 : 0, roa_direct != null ? "yahoo-v10" : "calc"),
    fcf_over_netincome: asMetric(fcf_over_ni, fcf_over_ni != null ? 0.35 : 0, "calc"),
    roic: asMetric(roic, roic != null ? 0.3 : 0, "calc"),

    // Croissance (YoY proxies)
    rev_growth: asMetric(revGrowth, revGrowth != null ? 0.4 : 0, "yahoo-v10"),
    eps_growth: asMetric(epsGrowth, epsGrowth != null ? 0.4 : 0, "yahoo-v10"),

    // Safety
    debt_to_equity: asMetric(debtToEquity, debtToEquity != null ? 0.35 : 0, "calc"),
    net_debt_to_ebitda: asMetric(netDebtToEbitda, netDebtToEbitda != null ? 0.35 : 0, "calc"),
    interest_coverage: asMetric(interestCoverage, interestCoverage != null ? 0.35 : 0, "calc"),

    // Valuation
    ev_to_ebitda: asMetric(evToEbitda, evToEbitda != null ? 0.35 : 0, "calc"),

    // Governance
    payout_ratio: asMetric(payoutRatio, payoutRatio != null ? 0.3 : 0, "yahoo-v10"),
    dividend_cagr_3y: asMetric(dividend_cagr_3y, dividend_cagr_3y != null ? 0.3 : 0, "calc"),
    buyback_yield: asMetric(buyback_yield, buyback_yield != null ? 0.3 : 0, "calc"),
    insider_ownership: asMetric(insiderOwnership, insiderOwnership != null ? 0.3 : 0, "yahoo-v10"),

    // ESG
    esg_score: asMetric(esgScore, 0, "none"),
    controversies_low: asMetric(controversiesLow, 0, "none"),
  };
}