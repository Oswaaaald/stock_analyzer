// Exécuter sur runtime Node.js
export const runtime = "nodejs";

import { NextResponse } from "next/server";

// --- Cache mémoire simple ---
const MEM: Record<string, { expires: number; data: any }> = {};
const TTL_MS = 30 * 60 * 1000; // 30 min

// Email SEC (facultatif, recommandé). Ajoute CONTACT_EMAIL dans Vercel si tu veux.
const CONTACT_EMAIL = process.env.CONTACT_EMAIL || "contact@example.com";

/* ============================ Types ============================ */

type FactPoint = { val: number; fy?: string; fp?: string; end?: string };
type FactUnits = { [unit: string]: FactPoint[] };
type Taxo = { [tag: string]: { units: FactUnits } };

type Fundamentals = {
  op_margin: number | null;
  current_ratio: number | null;
  dilution_3y: number | null;
  fcf_positive_last4: number | null;
  fcf_yield: number | null;

  // métadonnées SEC (optionnelles)
  __taxonomies?: string[]; // ex: ["us-gaap","ifrs-full"]
  __note?: string;
};

type Prices = {
  px: number | null;
  px_vs_200dma: number | null;
  pct_52w: number | null;       // position entre plus bas/plus haut 52 semaines (0..1)
  max_dd_1y: number | null;     // max drawdown sur 1 an (négatif)
  ret_20d: number | null;       // performance 20 jours
  ret_60d: number | null;       // performance 60 jours
  rs_6m_vs_sector_percentile: number | null; // placeholder
  eps_revisions_3m: number | null;           // placeholder

  // métadonnées prix (optionnelles)
  __source?: "yahoo" | "stooq.com" | "stooq.pl";
  __points?: number; // nombre de clôtures utilisées
  __recencyDays?: number; // fraicheur
};

type DataBundle = { ticker: string; fundamentals: Fundamentals; prices: Prices };

type ScorePayload = {
  ticker: string;
  score: number;                 // /100 officiel (35+25+25+15)
  score_adj?: number;            // /coverage (optionnel)
  color: "green" | "orange" | "red";
  reasons_positive: string[];
  red_flags: string[];
  subscores: Record<string, number>;
  coverage: number;              // points max effectivement disponibles (0..100)
  verdict: "sain" | "a_surveiller" | "fragile";
  verdict_reason: string;

  // preuves / traçabilité
  proof?: {
    price_source?: Prices["__source"];
    price_points?: number;
    price_has_200dma: boolean;
    price_recency_days?: number | null;
    sec_used?: string[]; // taxonomies
    sec_note?: string | null;
  };

  // debug optionnel
  debug?: Record<string, any>;
};

/* ============================ Handler ============================ */

export async function GET(
  _req: Request,
  { params }: { params: { ticker: string } }
) {
  const t = (params.ticker || "").toUpperCase().trim();
  if (!t) return NextResponse.json({ error: "Ticker requis" }, { status: 400 });

  const now = Date.now();
  const cacheKey = `score_${t}`;
  const hit = MEM[cacheKey];
  if (hit && hit.expires > now) return NextResponse.json(hit.data);

  try {
    // 1) Prix (monde entier) → Yahoo Chart → Stooq .com → Stooq .pl (on retient la meilleure source)
    const pricesAny = await fetchPricesBestOf(t);

    // 2) Fondamentaux via SEC (US + foreign filers IFRS) si dispo (avec giga fallback de tags)
    const sec = await fetchFromSEC_US_IfPossible(t, pricesAny.px);

    const bundle: DataBundle = {
      ticker: t,
      fundamentals: sec.fundamentals,
      prices: pricesAny,
    };

    // 3) Score officiel + couverture
    const { subscores, malus, maxes } = computeScore(bundle);
    const total =
      subscores.quality +
      subscores.safety +
      subscores.valuation +
      subscores.momentum;

    const raw = Math.max(0, Math.min(100, Math.round(total) - malus));
    const coverage =
      maxes.quality + maxes.safety + maxes.valuation + maxes.momentum; // 0..100
    const score_adj = coverage > 0 ? Math.round((total / coverage) * 100) : 0;

    const color: ScorePayload["color"] =
      raw >= 70 ? "green" : raw >= 50 ? "orange" : "red";

    const reasons = buildReasons(bundle, subscores);
    const flags = detectRedFlags(bundle);

    // 4) Verdict simple — basé sur score ajusté + couverture + momentum
    const { verdict, reason } = makeVerdict(bundle, subscores, coverage);

    const payload: ScorePayload = {
      ticker: t,
      score: raw,
      score_adj,
      color,
      reasons_positive: reasons.slice(0, 3),
      red_flags: flags.slice(0, 2),
      subscores,
      coverage: Math.max(0, Math.min(100, Math.round(coverage))),
      verdict,
      verdict_reason: reason,
      proof: {
        price_source: pricesAny.__source,
        price_points: pricesAny.__points,
        price_has_200dma: bundle.prices.px_vs_200dma !== null,
        price_recency_days: pricesAny.__recencyDays ?? null,
        sec_used: bundle.fundamentals.__taxonomies,
        sec_note: bundle.fundamentals.__note ?? null,
      },
      // debug: { ...bundle.fundamentals, ...bundle.prices }
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

/* ============================ PRIX : multi-sources + reconciliation ============================ */

type OHLCFeed = { dates: number[]; closes: number[]; source: Prices["__source"] };

async function fetchPricesBestOf(ticker: string): Promise<Prices> {
  const feeds: OHLCFeed[] = [];
  try { const y = await fetchYahooChart(ticker); if (y) feeds.push(y); } catch {}
  try { const s1 = await fetchStooq(ticker, "https://stooq.com"); if (s1) feeds.push(s1); } catch {}
  try { const s2 = await fetchStooq(ticker, "https://stooq.pl"); if (s2) feeds.push(s2); } catch {}

  if (!feeds.length) throw new Error(`Aucune donnée de prix pour ${ticker} (Yahoo+Stooq échecs)`);

  // Choix de la meilleure source : la plus récente, sinon la plus dense
  feeds.sort((a, b) => {
    const recA = (a.dates?.[a.dates.length - 1] ?? 0);
    const recB = (b.dates?.[b.dates.length - 1] ?? 0);
    if (recA !== recB) return recB - recA;
    return (b.closes.length - a.closes.length);
  });
  const best = feeds[0];

  const enriched = enrichCloses(best.closes);
  enriched.__source = best.source;
  enriched.__points = best.closes.length;
  enriched.__recencyDays = Math.round((Date.now() - best.dates[best.dates.length - 1]) / (1000 * 3600 * 24));
  return enriched;
}

// Yahoo (dates + closes)
async function fetchYahooChart(ticker: string): Promise<OHLCFeed | null> {
  const headers = {
    "User-Agent": "Mozilla/5.0 (compatible; StockAnalyzer/1.0)",
    "Accept": "application/json, text/plain, */*",
  };
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
    const raw = (closes?.filter(n => typeof n === "number")?.length ? closes : adj) || [];
    const arr = raw.filter((n) => typeof n === "number" && Number.isFinite(n));
    if (arr.length) return { dates: ts.slice(-arr.length), closes: arr, source: "yahoo" };
  }
  return null;
}

// --- Helper JSON safe (AJOUTÉ) ---
async function fetchJsonSafe(url: string, headers: Record<string, string>) {
  try {
    const r = await fetch(url, { headers });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

// Stooq (CSV -> dates + closes)
async function fetchStooq(ticker: string, origin: "https://stooq.com" | "https://stooq.pl"): Promise<OHLCFeed | null> {
  const candidates = makeStooqCandidates(ticker);
  for (const sym of candidates) {
    const urlDaily = `${origin}/q/d/l/?s=${encodeURIComponent(sym)}&i=d`;
    const csvDaily = await fetchCsvSafe(urlDaily);
    const parsedDaily = csvDaily ? parseStooqCsv(csvDaily) : null;
    if (parsedDaily?.closes?.length) return { ...parsedDaily, source: origin.endsWith(".pl") ? "stooq.pl" : "stooq.com" };

    const urlSnap = `${origin}/q/l/?s=${encodeURIComponent(sym)}&f=sd2t2ohlcv&h&e=csv`;
    const csvSnap = await fetchCsvSafe(urlSnap);
    const parsedSnap = csvSnap ? parseStooqLiteCsv(csvSnap) : null;
    if (parsedSnap?.closes?.length) return { ...parsedSnap, source: origin.endsWith(".pl") ? "stooq.pl" : "stooq.com" };
  }
  return null;
}
function makeStooqCandidates(ticker: string): string[] {
  const t = ticker.toLowerCase();
  const out = new Set<string>();
  out.add(t);
  out.add(`${t}.us`);
  out.add(t.replace(/\./g, "-"));
  out.add(`${t.replace(/\./g, "-")}.us`);
  if (/\.[a-z]{2,3}$/.test(t)) out.add(t);
  return Array.from(out);
}
async function fetchCsvSafe(url: string): Promise<string | null> {
  try {
    const r = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; StockAnalyzer/1.0)",
        "Accept": "text/csv, text/plain, */*",
        "Cache-Control": "no-cache",
      },
    });
    if (!r.ok) return null;
    return await r.text();
  } catch { return null; }
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
    if (d && Number.isFinite(c)) {
      dates.push(new Date(d).getTime());
      closes.push(c);
    }
  }
  return { dates, closes };
}
function parseStooqLiteCsv(csv: string): { dates: number[]; closes: number[] } {
  const lines = csv.trim().split(/\r?\n/);
  if (lines.length <= 1) return { dates: [], closes: [] };
  const dates: number[] = [];
  const closes: number[] = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(",");
    const d = parts[1];
    const c = parseFloat(parts[6]);
    if (d && Number.isFinite(c)) {
      dates.push(new Date(d).getTime());
      closes.push(c);
    }
  }
  return { dates, closes };
}

function enrichCloses(closes: number[]): Prices {
  // ✅ Garde-fou : besoin d'au moins ~6 mois de données pour juger le momentum
  if (!Array.isArray(closes) || closes.filter(Number.isFinite).length < 120) {
    return {
      px: closes.at(-1) ?? null,
      px_vs_200dma: null,
      pct_52w: null,
      max_dd_1y: null,
      ret_20d: null,
      ret_60d: null,
      rs_6m_vs_sector_percentile: null,
      eps_revisions_3m: null,
    };
  }

  const px = closes.at(-1) ?? null;

  // 200DMA
  let px_vs_200dma: number | null = null;
  if (closes.length >= 200 && typeof px === "number") {
    const avg = closes.slice(-200).reduce((a, b) => a + b, 0) / 200;
    if (avg) px_vs_200dma = (px - avg) / avg;
  }

  // 52w stats
  const last252 = closes.slice(-252); // ~252 séances = 1 an
  let pct_52w: number | null = null;
  let max_dd_1y: number | null = null;
  if (last252.length >= 30 && typeof px === "number") {
    const hi = Math.max(...last252);
    const lo = Math.min(...last252);
    if (hi > lo) pct_52w = (px - lo) / (hi - lo); // 0..1
    // max drawdown
    let peak = last252[0];
    let mdd = 0;
    for (const c of last252) {
      peak = Math.max(peak, c);
      mdd = Math.min(mdd, (c - peak) / peak);
    }
    max_dd_1y = mdd; // négatif
  }

  // 20d & 60d return
  let ret_20d: number | null = null;
  let ret_60d: number | null = null;
  if (closes.length >= 21 && typeof px === "number") {
    const prev20 = closes[closes.length - 21];
    if (typeof prev20 === "number" && prev20 > 0) ret_20d = px / prev20 - 1;
  }
  if (closes.length >= 61 && typeof px === "number") {
    const prev60 = closes[closes.length - 61];
    if (typeof prev60 === "number" && prev60 > 0) ret_60d = px / prev60 - 1;
  }

  return {
    px,
    px_vs_200dma,
    pct_52w,
    max_dd_1y,
    ret_20d,
    ret_60d,
    rs_6m_vs_sector_percentile: 0.5, // placeholder
    eps_revisions_3m: 0,              // placeholder
  };
}

/* ============================ SEC EDGAR (US + IFRS) : giga fallback ============================ */

let TICKER_MAP: Record<string, { cik_str: number; ticker: string; title: string }> = {};
let TICKER_MAP_EXP = 0;

async function loadTickerMap(): Promise<Record<string, { cik_str: number; ticker: string; title: string }>> {
  const now = Date.now();
  if (Object.keys(TICKER_MAP).length && TICKER_MAP_EXP > now) return TICKER_MAP;

  const url = "https://www.sec.gov/files/company_tickers.json";
  const res = await fetch(url, {
    headers: { "User-Agent": `StockAnalyzer/1.0 (${CONTACT_EMAIL})`, "Accept": "application/json" }
  });
  if (!res.ok) return TICKER_MAP;
  const js = await res.json();
  const map: Record<string, { cik_str: number; ticker: string; title: string }> = {};
  Object.values(js as any).forEach((row: any) => {
    map[String(row.ticker).toUpperCase()] = { cik_str: row.cik_str, ticker: row.ticker, title: row.title };
  });
  TICKER_MAP = map;
  TICKER_MAP_EXP = now + 24*60*60*1000;
  return TICKER_MAP;
}

function parseEndDate(s?: string): number {
  if (!s) return 0;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : 0;
}

function pickBestUnit(units?: FactUnits, preferUSD = true): FactPoint[] | null {
  if (!units) return null;
  if (preferUSD && units.USD && units.USD.length) return sortByEnd(units.USD);
  // sinon choisir l’unité avec le plus de points numériques
  let best: FactPoint[] | null = null;
  for (const [u, arr] of Object.entries(units)) {
    const valid = Array.isArray(arr) ? arr.filter(p => typeof p?.val === "number") : [];
    if (!valid.length) continue;
    if (!best || valid.length > best.length) best = valid;
  }
  return best ? sortByEnd(best) : null;
}

function sortByEnd(arr: FactPoint[]): FactPoint[] {
  return [...arr].sort((a, b) => parseEndDate(a.end) - parseEndDate(b.end));
}

function lastVal(arr?: FactPoint[]) {
  return (arr && arr.length) ? arr[arr.length - 1].val ?? null : null;
}

function sumLastNQuarterly(arr?: FactPoint[], n = 4) {
  if (!arr || !arr.length) return null;
  const q = arr.filter(p => (p.fp || "").toUpperCase().startsWith("Q"));
  if (q.length < n) return null;
  let s = 0;
  for (let i = q.length - n; i < q.length; i++) {
    const v = q[i]?.val;
    if (typeof v !== "number") return null;
    s += v;
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
    op_margin: null,
    current_ratio: null,
    dilution_3y: null,
    fcf_positive_last4: null,
    fcf_yield: null,
  };

  let cik: string | null = null;
  try {
    const tickerMap = await loadTickerMap();
    const hit = tickerMap[ticker.toUpperCase()];
    if (hit) cik = String(hit.cik_str).padStart(10, "0");
  } catch {}

  if (!cik) return { fundamentals: fund }; // pas US/ADR listé à la SEC

  let usgaap: Taxo = {}, ifrs: Taxo = {};
  try {
    const factsUrl = `https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`;
    const r = await fetch(factsUrl, {
      headers: { "User-Agent": `StockAnalyzer/1.0 (${CONTACT_EMAIL})`, "Accept": "application/json" }
    });
    if (!r.ok) throw new Error(`SEC facts HTTP ${r.status}`);
    const facts = await r.json();
    usgaap = (facts?.facts?.["us-gaap"] as Taxo) || {};
    ifrs   = (facts?.facts?.["ifrs-full"] as Taxo) || {};

    // métadonnées
    fund.__taxonomies = [
      Object.keys(usgaap).length ? "us-gaap" : null,
      Object.keys(ifrs).length ? "ifrs-full" : null,
    ].filter(Boolean) as string[];
    fund.__note = "TTM si disponible (somme Q), sinon dernier annuel.";
  } catch {
    return { fundamentals: fund };
  }

  // ----- Revenue & Operating Income (giga-fallback)
  const revCandidates = [
    usgaap.RevenueFromContractWithCustomerExcludingAssessedTax?.units,
    usgaap.Revenues?.units,
    ifrs.Revenue?.units,
    ifrs.RevenueFromContractsWithCustomersExcludingAssessedTax?.units,
  ];
  const opIncCandidates = [
    usgaap.OperatingIncomeLoss?.units,
    ifrs.OperatingProfitLoss?.units,
    ifrs.ProfitLossFromOperatingActivities?.units,
  ];

  const revSeries = pickBestUnit(revCandidates.find(Boolean) as FactUnits | undefined);
  const opSeries  = pickBestUnit(opIncCandidates.find(Boolean) as FactUnits | undefined);

  const revTTM = sumLastNQuarterly(revSeries, 4) ?? lastAnnual(revSeries);
  const opTTM  = sumLastNQuarterly(opSeries, 4) ?? lastAnnual(opSeries);

  if (typeof revTTM === "number" && revTTM !== 0 && typeof opTTM === "number") {
    fund.op_margin = opTTM / revTTM;
  }

  // ----- Current ratio (CA / CL)
  const caSeries = pickBestUnit(
    (usgaap.AssetsCurrent?.units) ||
    (ifrs.CurrentAssets?.units)
  );
  const clSeries = pickBestUnit(
    (usgaap.LiabilitiesCurrent?.units) ||
    (ifrs.CurrentLiabilities?.units)
  );
  const caLast = lastVal(caSeries);
  const clLast = lastVal(clSeries);
  if (typeof caLast === "number" && typeof clLast === "number" && clLast !== 0) {
    fund.current_ratio = caLast / clLast;
  }

  // ----- Shares (dilution 3y) : liste élargie
  const sharesUnits =
    usgaap.CommonStockSharesOutstanding?.units ||
    usgaap.EntityCommonStockSharesOutstanding?.units ||
    ifrs.NumberOfSharesOutstanding?.units ||
    ifrs.WeightedAverageNumberOfOrdinarySharesOutstandingDiluted?.units ||
    ifrs.WeightedAverageNumberOfSharesOutstandingDiluted?.units;

  const sharesSeries = pickBestUnit(sharesUnits as FactUnits | undefined, false);
  if (sharesSeries && sharesSeries.length >= 2) {
    const last = sharesSeries.at(-1)!.val;
    // approx. 3y en arrière
    const idx = Math.max(0, sharesSeries.length - 13);
    const prev = sharesSeries[idx]?.val;
    if (typeof last === "number" && typeof prev === "number" && prev > 0) {
      fund.dilution_3y = (last - prev) / prev;
    }
  }

  // ----- CFO & CapEx (giga-fallback IFRS/USGAAP)
  const cfoCandidates = [
    usgaap.NetCashProvidedByUsedInOperatingActivities?.units,
    usgaap.NetCashProvidedByUsedInOperatingActivitiesContinuingOperations?.units,
    ifrs.CashFlowsFromUsedInOperatingActivities?.units,
    (ifrs as any).NetCashFromOperatingActivities?.units,
    (ifrs as any).CashFlowsFromOperationsBeforeChangesInWorkingCapital?.units,
  ];
  const capexCandidates = [
    usgaap.PaymentsToAcquireProductiveAssets?.units,
    usgaap.PurchasesOfPropertyPlantAndEquipment?.units,
    ifrs.PurchaseOfPropertyPlantAndEquipment?.units,
    (ifrs as any).AdditionsToPropertyPlantAndEquipment?.units,
    (ifrs as any).PaymentsForPropertyPlantAndEquipment?.units,
    (ifrs as any).CapitalExpenditureClassifiedByNature?.units,
  ];

  const cfoSeries = pickBestUnit(cfoCandidates.find(Boolean) as FactUnits | undefined);
  const capSeries = pickBestUnit(capexCandidates.find(Boolean) as FactUnits | undefined);

  // fcf_positive_last4
  if (cfoSeries && capSeries) {
    let countPos = 0;
    const cN = Math.min(4, cfoSeries.length);
    const kN = Math.min(4, capSeries.length);
    const n = Math.min(cN, kN);
    for (let i = 1; i <= n; i++) {
      const cfo = cfoSeries[cfoSeries.length - i]?.val;
      const cap = capSeries[capSeries.length - i]?.val;
      if (typeof cfo === "number" && typeof cap === "number") {
        const fcf = cfo - Math.abs(cap);
        if (fcf > 0) countPos++;
      }
    }
    fund.fcf_positive_last4 = countPos;
  }

  // FCF yield (TTM si dispo)
  const cfoTTM = sumLastNQuarterly(cfoSeries, 4) ?? lastAnnual(cfoSeries);
  const capTTM = sumLastNQuarterly(capSeries, 4) ?? lastAnnual(capSeries);
  if (typeof lastPrice === "number" && typeof cfoTTM === "number" && typeof capTTM === "number") {
    // market cap ~ price * latest shares
    const shLast = lastVal(sharesSeries);
    if (typeof shLast === "number" && shLast > 0) {
      const mcap = lastPrice * shLast;
      if (mcap > 0) {
        const fcf = cfoTTM - Math.abs(capTTM);
        fund.fcf_yield = fcf / mcap;
      }
    }
  }

  return { fundamentals: fund };
}

/* ============================ Scoring (0..100) ============================ */

function clip(x: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, x));
}

function computeScore(data: DataBundle) {
  const f = data.fundamentals;
  const p = data.prices;

  // Qualité (max 35) — on score ce qu’on a
  let q = 0, qMax = 0;
  if (typeof f.op_margin === "number") {
    qMax += 8;
    q += f.op_margin >= 0.25 ? 8 : f.op_margin >= 0.15 ? 6 : f.op_margin >= 0.05 ? 3 : 0;
  }

  // Sécurité (max 25)
  let s = 0, sMax = 0;
  if (typeof f.current_ratio === "number") {
    sMax += 4;
    s += f.current_ratio > 1.5 ? 4 : f.current_ratio >= 1 ? 2 : 0;
  }
  if (typeof f.dilution_3y === "number") {
    sMax += 3;
    const d = f.dilution_3y;
    s += d <= 0 ? 3 : d <= 0.05 ? 2 : d <= 0.15 ? 1 : 0;
  }
  if (typeof f.fcf_positive_last4 === "number") {
    sMax += 4;
    s += f.fcf_positive_last4 >= 3 ? 4 : 0;
  }

  // Valorisation (max 25)
  let v = 0, vMax = 0;
  if (typeof f.fcf_yield === "number") {
    vMax += 10;
    const y = f.fcf_yield;
    v += y > 0.06 ? 10 : y >= 0.04 ? 7 : y >= 0.02 ? 4 : 1;
  }

  // Momentum (max 15)
  let m = 0, mMax = 0;
  if (typeof p.px_vs_200dma === "number") {
    mMax = 10; // 200DMA (10/15)
    m += p.px_vs_200dma >= 0.05 ? 10 : p.px_vs_200dma > -0.05 ? 6 : 2;
  }
  if (typeof p.ret_20d === "number") {
    mMax += 3;
    m += p.ret_20d > 0.03 ? 3 : p.ret_20d > 0 ? 2 : 0;
  }
  if (typeof p.ret_60d === "number") {
    mMax += 2;
    m += p.ret_60d > 0.06 ? 2 : p.ret_60d > 0 ? 1 : 0;
  }
  // clip sur 15 au cas où plusieurs signaux s’accumulent
  m = Math.min(m, 15);
  mMax = 15;

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

function buildReasons(_data: DataBundle, subs: Record<string, number>) {
  const reasons: string[] = [];
  if (subs.quality >= 6) reasons.push("Marge opérationnelle décente");
  if (subs.safety >= 4) reasons.push("Bilans plutôt sains (ratio court terme / dilution / FCF)");
  if (subs.valuation >= 7) reasons.push("Rendement FCF potentiellement attractif");
  if (subs.momentum >= 8) reasons.push("Cours au-dessus de la moyenne 200 jours et tendance récente positive");
  if (!reasons.length) reasons.push("Données limitées (mode gratuit) : vérifiez les détails");
  return reasons;
}

function detectRedFlags(_data: DataBundle) {
  return [] as string[];
}

/* ============================ Verdict (basé sur score ajusté + couverture) ============================ */

function makeVerdict(
  d: DataBundle,
  subs: Record<string, number>,
  coverage: number
) {
  // momentum ok si px > 200DMA ou ret_60d > 0
  const momOK =
    (typeof d.prices.px_vs_200dma === "number" && d.prices.px_vs_200dma >= 0) ||
    (typeof d.prices.ret_60d === "number" && d.prices.ret_60d > 0);

  // re-calcul local du score ajusté à partir des sous-scores et de la couverture effective
  const total = subs.quality + subs.safety + subs.valuation + subs.momentum;
  const score_adj = coverage > 0 ? Math.round((total / coverage) * 100) : 0;
  const coverageOk = coverage >= 40; // mini pour dire "sain"

  if (score_adj >= 70 && coverageOk && momOK) {
    return { verdict: "sain" as const, reason: "Score élevé et couverture suffisante" };
  }
  if (score_adj >= 40 || momOK) {
    const covNote = coverage < 40 ? " (couverture limitée)" : "";
    return { verdict: "a_surveiller" as const, reason: "Signal positif mais incomplet" + covNote };
  }
  return { verdict: "fragile" as const, reason: "Signal faible et données limitées" };
}
