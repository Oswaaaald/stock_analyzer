// /lib/yahooV10.ts
import { Fundamentals } from "./types";
import { asMetric, num } from "./utils";
import { UA, AL, YSession, getYahooSession } from "./yahooSession";

export async function fetchYahooV10(ticker: string, sess: YSession, retryOnce: boolean): Promise<any> {
  const base = {
    "User-Agent": UA,
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": AL,
    Origin: "https://finance.yahoo.com",
    Referer: "https://finance.yahoo.com/",
    ...(sess.cookie ? { Cookie: sess.cookie } as any : {}),
  };
  const crumbQS = sess.crumb ? `&crumb=${encodeURIComponent(sess.crumb)}` : "";
  const modules =
    "financialData,defaultKeyStatistics,price,summaryDetail,incomeStatementHistory,balanceSheetHistory";
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

export function computeFundamentalsFromV10(r: any): Fundamentals {
  const price = num(r?.price?.regularMarketPrice?.raw ?? r?.price?.regularMarketPrice);
  const shares = num(r?.defaultKeyStatistics?.sharesOutstanding?.raw ?? r?.defaultKeyStatistics?.sharesOutstanding);
  const trailingPE = num(r?.summaryDetail?.trailingPE?.raw ?? r?.defaultKeyStatistics?.trailingPE?.raw);
  const priceToBook = num(r?.defaultKeyStatistics?.priceToBook?.raw ?? r?.defaultKeyStatistics?.priceToBook);
  const currentRatio = num(r?.financialData?.currentRatio?.raw ?? r?.financialData?.currentRatio);
  const fcf = num(r?.financialData?.freeCashflow?.raw ?? r?.financialData?.freeCashflow);
  const opm = num(r?.financialData?.operatingMargins?.raw ?? r?.financialData?.operatingMargins);
  const cash = num(r?.financialData?.totalCash?.raw ?? r?.financialData?.totalCash);
  const debt = num(r?.financialData?.totalDebt?.raw ?? r?.financialData?.totalDebt);

  const ishs: any[] = r?.incomeStatementHistory?.incomeStatementHistory || [];
  const bsh: any[]  = r?.balanceSheetHistory?.balanceSheetStatements || [];

  const ni0     = num(ishs?.[0]?.netIncome?.raw ?? ishs?.[0]?.netIncome);
  const opInc0  = num(ishs?.[0]?.operatingIncome?.raw ?? ishs?.[0]?.operatingIncome);
  const taxExp0 = num(ishs?.[0]?.incomeTaxExpense?.raw ?? ishs?.[0]?.incomeTaxExpense);
  const preTax0 = num(ishs?.[0]?.incomeBeforeTax?.raw ?? ishs?.[0]?.incomeBeforeTax);

  const eq0     = num(bsh?.[0]?.totalStockholderEquity?.raw ?? bsh?.[0]?.totalStockholderEquity);
  const eq1     = num(bsh?.[1]?.totalStockholderEquity?.raw ?? bsh?.[1]?.totalStockholderEquity);
  const assets0 = num(bsh?.[0]?.totalAssets?.raw ?? bsh?.[0]?.totalAssets);

  const ey  = trailingPE && trailingPE > 0 ? 1 / trailingPE : null;
  const mc  = price && shares ? price * shares : null;
  const fcfy= mc && fcf != null ? fcf / mc : null;

  let netCash: number | null = null;
  if (cash != null && debt != null) netCash = cash - debt > 0 ? 1 : 0;
  else if (priceToBook && priceToBook > 0) netCash = priceToBook < 1.2 ? 1 : 0;

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

  return {
    op_margin: asMetric(opm, opm != null ? 0.45 : 0, "yahoo-v10"),
    current_ratio: asMetric(currentRatio, currentRatio != null ? 0.4 : 0, "yahoo-v10"),
    fcf_yield: asMetric(fcfy != null ? clampFcfy(fcfy) : null, fcfy != null ? 0.45 : 0, "yahoo-v10"),
    earnings_yield: asMetric(ey, ey != null ? 0.45 : 0, "yahoo-v10"),
    net_cash: asMetric(netCash, netCash != null ? 0.35 : 0, "yahoo-v10"),

    roe: asMetric(roe ?? null, roe != null ? 0.45 : 0, roe_direct != null ? "yahoo-v10" : "calc"),
    roa: asMetric(roa ?? null, roa != null ? 0.4 : 0, roa_direct != null ? "yahoo-v10" : "calc"),
    fcf_over_netincome: asMetric(fcf_over_ni, fcf_over_ni != null ? 0.35 : 0, "calc"),
    roic: asMetric(roic, roic != null ? 0.3 : 0, "calc"),
  };
}

const clampFcfy = (y: number) => Math.max(-0.05, Math.min(0.08, y));