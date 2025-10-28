// /lib/yahooV10.ts
import type { Fundamentals, Metric } from "./types";

// =============== Helpers génériques ===============
const isNum = (v: any): v is number => typeof v === "number" && isFinite(v);

/** Extrait .raw si présent, sinon la valeur telle quelle (number attendu) */
function raw(x: any): number | null {
  if (x == null) return null;
  if (typeof x === "object" && "raw" in x) {
    const v = (x as any).raw;
    return isNum(v) ? v : null;
  }
  return isNum(x) ? x : null;
}

/** Nombre ou null (sans conversion) */
function num(x: any): number | null {
  return isNum(x) ? x : raw(x);
}

/** Normalise un pourcentage vers décimal (auto-détection Yahoo : déjà 0.x ou encore %) */
function normPct(x: any): number | null {
  const v = num(x);
  if (v == null || !isFinite(v)) return null;

  // Cas déjà en décimal (ex: 0.15 = 15 %)
  if (v > 0 && v < 1.2) return v;

  // Cas clairement en % (ex: 15.3 = 15 %)
  if (v >= 1.2 && v <= 120) return v / 100;

  // Cas aberrant (genre 3000 ou -900)
  return null;
}

/** Clamp utilitaire */
function clamp(x: number, a: number, b: number) {
  return Math.max(a, Math.min(b, x));
}

/** Linéaire 0..1 robuste */
function lin(v: number | null, v0: number, v1: number, invert = false) {
  if (v == null || !isFinite(v)) return 0;
  if (v0 === v1) return 0;
  const lo = Math.min(v0, v1), hi = Math.max(v0, v1);
  let t = (v - lo) / (hi - lo);
  t = clamp(t, 0, 1);
  return invert ? 1 - t : t;
}

/** Sweet spot triangulaire 0..1 */
function sweetSpot(
  x: number | null | undefined,
  a: number,
  b: number,
  lo: number,
  hi: number
) {
  const v = isNum(x) ? x : null;
  if (v == null) return 0.5;
  if (a > b) [a, b] = [b, a];
  if (lo > hi) [lo, hi] = [hi, lo];
  if (v <= lo || v >= hi) return 0;
  if (v <= a) return (v - lo) / (a - lo);
  if (v <= b) return 1;
  return 1 - (v - b) / (hi - b);
}

/** Dernier état d’un état financier (annual prioritaire, sinon quarterly) */
function firstStmt(list: any): any | null {
  if (!list) return null;
  const arr =
    list?.financials ||
    list?.balanceSheetStatements ||
    list?.cashflowStatements ||
    list?.incomeStatementHistory ||
    list?.cashflowStatementHistory ||
    list?.incomeStatementHistory?.incomeStatementHistory ||
    list?.cashflowStatementHistory?.cashflowStatements ||
    list?.balanceSheetHistory?.balanceSheetStatements ||
    list?.balanceSheetHistoryQuarterly?.balanceSheetStatements ||
    list;
  if (Array.isArray(arr) && arr.length) return arr[0];
  return null;
}

/** Construit un Metric */
function M(value: number | null, confidence = 0.6, source?: string): Metric {
  return { value, confidence, source };
}

// =============== Yahoo v10 fetch ===============
type YahooSession = { cookie?: string; crumb?: string } | any;

/**
 * Appelle Yahoo Finance v10 quoteSummary.
 * `sess` peut contenir { cookie, crumb }. On les envoie si présents.
 */
export async function fetchYahooV10(
  ticker: string,
  sess?: YahooSession,
  retryOnce = false
): Promise<any> {
  const mods = [
    "price",
    "summaryDetail",
    "financialData",
    "defaultKeyStatistics",
    "incomeStatementHistory",
    "cashflowStatementHistory",
    "balanceSheetHistory",
    "balanceSheetHistoryQuarterly",
    "esgScores",
  ].join(",");

  const base = "https://query2.finance.yahoo.com/v10/finance/quoteSummary";
  const url = `${base}/${encodeURIComponent(ticker)}?modules=${mods}${
    sess?.crumb ? `&crumb=${encodeURIComponent(sess.crumb)}` : ""
  }`;

  const headers: Record<string, string> = {
    "User-Agent": "Mozilla/5.0",
    "Accept": "application/json",
  };
  if (sess?.cookie) headers["Cookie"] = sess.cookie;

  const resp = await fetch(url, { headers });
  if (!resp.ok) {
    if (retryOnce) {
      // Retry simple sans crumb/cookie si échec
      const resp2 = await fetch(`${base}/${encodeURIComponent(ticker)}?modules=${mods}`, {
        headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" },
      });
      if (!resp2.ok) throw new Error(`Yahoo v10 HTTP ${resp2.status}`);
      const j2 = await resp2.json();
      return j2?.quoteSummary?.result?.[0] ?? j2;
    }
    throw new Error(`Yahoo v10 HTTP ${resp.status}`);
  }
  const j = await resp.json();
  return j?.quoteSummary?.result?.[0] ?? j;
}

// =============== Mapping v10 → Fundamentals ===============
/**
 * Transforme la réponse Yahoo v10 en `Fundamentals` (types.ts).
 * Normalise les pourcentages en décimal et calcule quelques proxys.
 */
export function computeFundamentalsFromV10(v10: any): Fundamentals {
  const price = v10?.price ?? {};
  const sd = v10?.summaryDetail ?? {};
  const fd = v10?.financialData ?? {};
  const ks = v10?.defaultKeyStatistics ?? {};
  const esg = v10?.esgScores ?? {};

  const isAnnualIS = v10?.incomeStatementHistory?.incomeStatementHistory;
  const isAnnualCF = v10?.cashflowStatementHistory?.cashflowStatements;
  const bsAnnual = v10?.balanceSheetHistory?.balanceSheetStatements;
  const bsQuarter = v10?.balanceSheetHistoryQuarterly?.balanceSheetStatements;

  const isStmt = firstStmt({ incomeStatementHistory: { incomeStatementHistory: isAnnualIS } });
  const cfStmt = firstStmt({ cashflowStatementHistory: { cashflowStatements: isAnnualCF } });
  const bsStmt = firstStmt(
    bsAnnual && bsAnnual.length ? { balanceSheetStatements: bsAnnual } : { balanceSheetStatements: bsQuarter }
  );

  // ---- Core ----
  const operatingMargin = normPct(fd?.operatingMargins);
  const currentRatio = num(fd?.currentRatio);

  // FCF Yield = FCF / MarketCap
  const freeCashflow = raw(fd?.freeCashflow) ?? raw(cfStmt?.freeCashFlow);
  const marketCap = raw(price?.marketCap);
  const fcfYield = marketCap && marketCap > 0 && isNum(freeCashflow) ? freeCashflow / marketCap : null;

  // Earnings Yield = 1 / trailingPE
  const trailingPE = num(sd?.trailingPE ?? ks?.trailingPE);
  const earningsYield = isNum(trailingPE) && trailingPE > 0 ? 1 / trailingPE : null;

  // Net cash proxy (1 si cash > debt, sinon test PB < 1.2)
  const totalDebt =
    raw(fd?.totalDebt) ??
    raw(bsStmt?.shortLongTermDebtTotal) ??
    raw(bsStmt?.longTermDebt) ??
    raw(bsStmt?.totalDebt);
  const totalCash =
    raw(fd?.totalCash) ??
    raw(bsStmt?.cash) ??
    raw(bsStmt?.cashAndCashEquivalents) ??
    raw(bsStmt?.cashAndShortTermInvestments);
  const netCashProxy =
    isNum(totalDebt) && isNum(totalCash)
      ? (totalCash - totalDebt) > 0
        ? 1
        : null
      : null;
  const priceToBook = num(sd?.priceToBook ?? ks?.priceToBook);
  const netCashFinal =
    netCashProxy === 1 ? 1 : isNum(priceToBook) && priceToBook < 1.2 ? 1 : 0;

  // ---- Ratios avancés (affichage) ----
  const roe = normPct(ks?.returnOnEquity ?? fd?.returnOnEquity);
  const roa = normPct(ks?.returnOnAssets ?? fd?.returnOnAssets);

  // ROIC (source Yahoo si dispo, sinon null — on calculera un approx côté front/adapter)
  let roic = normPct(ks?.returnOnInvestedCapital ?? fd?.returnOnInvestedCapital ?? fd?.returnOnCapitalEmployed);
  if (roic != null && roic > 1.2) roic = null; // filtre aberrations éventuelles

  // FCF / Net Income (approx)
  const netIncome = raw(isStmt?.netIncome);
  const fcfOverNi =
    isNum(freeCashflow) && isNum(netIncome) && Math.abs(netIncome) > 1 ? freeCashflow / netIncome : null;

  // ---- Croissance ----
  const revGrowth = normPct(fd?.revenueGrowth); // YoY
  const epsGrowth = normPct(fd?.earningsGrowth); // YoY

  // ---- Safety ----
  const debtToEquity = num(ks?.debtToEquity); // généralement ratio déjà "x"
  // Net debt / EBITDA
  const ebitda =
    raw(fd?.ebitda) ??
    raw(isStmt?.ebitda) ??
    raw(isStmt?.operatingIncome); // fallback large si ebitda absent
  const netDebt =
    isNum(totalDebt) && isNum(totalCash) ? totalDebt - totalCash : isNum(totalDebt) ? totalDebt : null;
  const nde =
    isNum(netDebt) && isNum(ebitda) && Math.abs(ebitda) > 1 ? netDebt / ebitda : null;

  // Interest coverage = EBIT / InterestExpense
  const ebit = raw(isStmt?.ebit ?? isStmt?.operatingIncome);
  const interestExpense = Math.abs(raw(isStmt?.interestExpense) ?? 0);
  const interestCoverage =
    isNum(ebit) && interestExpense > 0 ? ebit / interestExpense : null;

  // ---- Valuation ----
  const evToEbitda =
    num(ks?.enterpriseToEbitda ?? fd?.enterpriseToEbitda ?? sd?.enterpriseToEbitda) ?? null;

  // ---- Governance ----
  const payoutRatio = normPct(sd?.payoutRatio);
  const dividendCagr3y = null; // pas dispo direct
  const buybackYield = null; // calcul robuste nécessiterait l'historique des actions en circulation
  const insiderOwnership = normPct(ks?.heldPercentInsiders);

  // ---- ESG ----
  const esgScore = num(esg?.totalEsg) ?? null; // 0..100 (généralement)
  const controversy = num(esg?.controversyLevel); // 1 (bas) .. 5 (haut)
  const controversiesLow =
    isNum(controversy) ? (controversy <= 2 ? 1 : 0) : null;

  // ---- Moat proxy (0..1) ----
  // Mix ROIC / ROE / marge opé, pénalisé par levier et décroissance
  const roicZ = lin(roic, 0.07, 0.20);           // 7% → 20%
  const roeZ  = lin(roe,  0.10, 0.25);           // 10% → 25%
  const opmZ  = lin(operatingMargin, 0.10, 0.35); // 10% → 35%
  let moatProxy =
    0.5 * roicZ +
    0.3 * opmZ +
    0.2 * roeZ;

  // Pénalités
  if (isNum(debtToEquity) && debtToEquity > 2.0) moatProxy -= 0.15;
  if (isNum(nde) && nde > 3.0) moatProxy -= 0.10;
  if (isNum(revGrowth) && revGrowth < 0) moatProxy -= 0.10;
  moatProxy = clamp(moatProxy, 0, 1);

  // =============== Construction Fundamentals ===============
  const fundamentals: Fundamentals = {
    // Core
    op_margin: M(operatingMargin, 0.7, "yahoo:v10"),
    current_ratio: M(currentRatio, 0.7, "yahoo:v10"),
    fcf_yield: M(fcfYield, 0.7, "yahoo:v10"),
    earnings_yield: M(earningsYield, 0.7, "yahoo:v10"),
    net_cash: M(netCashFinal, 0.6, "yahoo:v10"),

    // Ratios avancés (affichage)
    roe: M(roe, 0.6, "yahoo:v10"),
    roa: M(roa, 0.6, "yahoo:v10"),
    fcf_over_netincome: M(fcfOverNi, 0.55, "yahoo:v10"),
    roic: M(roic, 0.6, "yahoo:v10"),

    // Croissance
    rev_growth: M(revGrowth, 0.6, "yahoo:v10"),
    eps_growth: M(epsGrowth, 0.6, "yahoo:v10"),

    // Safety
    debt_to_equity: M(debtToEquity, 0.6, "yahoo:v10"),
    net_debt_to_ebitda: M(nde, 0.55, "yahoo:v10"),
    interest_coverage: M(interestCoverage, 0.55, "yahoo:v10"),

    // Valuation
    ev_to_ebitda: M(evToEbitda, 0.6, "yahoo:v10"),

    // Governance
    payout_ratio: M(payoutRatio, 0.6, "yahoo:v10"),
    dividend_cagr_3y: M(dividendCagr3y, 0.4, "—"),
    buyback_yield: M(buybackYield, 0.4, "—"),
    insider_ownership: M(insiderOwnership, 0.6, "yahoo:v10"),

    // ESG
    esg_score: M(esgScore, 0.55, "yahoo:v10"),
    controversies_low: M(controversiesLow, 0.55, "yahoo:v10"),

    // Moat proxy
    moat_proxy: M(moatProxy, 0.55, "yahoo:v10(proxy)"),
  };

  return fundamentals;
}