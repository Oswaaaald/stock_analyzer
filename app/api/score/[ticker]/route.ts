// Exécuter sur runtime Node.js
export const runtime = "nodejs";

import { NextResponse } from "next/server";

// --- Cache mémoire simple ---
const MEM: Record<string, { expires: number; data: any }> = {};
const TTL_MS = 30 * 60 * 1000; // 30 min

// Email de contact SEC (obligatoire dans User-Agent SEC). Mets le tien via ENV si possible.
const CONTACT_EMAIL = process.env.CONTACT_EMAIL || "contact@example.com";

type DataBundle = {
  ticker: string;
  fundamentals: {
    op_margin: number | null;             // operating margin (TTM/annual approx)
    current_ratio: number | null;         // current assets / current liabilities
    dilution_3y: number | null;           // variation des actions en 3 ans (ratio)
    fcf_positive_last4: number | null;    // nb d'années positives (0..4)
    fcf_yield: number | null;             // FCF / market cap approx
  };
  prices: {
    px: number | null;
    px_vs_200dma: number | null;
    rs_6m_vs_sector_percentile: number | null;
    eps_revisions_3m: number | null;
  };
};

type ScorePayload = {
  ticker: string;
  score: number;                 // score brut /100 (échelle officielle)
  score_adj?: number;            // score ajusté à la couverture (/coverage)
  color: "green" | "orange" | "red";
  reasons_positive: string[];
  red_flags: string[];
  subscores: Record<string, number>;
  coverage: number;              // points max “disponibles” (0..100)
  debug?: Record<string, any>;   // optionnel pour vérifier les inputs
};

export async function GET(
  _req: Request,
  { params }: { params: { ticker: string } }
) {
  const t = (params.ticker || "").toUpperCase().trim();
  if (!t) return NextResponse.json({ error: "Ticker requis" }, { status: 400 });

  const now = Date.now();
  const key = `score_${t}`;
  const hit = MEM[key];
  if (hit && hit.expires > now) return NextResponse.json(hit.data);

  try {
    // 1) Prix & 200DMA via Stooq (no-key)
    const stooq = await fetchFromStooq(t);

    // 2) Fundamentals via SEC (US & IFRS foreign filers), si possible
    const sec = await fetchFromSEC_US_IfPossible(t, stooq.px);

    const bundle: DataBundle = {
      ticker: t,
      fundamentals: sec.fundamentals,
      prices: {
        px: stooq.px,
        px_vs_200dma: stooq.px_vs_200dma,
        rs_6m_vs_sector_percentile: 0.5,
        eps_revisions_3m: 0,
      },
    };

    // ----- scoring (échelle officielle 0..100, pas de normalisation à 100) -----
    const { subscores, malus, maxes } = computeScore(bundle);

    const total =
      subscores.quality +
      subscores.safety +
      subscores.valuation +
      subscores.momentum;

    const raw = Math.max(0, Math.min(100, Math.round(total) - malus)); // /100
    const coverage =
      maxes.quality + maxes.safety + maxes.valuation + maxes.momentum; // 0..100

    const score_adj =
      coverage > 0 ? Math.round((total / coverage) * 100) : 0; // pour affichage optionnel

    const color: ScorePayload["color"] =
      raw >= 70 ? "green" : raw >= 50 ? "orange" : "red";

    const reasons = buildReasons(bundle, subscores);
    const flags = detectRedFlags(bundle);

    const payload: ScorePayload = {
      ticker: t,
      score: raw,
      score_adj,
      color,
      reasons_positive: reasons.slice(0, 3),
      red_flags: flags.slice(0, 2),
      subscores,
      coverage: Math.max(0, Math.min(100, Math.round(coverage))),
      // debug: { ...bundle.fundamentals, px_vs_200dma: bundle.prices.px_vs_200dma }, // <- décommente pour debug
    };

    MEM[key] = { expires: now + TTL_MS, data: payload };
    return NextResponse.json(payload, {
      headers: { "Cache-Control": "s-maxage=600, stale-while-revalidate=1200" },
    });
  } catch (e: any) {
    const msg = typeof e?.message === "string" ? e.message : (e?.toString?.() || "Erreur provider");
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

/* ============================ STQOOQ (prix + 200DMA) ============================ */

async function fetchFromStooq(ticker: string): Promise<{ px: number | null; px_vs_200dma: number | null; }> {
  const candidates = makeStooqCandidates(ticker);
  let closes: number[] | null = null;

  for (const sym of candidates) {
    try {
      const csv = await fetchCsv(`https://stooq.com/q/d/l/?s=${encodeURIComponent(sym)}&i=d`);
      const parsed = parseStooqCsv(csv);
      if (parsed.closes.length > 0) { closes = parsed.closes; break; }
    } catch {}
  }
  if (!closes || closes.length === 0) {
    throw new Error(`Aucune donnée Stooq pour ${ticker} (essais: ${candidates.join(", ")})`);
  }

  const px = closes.at(-1) ?? null;
  let px_vs_200dma: number | null = null;
  if (closes.length >= 200 && typeof px === "number") {
    const avg = closes.slice(-200).reduce((a,b)=>a+b,0)/200;
    if (avg) px_vs_200dma = (px - avg)/avg;
  }
  return { px, px_vs_200dma };
}

function makeStooqCandidates(ticker: string): string[] {
  const t = ticker.toLowerCase();
  const out = new Set<string>();
  out.add(t);
  out.add(`${t}.us`);
  out.add(`${t.replace(/\./g, "-")}.us`);
  out.add(t.replace(/\./g, "-"));
  if (/\.[a-z]{2,3}$/.test(t)) out.add(t);
  return Array.from(out);
}

async function fetchCsv(url: string): Promise<string> {
  const r = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; StockAnalyzer/1.0)",
      "Accept": "text/csv, text/plain, */*",
      "Cache-Control": "no-cache",
    },
  });
  if (!r.ok) throw new Error(`HTTP ${r.status} on ${url}`);
  return r.text();
}

function parseStooqCsv(csv: string): { dates: string[]; closes: number[] } {
  const lines = csv.trim().split(/\r?\\n/);
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

/* ============================ SEC EDGAR (US + IFRS) ============================ */

let TICKER_MAP: Record<string, { cik_str: number; ticker: string; title: string }> = {};
let TICKER_MAP_EXP = 0;

async function loadTickerMap(): Promise<Record<string, { cik_str: number; ticker: string; title: string }>> {
  const now = Date.now();
  if (Object.keys(TICKER_MAP).length && TICKER_MAP_EXP > now) return TICKER_MAP;

  const url = "https://www.sec.gov/files/company_tickers.json";
  const res = await fetch(url, {
    headers: { "User-Agent": `StockAnalyzer/1.0 (${CONTACT_EMAIL})`, "Accept": "application/json" }
  });
  if (!res.ok) return TICKER_MAP; // renvoie l'existant (évent. vide) pour éviter null
  const js = await res.json();
  const map: Record<string, { cik_str: number; ticker: string; title: string }> = {};
  Object.values(js as any).forEach((row: any) => {
    map[String(row.ticker).toUpperCase()] = { cik_str: row.cik_str, ticker: row.ticker, title: row.title };
  });
  TICKER_MAP = map;
  TICKER_MAP_EXP = now + 24*60*60*1000; // 24h
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
  const fund = {
    op_margin: null as number | null,
    current_ratio: null as number | null,
    dilution_3y: null as number | null,
    fcf_positive_last4: null as number | null,
    fcf_yield: null as number | null,
  };

  // map ticker -> CIK
  let cik: string | null = null;
  try {
    const tickerMap = await loadTickerMap();
    const hit = tickerMap[ticker.toUpperCase()];
    if (hit) cik = String(hit.cik_str).padStart(10, "0");
  } catch { /* ignore */ }

  if (!cik) return { fundamentals: fund }; // pas dans le mapping SEC

  // companyfacts
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
  } catch {
    return { fundamentals: fund };
  }

  // Revenue & Operating Income -> Operating Margin (TTM approx si possible)
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

  if (typeof rev === "number" && rev !== 0 && typeof op === "number") {
    fund.op_margin = op / rev;
  }

  // Current ratio
  const caUSD = usgaap.AssetsCurrent?.units?.USD;
  const clUSD = usgaap.LiabilitiesCurrent?.units?.USD;
  const caIFR = ifrs.CurrentAssets?.units?.USD;
  const clIFR = ifrs.CurrentLiabilities?.units?.USD;

  const ca = lastNum(caUSD) ?? lastNum(caIFR);
  const cl = lastNum(clUSD) ?? lastNum(clIFR);
  if (typeof ca === "number" && typeof cl === "number" && cl !== 0) {
    fund.current_ratio = ca / cl;
  }

  // Dilution 3 ans (shares)
  const shUSD = usgaap.CommonStockSharesOutstanding?.units?.shares
             || usgaap.EntityCommonStockSharesOutstanding?.units?.shares;
  const shIFR = ifrs.NumberOfSharesOutstanding?.units?.shares
             || ifrs.WeightedAverageNumberOfOrdinarySharesOutstandingDiluted?.units?.shares;

  const sharesArr = shUSD || shIFR;
  if (Array.isArray(sharesArr) && sharesArr.length >= 2) {
    const last = sharesArr.at(-1)?.val;
    const i0   = Math.max(0, sharesArr.length - 13); // ~3 ans (trimestriel)
    const prev = sharesArr[i0]?.val;
    if (typeof last === "number" && typeof prev === "number" && prev > 0) {
      fund.dilution_3y = (last - prev) / prev;
    }
  }

  // FCF (CFO - CapEx), positif sur 4 dernières périodes & FCF yield
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

  // FCF yield ≈ (dernier CFO - |dernier CapEx|) / MarketCap (price × shares)
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

  // Qualité (max 35) — on ne score que ce qu’on a
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
