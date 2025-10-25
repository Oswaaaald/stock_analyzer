// Exécuter sur runtime Node.js
export const runtime = "nodejs";

import { NextResponse } from "next/server";

// --- Cache mémoire simple ---
const MEM: Record<string, { expires: number; data: any }> = {};
const TTL_MS = 30 * 60 * 1000; // 30 min

// Email SEC (facultatif, recommandé). Ajoute CONTACT_EMAIL dans Vercel si tu veux.
const CONTACT_EMAIL = process.env.CONTACT_EMAIL || "contact@example.com";

/* ============================ Types ============================ */

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
  rs_6m_vs_sector_percentile: number | null; // placeholder
  eps_revisions_3m: number | null;           // placeholder

  // métadonnées prix (optionnelles)
  __source?: "yahoo" | "stooq.com" | "stooq.pl";
  __points?: number; // nombre de clôtures utilisées
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
    // 1) Prix (monde entier) → Yahoo Chart → Stooq .com → Stooq .pl
    const pricesAny = await fetchPricesAny(t);

    // 2) Fondamentaux via SEC (US + foreign filers IFRS) si dispo
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

    // 4) Verdict simple (lisible en 2 secondes) — basé sur score ajusté + couverture
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
        sec_used: bundle.fundamentals.__taxonomies,
        sec_note: bundle.fundamentals.__note ?? null,
      },
      // Décommente pour diagnostiquer
      // debug: {
      //   ...bundle.fundamentals,
      //   px_vs_200dma: bundle.prices.px_vs_200dma,
      //   ret_20d: bundle.prices.ret_20d,
      //   pct_52w: bundle.prices.pct_52w,
      // }
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

/* ============================ AGRÉGATEUR PRIX (monde entier) ============================ */

async function fetchPricesAny(ticker: string): Promise<Prices> {
  // 1) Yahoo Chart
  try {
    const y = await fetchYahooChartCloses(ticker);
    if (y && y.length) {
      const enriched = enrichCloses(y);
      enriched.__source = "yahoo";
      enriched.__points = y.length;
      return enriched;
    }
  } catch {}

  // 2) Stooq (.com)
  try {
    const closes = await fetchStooqCloses(ticker, "https://stooq.com");
    if (closes && closes.length) {
      const enriched = enrichCloses(closes);
      enriched.__source = "stooq.com";
      enriched.__points = closes.length;
      return enriched;
    }
  } catch {}

  // 3) Stooq (.pl)
  try {
    const closes = await fetchStooqCloses(ticker, "https://stooq.pl");
    if (closes && closes.length) {
      const enriched = enrichCloses(closes);
      enriched.__source = "stooq.pl";
      enriched.__points = closes.length;
      return enriched;
    }
  } catch {}

  throw new Error(`Aucune donnée de prix pour ${ticker} (Yahoo+Stooq échecs)`);
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

  // 20d return
  let ret_20d: number | null = null;
  if (closes.length >= 21) {
    const prev = closes[closes.length - 21];
    if (typeof prev === "number" && prev > 0 && typeof px === "number") {
      ret_20d = px / prev - 1;
    }
  }

  return {
    px,
    px_vs_200dma,
    pct_52w,
    max_dd_1y,
    ret_20d,
    rs_6m_vs_sector_percentile: 0.5, // placeholder
    eps_revisions_3m: 0,              // placeholder
  };
}

// ---------- Yahoo Chart ----------
async function fetchYahooChartCloses(ticker: string): Promise<number[] | null> {
  const headers = {
    "User-Agent": "Mozilla/5.0 (compatible; StockAnalyzer/1.0)",
    "Accept": "application/json, text/plain, */*",
  };
  let js = await fetchJsonSafe(
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=2y&interval=1d`,
    headers
  );
  if (!js) {
    js = await fetchJsonSafe(
      `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=2y&interval=1d`,
      headers
    );
  }
  if (!js) return null;
  const res = js?.chart?.result?.[0];
  if (!res) return null;
  const closes: number[] = (res?.indicators?.quote?.[0]?.close || []) as number[];
  const adj: number[] = (res?.indicators?.adjclose?.[0]?.adjclose || []) as number[];
  const arr = (closes?.filter(n => typeof n === "number")?.length ? closes : adj) || [];
  return arr.filter((n) => typeof n === "number" && Number.isFinite(n));
}
async function fetchJsonSafe(url: string, headers: Record<string, string>) {
  try { const r = await fetch(url, { headers }); if (!r.ok) return null; return await r.json(); }
  catch { return null; }
}

// ---------- Stooq ----------
async function fetchStooqCloses(ticker: string, origin: "https://stooq.com" | "https://stooq.pl") {
  const candidates = makeStooqCandidates(ticker);
  for (const sym of candidates) {
    const urlDaily = `${origin}/q/d/l/?s=${encodeURIComponent(sym)}&i=d`;
    const csvDaily = await fetchCsvSafe(urlDaily);
    const parsedDaily = csvDaily ? parseStooqCsv(csvDaily) : null;
    if (parsedDaily?.closes?.length) return parsedDaily.closes;

    const urlSnap = `${origin}/q/l/?s=${encodeURIComponent(sym)}&f=sd2t2ohlcv&h&e=csv`;
    const csvSnap = await fetchCsvSafe(urlSnap);
    const parsedSnap = csvSnap ? parseStooqLiteCsv(csvSnap) : null;
    if (parsedSnap?.closes?.length) return parsedSnap.closes;
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
function parseStooqCsv(csv: string): { dates: string[]; closes: number[] } {
  const lines = csv.trim().split(/\r?\n/);
  if (lines.length <= 1) return { dates: [], closes: [] };
  const header = lines[0].split(",");
  const idxDate = header.indexOf("Date");
  const idxClose = header.indexOf("Close");
  const dates: string[] = [];
  const closes: number[] = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(",");
    const d = parts[idxDate];
    const c = parseFloat(parts[idxClose]);
    if (d && Number.isFinite(c)) { dates.push(d); closes.push(c); }
  }
  return { dates, closes };
}
function parseStooqLiteCsv(csv: string): { dates: string[]; closes: number[] } {
  const lines = csv.trim().split(/\r?\n/);
  if (lines.length <= 1) return { dates: [], closes: [] };
  const dates: string[] = [];
  const closes: number[] = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(",");
    const d = parts[1];
    const c = parseFloat(parts[6]);
    if (d && Number.isFinite(c)) { dates.push(d); closes.push(c); }
  }
  return { dates, closes };
}

/* ============================ SEC EDGAR (US + IFRS foreign filers) ============================ */

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

type FactUnits = { [unit: string]: Array<{ val: number; fy?: string; fp?: string; end?: string }> };
type Taxo = { [tag: string]: { units: FactUnits } };

function lastNum(arr?: any[], prop: string = "val") {
  return Array.isArray(arr) && arr.length ? (arr[arr.length - 1]?.[prop] ?? null) : null;
}
function sumLastN(arr?: any[], n = 4) {
  if (!Array.isArray(arr) || !arr.length) return null;
  let s = 0, c = 0;
  for (let i = arr.length - 1; i >= 0 && c < n; i--, c++) {
    const v = arr[i]?.val; if (typeof v !== "number") return null;
    s += v;
  }
  return c === n ? s : null;
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
    fund.__note = "TTM si disponible, sinon dernière période disponible";
  } catch {
    return { fundamentals: fund };
  }

  // Operating margin (TTM si possible)
  const revUSD  = usgaap.RevenueFromContractWithCustomerExcludingAssessedTax?.units?.USD
               || usgaap.Revenues?.units?.USD;
  const opUSD   = usgaap.OperatingIncomeLoss?.units?.USD;
  const revIFRS = ifrs.Revenue?.units?.USD
               || ifrs.RevenueFromContractsWithCustomersExcludingAssessedTax?.units?.USD;
  const opIFRS  = ifrs.OperatingProfitLoss?.units?.USD
               || ifrs.ProfitLossFromOperatingActivities?.units?.USD;

  const revTTM = sumLastN(revUSD, 4) ?? sumLastN(revIFRS, 4);
  const opTTM  = sumLastN(opUSD, 4)  ?? sumLastN(opIFRS, 4);
  const revLast = lastNum(revUSD) ?? lastNum(revIFRS);
  const opLast  = lastNum(opUSD)  ?? lastNum(opIFRS);

  const rev = (typeof revTTM === "number" ? revTTM : revLast);
  const op  = (typeof opTTM  === "number" ? opTTM  : opLast);
  if (typeof rev === "number" && rev !== 0 && typeof op === "number") fund.op_margin = op / rev;

  // Current ratio
  const caUSD = usgaap.AssetsCurrent?.units?.USD;
  const clUSD = usgaap.LiabilitiesCurrent?.units?.USD;
  const caIFR = ifrs.CurrentAssets?.units?.USD;
  const clIFR = ifrs.CurrentLiabilities?.units?.USD;
  const ca = lastNum(caUSD) ?? lastNum(caIFR);
  const cl = lastNum(clUSD) ?? lastNum(clIFR);
  if (typeof ca === "number" && typeof cl === "number" && cl !== 0) fund.current_ratio = ca / cl;

  // Dilution 3 ans
  const shUSD = usgaap.CommonStockSharesOutstanding?.units?.shares
             || usgaap.EntityCommonStockSharesOutstanding?.units?.shares;
  const shIFR = ifrs.NumberOfSharesOutstanding?.units?.shares
             || ifrs.WeightedAverageNumberOfOrdinarySharesOutstandingDiluted?.units?.shares;
  const sharesArr = shUSD || shIFR;
  if (Array.isArray(sharesArr) && sharesArr.length >= 2) {
    const last = sharesArr.at(-1)?.val;
    const i0 = Math.max(0, sharesArr.length - 13);
    const prev = sharesArr[i0]?.val;
    if (typeof last === "number" && typeof prev === "number" && prev > 0) {
      fund.dilution_3y = (last - prev) / prev;
    }
  }

  // FCF + FCF yield
  const cfoUSD = usgaap.NetCashProvidedByUsedInOperatingActivities?.units?.USD
              || usgaap.NetCashProvidedByUsedInOperatingActivitiesContinuingOperations?.units?.USD;
  const cfoIFR = ifrs.CashFlowsFromUsedInOperatingActivities?.units?.USD
              || ifrs.CashFlowsFromUsedInOperations?.units?.USD;
  const capexUSD = usgaap.PaymentsToAcquireProductiveAssets?.units?.USD
                || usgaap.PurchasesOfPropertyPlantAndEquipment?.units?.USD;
  const capexIFR = ifrs.PurchaseOfPropertyPlantAndEquipment?.units?.USD
                || ifrs.AdditionsToPropertyPlantAndEquipment?.units?.USD;

  const cfoArr = cfoUSD || cfoIFR;
  const capArr = capexUSD || capexIFR;

  if (Array.isArray(cfoArr) && Array.isArray(capArr)) {
    const n = Math.min(4, Math.min(cfoArr.length, capArr.length));
    let countPos = 0;
    for (let i = 1; i <= n; i++) {
      const cfo = cfoArr[cfoArr.length - i]?.val;
      const cap = capArr[capArr.length - i]?.val;
      if (typeof cfo === "number" && typeof cap === "number") {
        const fcf = cfo - Math.abs(cap);
        if (fcf > 0) countPos++;
      }
    }
    fund.fcf_positive_last4 = countPos;
  }

  const lastCFO = lastNum(cfoArr);
  const lastCap = lastNum(capArr);
  const shLast  = Array.isArray(sharesArr) && sharesArr.length ? sharesArr.at(-1)?.val : null;
  if (typeof lastPrice === "number" && typeof shLast === "number" && shLast > 0) {
    const mcap = lastPrice * shLast;
    if (typeof lastCFO === "number" && typeof lastCap === "number" && mcap > 0) {
      const fcf = lastCFO - Math.abs(lastCap);
      fund.fcf_yield = fcf / mcap;
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
    mMax = 15;
    m = p.px_vs_200dma >= 0.05 ? 15 : p.px_vs_200dma > -0.05 ? 8 : 3;
  }

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
  if (subs.momentum >= 8) reasons.push("Cours au-dessus de la moyenne 200 jours");
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
  // momentum ok si px > 200DMA ou ret_20d > 0
  const momOK =
    (typeof d.prices.px_vs_200dma === "number" && d.prices.px_vs_200dma >= 0) ||
    (typeof d.prices.ret_20d === "number" && d.prices.ret_20d > 0);

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
