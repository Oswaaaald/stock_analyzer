// Exécuter sur runtime Node.js
export const runtime = "nodejs";

import { NextResponse } from "next/server";

/* ======================================================================================
 *  CACHE SIMPLE (mémoire proces) 
 * ====================================================================================*/
const MEM: Record<string, { expires: number; data: any }> = {};
const TTL_MS = 30 * 60 * 1000; // 30 min

const CONTACT_EMAIL = process.env.CONTACT_EMAIL || "contact@example.com";

/* ======================================================================================
 *  TYPES
 * ====================================================================================*/
type FactPoint = { val: number; fy?: string; fp?: string; end?: string };
type FactUnits = { [unit: string]: FactPoint[] };
type Taxo = { [tag: string]: { units: FactUnits } };

type Metric = { value: number | null; confidence: number; source?: string };

type Fundamentals = {
  op_margin: Metric;
  current_ratio: Metric;
  dilution_3y: Metric;
  fcf_positive_last4: Metric;
  fcf_yield: Metric;
};

type Prices = {
  px: Metric;
  px_vs_200dma: Metric;
  pct_52w: Metric;
  max_dd_1y: Metric;
  ret_20d: Metric;
  ret_60d: Metric;
  meta?: { source_primary?: "yahoo" | "stooq.com" | "stooq.pl"; points?: number; recency_days?: number };
};

type DataBundle = {
  ticker: string;
  fundamentals: Fundamentals;
  prices: Prices;
  sources_used: string[];
};

type ScorePayload = {
  ticker: string;
  score: number;
  score_adj?: number;
  color: "green" | "orange" | "red";
  verdict: "sain" | "a_surveiller" | "fragile";
  verdict_reason: string;
  reasons_positive: string[];
  red_flags: string[];
  subscores: Record<string, number>;
  coverage: number;
  proof?: {
    price_source?: string;
    price_points?: number;
    price_has_200dma: boolean;
    price_recency_days?: number | null;
    sec_used?: string[];
    sec_note?: string | null;
    valuation_used?: boolean;
    sources_used?: string[];
  };
};

/* ======================================================================================
 *  HANDLER
 * ====================================================================================*/
export async function GET(_req: Request, { params }: { params: { ticker: string } }) {
  const t = (params.ticker || "").toUpperCase().trim();
  if (!t) return NextResponse.json({ error: "Ticker requis" }, { status: 400 });

  const now = Date.now();
  const cacheKey = `score_${t}`;
  const hit = MEM[cacheKey];
  if (hit && hit.expires > now) return NextResponse.json(hit.data);

  try {
    // Prix (Yahoo → Stooq)
    const priceFeed = await fetchPricesBestOf(t);

    // Fondamentaux : SEC/IFRS
    const sec = await fetchFromSEC_US_IfPossible(t, priceFeed.px.value);

    // FMP ratios (demo)
    const fmp = await fetchFmpRatiosIfPossible(t);

    // Yahoo JSON summary (souvent 401, on tente query1/2)
    const ySum = await fetchYahooSummaryIfPossible(t);

    // Yahoo HTML Key Statistics (scraping léger)
    const yHtml = await fetchYahooKeyStatsHtml(t);

    // Wikipedia infobox (dernier filet pour op_margin via revenue & operating income)
    const wiki = await fetchWikipediaOpMargin(t);

    // Fusion pondérée des fondamentaux
    const fundamentals = mergeFundamentalsWeighted({
      sec: sec.fundamentals,
      fmp: fmp.fundamentals,
      ysum: ySum,
      yhtml: yHtml,
      wiki: wiki,
    });

    const bundle: DataBundle = {
      ticker: t,
      fundamentals,
      prices: priceFeed,
      sources_used: [
        priceFeed.meta?.source_primary ? `price:${priceFeed.meta.source_primary}` : "price:unknown",
        ...(sec.used?.length ? sec.used.map((x) => `sec:${x}`) : []),
        ...(fmp.used ? ["fmp:ratios"] : []),
        ...(ySum.used ? ["yahoo:summary"] : []),
        ...(yHtml.used ? ["yahoo:html"] : []),
        ...(wiki.used ? ["wikipedia"] : []),
      ],
    };

    // SCORE
    const { subscores, malus, maxes } = computeScore(bundle);
    const total = subscores.quality + subscores.safety + subscores.valuation + subscores.momentum;
    const raw = Math.max(0, Math.min(100, Math.round(total) - malus));
    const coverage = Math.max(0, Math.min(100, Math.round(maxes.quality + maxes.safety + maxes.valuation + maxes.momentum)));
    const score_adj = coverage > 0 ? Math.round((total / coverage) * 100) : 0;
    const color: ScorePayload["color"] = raw >= 70 ? "green" : raw >= 50 ? "orange" : "red";
    const { verdict, reason } = makeVerdict(bundle, subscores, coverage);
    const reasons = buildReasons(bundle, subscores);
    const flags = detectRedFlags(bundle);

    const payload: ScorePayload = {
      ticker: t,
      score: raw,
      score_adj,
      color,
      verdict,
      verdict_reason: reason,
      reasons_positive: reasons.slice(0, 3),
      red_flags: flags.slice(0, 2),
      subscores,
      coverage,
      proof: {
        price_source: bundle.prices.meta?.source_primary,
        price_points: bundle.prices.meta?.points,
        price_has_200dma: bundle.prices.px_vs_200dma.value !== null,
        price_recency_days: bundle.prices.meta?.recency_days ?? null,
        sec_used: sec.used,
        sec_note: sec.note || null,
        valuation_used: fundamentals.fcf_yield.value !== null,
        sources_used: bundle.sources_used,
      },
    };

    MEM[cacheKey] = { expires: now + TTL_MS, data: payload };
    return NextResponse.json(payload, {
      headers: { "Cache-Control": "s-maxage=600, stale-while-revalidate=1200" },
    });
  } catch (e: any) {
    const msg = typeof e?.message === "string" ? e.message : (e?.toString?.() || "Erreur provider");
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

/* ======================================================================================
 *  HELPERS GÉNÉRAUX
 * ====================================================================================*/
const asMetric = (v: number | null, conf = 0, source?: string): Metric => ({ value: v, confidence: conf, source });
const clip = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
const safeNum = (x: any) => (typeof x === "number" && Number.isFinite(x) ? x : null);

/* ======================================================================================
 *  PRIX (Yahoo + Stooq)
 * ====================================================================================*/
type OHLCFeed = { dates: number[]; closes: number[]; source: "yahoo" | "stooq.com" | "stooq.pl" };

async function fetchPricesBestOf(ticker: string): Promise<Prices> {
  const feeds: OHLCFeed[] = [];
  try { const y = await fetchYahooChart(ticker); if (y) feeds.push(y); } catch {}
  try { const s1 = await fetchStooq(ticker, "https://stooq.com"); if (s1) feeds.push(s1); } catch {}
  try { const s2 = await fetchStooq(ticker, "https://stooq.pl"); if (s2) feeds.push(s2); } catch {}
  if (!feeds.length) throw new Error(`Aucune donnée de prix pour ${ticker}`);

  feeds.sort((a, b) => {
    const ra = a.dates.at(-1) ?? 0;
    const rb = b.dates.at(-1) ?? 0;
    if (ra !== rb) return rb - ra;
    return (b.closes.length - a.closes.length);
  });

  const primary = feeds[0];
  const enriched = enrichCloses(primary.closes);

  return {
    px: asMetric(enriched.px, confFromFeed(primary), primary.source),
    px_vs_200dma: asMetric(enriched.px_vs_200dma, confFromFeed(primary), primary.source),
    pct_52w: asMetric(enriched.pct_52w, confFromFeed(primary), primary.source),
    max_dd_1y: asMetric(enriched.max_dd_1y, confFromFeed(primary), primary.source),
    ret_20d: asMetric(enriched.ret_20d, confFromFeed(primary), primary.source),
    ret_60d: asMetric(enriched.ret_60d, confFromFeed(primary), primary.source),
    meta: {
      source_primary: primary.source,
      points: primary.closes.length,
      recency_days: Math.round((Date.now() - (primary.dates.at(-1) ?? Date.now())) / (1000 * 3600 * 24)),
    },
  };
}
function confFromFeed(feed: OHLCFeed) {
  const pts = feed.closes.length;
  if (pts >= 400) return 0.95;
  if (pts >= 250) return 0.85;
  if (pts >= 120) return 0.7;
  return 0.4;
}
async function fetchYahooChart(ticker: string): Promise<OHLCFeed | null> {
  const headers = { "User-Agent": "Mozilla/5.0 (compatible; StockAnalyzer/1.0)", "Accept": "application/json, text/plain, */*" };
  const urls = [
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=2y&interval=1d`,
    `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=2y&interval=1d`,
  ];
  for (const url of urls) {
    const js = await fetchJsonSafe(url, headers);
    const res = js?.chart?.result?.[0];
    if (!res) continue;
    const ts: number[] = (res?.timestamp || []).map((t: number) => t * 1000);
    const closes: number[] = (res?.indicators?.quote?.[0]?.close || []) as number[];
    const adj: number[] = (res?.indicators?.adjclose?.[0]?.adjclose || []) as number[];
    const raw = (closes?.filter(Number.isFinite)?.length ? closes : adj) || [];
    const arr = raw.filter((n) => typeof n === "number" && Number.isFinite(n));
    if (arr.length) return { dates: ts.slice(-arr.length), closes: arr, source: "yahoo" };
  }
  return null;
}
async function fetchStooq(ticker: string, origin: "https://stooq.com" | "https://stooq.pl"): Promise<OHLCFeed | null> {
  const cands = makeStooqCandidates(ticker);
  for (const sym of cands) {
    const url = `${origin}/q/d/l/?s=${encodeURIComponent(sym)}&i=d`;
    const csv = await fetchTextSafe(url, "text/csv");
    const parsed = csv ? parseStooqCsv(csv) : null;
    if (parsed?.closes?.length) return { ...parsed, source: origin.endsWith(".pl") ? "stooq.pl" : "stooq.com" };
  }
  return null;
}
function makeStooqCandidates(ticker: string): string[] {
  const t = ticker.toLowerCase();
  const out = new Set<string>([t, `${t}.us`, t.replace(/\./g, "-"), `${t.replace(/\./g, "-")}.us`]);
  if (/\.[a-z]{2,3}$/.test(t)) out.add(t);
  return Array.from(out);
}
function parseStooqCsv(csv: string): { dates: number[]; closes: number[] } {
  const lines = csv.trim().split(/\r?\n/);
  if (lines.length <= 1) return { dates: [], closes: [] };
  const header = lines[0].split(",");
  const idxDate = header.indexOf("Date");
  const idxClose = header.indexOf("Close");
  const dates: number[] = [];
  const closes: number[] = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(",");
    const d = parts[idxDate];
    const c = parseFloat(parts[idxClose]);
    if (d && Number.isFinite(c)) { dates.push(new Date(d).getTime()); closes.push(c); }
  }
  return { dates, closes };
}
function enrichCloses(closes: number[]) {
  if (!Array.isArray(closes) || closes.filter(Number.isFinite).length < 60) {
    const last = closes.at(-1) ?? null;
    return { px: last, px_vs_200dma: null, pct_52w: null, max_dd_1y: null, ret_20d: null, ret_60d: null };
  }
  const px = closes.at(-1) ?? null;
  let px_vs_200dma: number | null = null;
  if (closes.length >= 200 && typeof px === "number") {
    const avg = closes.slice(-200).reduce((a, b) => a + b, 0) / 200;
    if (avg) px_vs_200dma = (px - avg) / avg;
  }
  const last252 = closes.slice(-252);
  let pct_52w: number | null = null;
  let max_dd_1y: number | null = null;
  if (last252.length >= 30 && typeof px === "number") {
    const hi = Math.max(...last252), lo = Math.min(...last252);
    if (hi > lo) pct_52w = (px - lo) / (hi - lo);
    let peak = last252[0]; let mdd = 0;
    for (const c of last252) { peak = Math.max(peak, c); mdd = Math.min(mdd, (c - peak) / peak); }
    max_dd_1y = mdd;
  }
  let ret_20d: number | null = null, ret_60d: number | null = null;
  if (closes.length >= 21 && typeof px === "number") {
    const prev20 = closes[closes.length - 21]; if (prev20 > 0) ret_20d = px / prev20 - 1;
  }
  if (closes.length >= 61 && typeof px === "number") {
    const prev60 = closes[closes.length - 61]; if (prev60 > 0) ret_60d = px / prev60 - 1;
  }
  return { px, px_vs_200dma, pct_52w, max_dd_1y, ret_20d, ret_60d };
}

/* ======================================================================================
 *  SEC (US-GAAP + IFRS)
 * ====================================================================================*/
let TICKER_MAP: Record<string, { cik_str: number; ticker: string; title: string }> = {};
let TICKER_MAP_EXP = 0;

async function loadTickerMap(): Promise<typeof TICKER_MAP> {
  const now = Date.now();
  if (Object.keys(TICKER_MAP).length && TICKER_MAP_EXP > now) return TICKER_MAP;
  const url = "https://www.sec.gov/files/company_tickers.json";
  const r = await fetch(url, { headers: { "User-Agent": `StockAnalyzer/1.0 (${CONTACT_EMAIL})`, "Accept": "application/json" } });
  if (!r.ok) return TICKER_MAP;
  const js = await r.json();
  const map: typeof TICKER_MAP = {};
  Object.values(js as any).forEach((row: any) => {
    map[String(row.ticker).toUpperCase()] = { cik_str: row.cik_str, ticker: row.ticker, title: row.title };
  });
  TICKER_MAP = map; TICKER_MAP_EXP = now + 24 * 3600 * 1000;
  return TICKER_MAP;
}
function pickBestUnit(units?: FactUnits, preferUSD = true): FactPoint[] | undefined {
  if (!units) return undefined;
  if (preferUSD && units.USD && units.USD.length) return sortByEnd(units.USD);
  let best: FactPoint[] | undefined = undefined;
  for (const arr of Object.values(units)) {
    const valid = Array.isArray(arr) ? arr.filter(p => typeof p?.val === "number") : [];
    if (!valid.length) continue;
    if (!best || valid.length > best.length) best = valid;
  }
  return best ? sortByEnd(best) : undefined;
}
const sortByEnd = (arr: FactPoint[]) => [...arr].sort((a, b) => (Date.parse(a.end || "") || 0) - (Date.parse(b.end || "") || 0));
const lastVal = (arr?: FactPoint[]) => (arr && arr.length ? arr[arr.length - 1].val ?? null : null);
function sumLastNQuarterly(arr?: FactPoint[], n = 4) {
  if (!arr || !arr.length) return null;
  const q = arr.filter(p => (p.fp || "").toUpperCase().startsWith("Q"));
  if (q.length < n) return null;
  let s = 0;
  for (let i = q.length - n; i < q.length; i++) {
    const v = q[i]?.val; if (typeof v !== "number") return null; s += v;
  }
  return s;
}
function lastAnnual(arr?: FactPoint[]) {
  if (!arr || !arr.length) return null;
  const annual = arr.filter(p => !p.fp || (p.fp || "").toUpperCase() === "FY");
  if (!annual.length) return null;
  return annual[annual.length - 1].val ?? null;
}

async function fetchFromSEC_US_IfPossible(ticker: string, lastPrice: number | null) {
  const fund: Fundamentals = {
    op_margin: asMetric(null, 0, "sec"),
    current_ratio: asMetric(null, 0, "sec"),
    dilution_3y: asMetric(null, 0, "sec"),
    fcf_positive_last4: asMetric(null, 0, "sec"),
    fcf_yield: asMetric(null, 0, "sec"),
  };
  const used: string[] = [];
  let note: string | undefined;

  // CIK
  let cik: string | null = null;
  try {
    const map = await loadTickerMap(); const hit = map[ticker.toUpperCase()];
    if (hit) cik = String(hit.cik_str).padStart(10, "0");
  } catch {}

  if (!cik) return { fundamentals: fund, used, note };

  // facts
  let usgaap: Taxo = {}, ifrs: Taxo = {};
  try {
    const url = `https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`;
    const r = await fetch(url, { headers: { "User-Agent": `StockAnalyzer/1.0 (${CONTACT_EMAIL})`, "Accept": "application/json" } });
    if (!r.ok) throw new Error(`SEC HTTP ${r.status}`);
    const facts = await r.json();
    usgaap = (facts?.facts?.["us-gaap"] as Taxo) || {};
    ifrs = (facts?.facts?.["ifrs-full"] as Taxo) || {};
    if (Object.keys(usgaap).length) used.push("us-gaap");
    if (Object.keys(ifrs).length) used.push("ifrs-full");
    note = "TTM si disponible (somme Q), sinon dernier annuel.";
  } catch { return { fundamentals: fund, used, note }; }

  // Revenue & Operating Income
  const revUnits =
    usgaap.RevenueFromContractWithCustomerExcludingAssessedTax?.units ||
    usgaap.Revenues?.units ||
    (ifrs as any).Revenue?.units ||
    (ifrs as any).RevenueFromContractsWithCustomersExcludingAssessedTax?.units;

  const opUnits =
    usgaap.OperatingIncomeLoss?.units ||
    (ifrs as any).OperatingProfitLoss?.units ||
    (ifrs as any).ProfitLossFromOperatingActivities?.units;

  const revSeries = pickBestUnit(revUnits);
  const opSeries = pickBestUnit(opUnits);
  const revTTM = sumLastNQuarterly(revSeries, 4) ?? lastAnnual(revSeries);
  const opTTM = sumLastNQuarterly(opSeries, 4) ?? lastAnnual(opSeries);
  if (typeof revTTM === "number" && revTTM !== 0 && typeof opTTM === "number") {
    fund.op_margin = asMetric(opTTM / revTTM, 0.9, "sec");
  }

  // Current ratio
  const caSeries = pickBestUnit(usgaap.AssetsCurrent?.units || (ifrs as any).CurrentAssets?.units);
  const clSeries = pickBestUnit(usgaap.LiabilitiesCurrent?.units || (ifrs as any).CurrentLiabilities?.units);
  const ca = lastVal(caSeries), cl = lastVal(clSeries);
  if (typeof ca === "number" && typeof cl === "number" && cl !== 0) fund.current_ratio = asMetric(ca / cl, 0.8, "sec");

  // Shares (dilution 3y)
  const sharesUnits =
    usgaap.CommonStockSharesOutstanding?.units ||
    usgaap.EntityCommonStockSharesOutstanding?.units ||
    (ifrs as any).NumberOfSharesOutstanding?.units ||
    (ifrs as any).WeightedAverageNumberOfOrdinarySharesOutstandingDiluted?.units ||
    (ifrs as any).WeightedAverageNumberOfSharesOutstandingDiluted?.units;

  const shSeries = pickBestUnit(sharesUnits, false);
  if (shSeries && shSeries.length >= 2) {
    const last = shSeries.at(-1)!.val;
    const idx = Math.max(0, shSeries.length - 13);
    const prev = shSeries[idx]?.val;
    if (typeof last === "number" && typeof prev === "number" && prev > 0) {
      fund.dilution_3y = asMetric((last - prev) / prev, 0.7, "sec");
    }
  }

  // CFO & Capex
  const cfoUnits =
    usgaap.NetCashProvidedByUsedInOperatingActivities?.units ||
    usgaap.NetCashProvidedByUsedInOperatingActivitiesContinuingOperations?.units ||
    (ifrs as any).CashFlowsFromUsedInOperatingActivities?.units ||
    (ifrs as any).NetCashFromOperatingActivities?.units;

  const capUnits =
    usgaap.PaymentsToAcquireProductiveAssets?.units ||
    usgaap.PurchasesOfPropertyPlantAndEquipment?.units ||
    (ifrs as any).PurchaseOfPropertyPlantAndEquipment?.units ||
    (ifrs as any).PaymentsForPropertyPlantAndEquipment?.units;

  const cfoSeries = pickBestUnit(cfoUnits);
  const capSeries = pickBestUnit(capUnits);

  if (cfoSeries && capSeries) {
    let countPos = 0;
    const n = Math.min(4, Math.min(cfoSeries.length, capSeries.length));
    for (let i = 1; i <= n; i++) {
      const cfo = cfoSeries[cfoSeries.length - i]?.val;
      const cap = capSeries[capSeries.length - i]?.val;
      if (typeof cfo === "number" && typeof cap === "number") {
        const fcf = cfo - Math.abs(cap);
        if (fcf > 0) countPos++;
      }
    }
    fund.fcf_positive_last4 = asMetric(countPos, 0.7, "sec");
  }

  // fcf_yield (US-GAAP uniquement, crédible)
  const isUS = used.includes("us-gaap");
  const cfoTTM = sumLastNQuarterly(cfoSeries, 4) ?? lastAnnual(cfoSeries);
  const capTTM = sumLastNQuarterly(capSeries, 4) ?? lastAnnual(capSeries);
  if (isUS && typeof lastPrice === "number" && typeof cfoTTM === "number" && typeof capTTM === "number") {
    const shLast = lastVal(shSeries);
    if (typeof shLast === "number" && shLast > 0) {
      const mcap = lastPrice * shLast;
      if (mcap > 0) {
        const fcf = cfoTTM - Math.abs(capTTM);
        let y = fcf / mcap;
        y = Math.max(-0.05, Math.min(0.08, y));
        if (typeof fund.fcf_positive_last4.value === "number" && fund.fcf_positive_last4.value >= 2) {
          fund.fcf_yield = asMetric(y, 0.7, "sec");
        }
      }
    }
  }

  return { fundamentals: fund, used, note };
}

/* ======================================================================================
 *  FMP ratios (demo)
 * ====================================================================================*/
async function fetchFmpRatiosIfPossible(ticker: string) {
  const urls = [
    `https://financialmodelingprep.com/api/v3/ratios-ttm/${encodeURIComponent(ticker)}?apikey=demo`,
    `https://financialmodelingprep.com/api/v3/ratios/${encodeURIComponent(ticker)}?period=quarter&limit=12&apikey=demo`,
  ];
  let ratios: any = null;
  for (const u of urls) {
    const js = await fetchJsonSafe(u);
    if (js && Array.isArray(js) && js.length) { ratios = js; break; }
    if (js && js?.ratiosTTM) { ratios = [js.ratiosTTM]; break; }
  }
  const out: Partial<Fundamentals> = {};
  let used = false;

  if (ratios && Array.isArray(ratios) && ratios.length) {
    used = true;
    const r0 = ratios[0] || {};
    const opm = safeNum(r0.operatingProfitMarginTTM ?? r0.operatingProfitMargin);
    if (opm !== null) out.op_margin = asMetric(opm, 0.5, "fmp");

    const cr = safeNum(r0.currentRatioTTM ?? r0.currentRatio);
    if (cr !== null) out.current_ratio = asMetric(cr, 0.5, "fmp");

    const pfcf = safeNum(r0.priceToFreeCashFlowsRatioTTM ?? r0.priceToFreeCashFlowTTM ?? r0.priceToFreeCashFlowsRatio);
    if (pfcf && pfcf > 0) out.fcf_yield = asMetric(Math.max(-0.05, Math.min(0.08, 1 / pfcf)), 0.4, "fmp");
  }

  return { fundamentals: out, used };
}

/* ======================================================================================
 *  Yahoo SUMMARY (JSON) – best effort
 * ====================================================================================*/
async function fetchYahooSummaryIfPossible(ticker: string) {
  const headers = { "User-Agent": "Mozilla/5.0 (compatible; StockAnalyzer/1.0)", "Accept": "application/json, text/plain, */*" };
  const urls = [
    `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(ticker)}?modules=financialData,defaultKeyStatistics,price`,
    `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(ticker)}?modules=financialData,defaultKeyStatistics,price`,
  ];
  let js: any = null;
  for (const u of urls) {
    js = await fetchJsonSafe(u, headers);
    if (js?.quoteSummary?.result?.[0]) break;
  }
  const out: Partial<Fundamentals> = {};
  let used = false;
  try {
    const r = js?.quoteSummary?.result?.[0];
    if (!r) return { fundamentals: out, used: false };
    used = true;

    const opm = safeNum(r?.financialData?.operatingMargins);
    if (opm !== null) out.op_margin = asMetric(opm, 0.45, "yahoo");

    const cr = safeNum(r?.financialData?.currentRatio);
    if (cr !== null) out.current_ratio = asMetric(cr, 0.4, "yahoo");

    // Approx FCF via operatingCashflow - capex
    const ocf = safeNum(r?.financialData?.operatingCashflow);
    const capex = safeNum(r?.financialData?.capitalExpenditures);
    const price = safeNum(r?.price?.regularMarketPrice ?? r?.price?.postMarketPrice);
    const shares = safeNum(r?.defaultKeyStatistics?.sharesOutstanding);
    if (price !== null && shares !== null && ocf !== null && capex !== null && shares > 0) {
      const mcap = price * shares;
      if (mcap > 0) {
        let y = (ocf - Math.abs(capex)) / mcap;
        y = Math.max(-0.05, Math.min(0.08, y));
        out.fcf_yield = asMetric(y, 0.35, "yahoo");
      }
    }
  } catch {}
  return { fundamentals: out, used };
}

/* ======================================================================================
 *  Yahoo HTML Key Statistics (scrape léger, plus permissif)
 * ====================================================================================*/
async function fetchYahooKeyStatsHtml(ticker: string) {
  const url = `https://finance.yahoo.com/quote/${encodeURIComponent(ticker)}/key-statistics`;
  const html = await fetchTextSafe(url, "text/html");
  const out: Partial<Fundamentals> = {};
  let used = false;

  if (!html || html.includes("Rate Limited") || html.includes("error-title")) {
    return { fundamentals: out, used };
  }
  used = true;

  // On tolère des variations de casse/espaces et des libellés proches
  // Operating Margin
  const opmREs = [
    /Operating\s*Margin\s*\(ttm\)[^%]*?([\d.,\-]+)%/i,
    /Op(?:erating)?\s*Margin[^%]*?([\d.,\-]+)%/i
  ];
  for (const re of opmREs) {
    const m = html.match(re);
    if (m) {
      const v = parseFloat(m[1].replace(/[^\d.-]/g, "")) / 100;
      if (Number.isFinite(v)) { out.op_margin = asMetric(v, 0.35, "yahoo-html"); break; }
    }
  }

  // Current Ratio
  const crREs = [
    /Current\s*Ratio\s*\(mrq\)[^<]*?<\/span>[^<]*?([\d.,\-]+)/i,
    /Current\s*Ratio[^<]*?<\/span>[^<]*?([\d.,\-]+)/i
  ];
  for (const re of crREs) {
    const c = html.match(re);
    if (c) {
      const v = parseFloat(c[1].replace(/[^\d.-]/g, ""));
      if (Number.isFinite(v)) { out.current_ratio = asMetric(v, 0.3, "yahoo-html"); break; }
    }
  }

  // Price to Free Cash Flow → approx fcf_yield
  const pfcfREs = [
    /Price\s*to\s*Free\s*Cash\s*Flow[^<]*?<\/span>[^<]*?([\d.,\-]+)/i,
    /P\/FCF[^<]*?<\/span>[^<]*?([\d.,\-]+)/i
  ];
  for (const re of pfcfREs) {
    const p = html.match(re);
    if (p) {
      const ratio = parseFloat(p[1].replace(/[^\d.-]/g, ""));
      if (Number.isFinite(ratio) && ratio > 0) { out.fcf_yield = asMetric(Math.max(-0.05, Math.min(0.08, 1 / ratio)), 0.3, "yahoo-html"); break; }
    }
  }

  return { fundamentals: out, used };
}

/* ======================================================================================
 *  Wikipedia (EN → FR fallback) : op_margin via revenue & operating income
 * ====================================================================================*/
async function fetchWikipediaOpMargin(ticker: string) {
  // On récupère un nom de société via l’API search Yahoo
  const search = await fetchJsonSafe(`https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(ticker)}`);
  const companyName: string | null =
    search?.quotes?.[0]?.longname || search?.quotes?.[0]?.shortname || null;

  if (!companyName) return { used: false, fundamentals: {} as Partial<Fundamentals> };

  // Essaie EN puis FR ; pour chaque langue, tente wikitext puis HTML
  const langs = ["en", "fr"] as const;
  for (const lang of langs) {
    const pageTitle = encodeURIComponent(companyName);
    // 1) WIKITEXT
    const api = await fetchJsonSafe(`https://${lang}.wikipedia.org/w/api.php?action=parse&page=${pageTitle}&prop=wikitext&format=json&redirects=1&origin=*`);
    const wikitext: string | null = api?.parse?.wikitext?.["*"] || null;
    const fromWikitext = parseOpMarginFromWikiText(wikitext, lang);
    if (fromWikitext) return { used: true, fundamentals: { op_margin: asMetric(fromWikitext, 0.25, "wikipedia") } };

    // 2) HTML (si wikitext insuffisant)
    const htmlApi = await fetchJsonSafe(`https://${lang}.wikipedia.org/w/api.php?action=parse&page=${pageTitle}&prop=text&format=json&redirects=1&origin=*`);
    const html: string | null = htmlApi?.parse?.text?.["*"] || null;
    const fromHtml = parseOpMarginFromWikiHTML(html, lang);
    if (fromHtml) return { used: true, fundamentals: { op_margin: asMetric(fromHtml, 0.22, "wikipedia") } };
  }

  return { used: false, fundamentals: {} as Partial<Fundamentals> };

  function parseOpMarginFromWikiText(wikitext: string | null, lang: "en" | "fr"): number | null {
    if (!wikitext) return null;

    // EN labels
    const revLineEN = wikitext.match(/\|\s*revenue\s*=\s*([^\n]+)/i);
    const opLineEN  = wikitext.match(/\|\s*operating_income\s*=\s*([^\n]+)/i);

    // FR labels
    const revLineFR = wikitext.match(/\|\s*chiffre d['’]affaires\s*=\s*([^\n]+)/i);
    const opLineFR  = wikitext.match(/\|\s*résultat opérationnel\s*=\s*([^\n]+)/i);

    const revLine = lang === "fr" ? (revLineFR?.[1] || revLineEN?.[1]) : (revLineEN?.[1] || revLineFR?.[1]);
    const opLine  = lang === "fr" ? (opLineFR?.[1] || opLineEN?.[1])   : (opLineEN?.[1] || opLineFR?.[1]);

    const rev = extractNumberGeneric(revLine);
    const op  = extractNumberGeneric(opLine);
    if (rev && op && rev !== 0) {
      const margin = op / rev;
      return clampMargin(margin);
    }
    return null;
  }

  function parseOpMarginFromWikiHTML(html: string | null, lang: "en" | "fr"): number | null {
    if (!html) return null;
    // Simpliste : on cherche dans l’infobox des <th> / <td>
    // EN
    const revEN = findValueAfterHeader(html, /(>|\b)Revenue(?!s)\b/i);
    const opEN  = findValueAfterHeader(html, /(>|\b)Operating income\b/i);
    // FR
    const revFR = findValueAfterHeader(html, /(>|\b)Chiffre d[’']affaires\b/i);
    const opFR  = findValueAfterHeader(html, /(>|\b)Résultat opérationnel\b/i);

    const rev = extractNumberGeneric(lang === "fr" ? (revFR || revEN) : (revEN || revFR));
    const op  = extractNumberGeneric(lang === "fr" ? (opFR  || opEN) : (opEN  || opFR));
    if (rev && op && rev !== 0) return clampMargin(op / rev);
    return null;

    function findValueAfterHeader(s: string, headerRe: RegExp) {
      const m = s.match(new RegExp(`<th[^>]*>\\s*${headerRe.source}[^<]*</th>\\s*<td[^>]*>([\\s\\S]*?)</td>`, headerRe.flags));
      return m ? stripHtml(m[1]) : null;
    }
    function stripHtml(x: string) {
      return x.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    }
  }

  function extractNumberGeneric(s?: string | null): number | null {
    if (!s) return null;
    // milliards / millions (en/ fr)
    const bn = s.match(/([\d.,]+)\s*(billion|bn|milliard)s?/i);
    if (bn) return parseFloat(bn[1].replace(/[^\d.,-]/g, "").replace(",", ".")) * 1e9;
    const mn = s.match(/([\d.,]+)\s*(million|mn|millions)/i);
    if (mn) return parseFloat(mn[1].replace(/[^\d.,-]/g, "").replace(",", ".")) * 1e6;
    // $xx,xxx,xxx etc.
    const raw = s.match(/([\$€£]?\s*[\d.,]+(?:\s*\w+)?)/);
    if (raw) {
      const num = parseFloat(raw[0].replace(/[^\d.,-]/g, "").replace(",", "."));
      return Number.isFinite(num) ? num : null;
    }
    return null;
  }
  function clampMargin(m: number) {
    return Math.max(-0.5, Math.min(0.6, m));
  }
}

/* ======================================================================================
 *  MERGE pondéré : SEC/IFRS > Yahoo JSON > Yahoo HTML > FMP > Wikipedia
 * ====================================================================================*/
function mergeFundamentalsWeighted(src: {
  sec: Fundamentals;
  fmp: Partial<Fundamentals>;
  ysum: { fundamentals: Partial<Fundamentals>; used: boolean };
  yhtml: { fundamentals: Partial<Fundamentals>; used: boolean };
  wiki: { fundamentals: Partial<Fundamentals>; used: boolean };
}): Fundamentals {
  const pick = (key: keyof Fundamentals): Metric => {
    const candidates: Metric[] = [];

    const pushIf = (m?: Metric | null) => { if (m && m.value !== null) candidates.push(m); };

    pushIf(src.sec[key]);
    pushIf(src.ysum.fundamentals[key] as any);
    pushIf(src.yhtml.fundamentals[key] as any);
    pushIf(src.fmp[key] as any);
    pushIf(src.wiki.fundamentals[key] as any);

    if (!candidates.length) return asMetric(null, 0);

    // Choix : meilleur score de confiance ; s’il y a égalité, priorité SEC > Yahoo JSON > Yahoo HTML > FMP > Wiki
    candidates.sort((a, b) => (b.confidence - a.confidence));
    return candidates[0];
  };

  return {
    op_margin: pick("op_margin"),
    current_ratio: pick("current_ratio"),
    dilution_3y: pick("dilution_3y"),
    fcf_positive_last4: pick("fcf_positive_last4"),
    fcf_yield: pick("fcf_yield"),
  };
}

/* ======================================================================================
 *  SCORING /100 + COUVERTURE
 * ====================================================================================*/
function computeScore(d: DataBundle) {
  const f = d.fundamentals;
  const p = d.prices;

  // Qualité (35)
  let q = 0, qMax = 0;
  if (typeof f.op_margin.value === "number") {
    qMax += 8;
    q += f.op_margin.value >= 0.25 ? 8 : f.op_margin.value >= 0.15 ? 6 : f.op_margin.value >= 0.05 ? 3 : 0;
  }

  // Sécurité (25)
  let s = 0, sMax = 0;
  if (typeof f.current_ratio.value === "number") {
    sMax += 4; s += f.current_ratio.value > 1.5 ? 4 : f.current_ratio.value >= 1 ? 2 : 0;
  }
  if (typeof f.dilution_3y.value === "number") {
    sMax += 3; const dlt = f.dilution_3y.value;
    s += dlt <= 0 ? 3 : dlt <= 0.05 ? 2 : dlt <= 0.15 ? 1 : 0;
  }
  if (typeof f.fcf_positive_last4.value === "number") {
    sMax += 4; s += f.fcf_positive_last4.value >= 3 ? 4 : 0;
  }

  // Valorisation (25)
  let v = 0, vMax = 0;
  if (typeof f.fcf_yield.value === "number") {
    vMax += 10;
    const y = f.fcf_yield.value;
    v += y > 0.06 ? 10 : y >= 0.04 ? 7 : y >= 0.02 ? 4 : 1;
  }

  // Momentum (15)
  let m = 0, mMax = 0;
  if (typeof p.px_vs_200dma.value === "number") {
    mMax = 10; m += p.px_vs_200dma.value >= 0.05 ? 10 : p.px_vs_200dma.value > -0.05 ? 6 : 2;
  }
  if (typeof p.ret_20d.value === "number") {
    mMax += 3; m += p.ret_20d.value > 0.03 ? 3 : p.ret_20d.value > 0 ? 2 : 0;
  }
  if (typeof p.ret_60d.value === "number") {
    mMax += 2; m += p.ret_60d.value > 0.06 ? 2 : p.ret_60d.value > 0 ? 1 : 0;
  }
  m = Math.min(m, 15); mMax = 15;

  const subscores = {
    quality: clip(q, 0, 35),
    safety: clip(s, 0, 25),
    valuation: clip(v, 0, 25),
    momentum: clip(m, 0, 15),
  };
  const maxes = { quality: qMax, safety: sMax, valuation: vMax, momentum: mMax };
  const malus = 0;
  return { subscores, malus, maxes };
}

function buildReasons(_d: DataBundle, subs: Record<string, number>) {
  const out: string[] = [];
  if (subs.quality >= 6) out.push("Marge opérationnelle décente");
  if (subs.safety >= 4) out.push("Bilans plutôt sains (ratio court terme / dilution / FCF)");
  if (subs.valuation >= 7) out.push("Rendement FCF potentiellement attractif");
  if (subs.momentum >= 8) out.push("Cours au-dessus de la moyenne 200 jours et tendance récente positive");
  if (!out.length) out.push("Données limitées (mode gratuit) : vérifiez les détails");
  return out;
}
function detectRedFlags(_d: DataBundle) { return [] as string[]; }
function makeVerdict(d: DataBundle, subs: Record<string, number>, coverage: number) {
  const momentumOk =
    (typeof d.prices.px_vs_200dma.value === "number" && d.prices.px_vs_200dma.value >= 0) ||
    (typeof d.prices.ret_60d.value === "number" && d.prices.ret_60d.value > 0);
  const total = subs.quality + subs.safety + subs.valuation + subs.momentum;
  const score_adj = coverage > 0 ? Math.round((total / coverage) * 100) : 0;
  const coverageOk = coverage >= 40;
  if (score_adj >= 70 && coverageOk && momentumOk) return { verdict: "sain" as const, reason: "Score élevé et couverture suffisante" };
  if (score_adj >= 40 || momentumOk) return { verdict: "a_surveiller" as const, reason: "Signal positif mais incomplet" + (coverageOk ? "" : " (couverture limitée)") };
  return { verdict: "fragile" as const, reason: "Signal faible et données limitées" };
}

/* ======================================================================================
 *  FETCH HELPERS
 * ====================================================================================*/
async function fetchJsonSafe(url: string, headers?: Record<string, string>) {
  try { const r = await fetch(url, { headers }); if (!r.ok) return null; return await r.json(); } catch { return null; }
}
async function fetchTextSafe(url: string, accept = "*/*") {
  try { const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0", "Accept": accept } }); if (!r.ok) return null; return await r.text(); } catch { return null; }
}
