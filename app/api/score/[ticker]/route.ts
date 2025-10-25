// Exécuter sur runtime Node.js
export const runtime = "nodejs";

import { NextResponse } from "next/server";

// --- Cache mémoire simple ---
const MEM: Record<string, { expires: number; data: any }> = {};
const TTL_MS = 30 * 60 * 1000; // 30 min

// Email de contact SEC (obligatoire dans User-Agent). Mets le tien en ENV si possible.
const CONTACT_EMAIL = process.env.CONTACT_EMAIL || "contact@example.com";

type DataBundle = {
  ticker: string;
  fundamentals: {
    op_margin: number | null;             // operating margin (TTM approx)
    current_ratio: number | null;         // current assets / current liabilities
    dilution_3y: number | null;           // variation des actions en 3 ans (ratio)
    fcf_positive_last4: number | null;    // nb d'années (0..4)
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
  score: number;
  color: "green" | "orange" | "red";
  reasons_positive: string[];
  red_flags: string[];
  subscores: Record<string, number>;
  coverage: number; // points max effectifs (0..100)
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

    // 2) Fundamentals pour tickers US via SEC EDGAR (no-key, besoin d'un User-Agent)
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

    // ----- scoring (échelle officielle 0..100, pas de normalisation adaptative) -----
    const { subscores, malus, maxes } = computeScore(bundle);

    const total =
      subscores.quality +
      subscores.safety +
      subscores.valuation +
      subscores.momentum;

    const final = Math.max(0, Math.min(100, Math.round(total) - malus));
    const color: ScorePayload["color"] =
      final >= 70 ? "green" : final >= 50 ? "orange" : "red";

    const reasons = buildReasons(bundle, subscores);
    const flags = detectRedFlags(bundle);

    const coverage =
      maxes.quality + maxes.safety + maxes.valuation + maxes.momentum;

    const payload: ScorePayload = {
      ticker: t,
      score: final,
      color,
      reasons_positive: reasons.slice(0, 3),
      red_flags: flags.slice(0, 2),
      subscores,
      coverage: Math.max(0, Math.min(100, Math.round(coverage))),
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

/* ============================ SEC EDGAR (fondamentaux US) ============================ */
/* Aucune clé, mais la SEC exige un User-Agent avec email de contact.
   On utilise:
   - /files/company_tickers.json         -> map ticker -> CIK
   - /api/xbrl/companyfacts/CIK####.json -> facts (assets, liabilities, revenue, opInc, cashflow, shares)
*/

// AVANT
// let TICKER_MAP: Record<string, { cik_str: number; ticker: string; title: string }> | null = null;
// let TICKER_MAP_EXP = 0;

// APRES
let TICKER_MAP: Record<string, { cik_str: number; ticker: string; title: string }> = {};
let TICKER_MAP_EXP = 0;

async function loadTickerMap(): Promise<Record<string, { cik_str: number; ticker: string; title: string }>> {
  const now = Date.now();
  if (Object.keys(TICKER_MAP).length && TICKER_MAP_EXP > now) return TICKER_MAP;

  const url = "https://www.sec.gov/files/company_tickers.json";
  const res = await fetch(url, {
    headers: { "User-Agent": `StockAnalyzer/1.0 (${CONTACT_EMAIL})`, "Accept": "application/json" }
  });
  if (!res.ok) {
    // en cas d’échec, renvoie au moins un objet vide (pas de null)
    return TICKER_MAP;
  }
  const js = await res.json();
  const map: Record<string, { cik_str: number; ticker: string; title: string }> = {};
  Object.values(js as any).forEach((row: any) => {
    map[String(row.ticker).toUpperCase()] = { cik_str: row.cik_str, ticker: row.ticker, title: row.title };
  });
  TICKER_MAP = map;
  TICKER_MAP_EXP = now + 24*60*60*1000; // 24h
  return TICKER_MAP;
}


async function fetchFromSEC_US_IfPossible(ticker: string, lastPrice: number | null) {
  const fund = {
    op_margin: null as number | null,
    current_ratio: null as number | null,
    dilution_3y: null as number | null,
    fcf_positive_last4: null as number | null,
    fcf_yield: null as number | null,
  };

  // map ticker -> CIK (US only)
  let cik: string | null = null;
  try {
    const tickerMap = await loadTickerMap();
	const hit = tickerMap[ticker.toUpperCase()];
    if (hit) cik = String(hit.cik_str).padStart(10, "0");
  } catch { /* ignore */ }

  if (!cik) {
    return { fundamentals: fund }; // pas US ou non trouvé -> on rend nulls
  }

  // companyfacts
  try {
    const factsUrl = `https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`;
    const r = await fetch(factsUrl, {
      headers: { "User-Agent": `StockAnalyzer/1.0 (${CONTACT_EMAIL})`, "Accept": "application/json" }
    });
    if (!r.ok) throw new Error(`SEC facts HTTP ${r.status}`);
    const facts = await r.json();

    const usgaap = facts?.facts?.["us-gaap"] || {};

    // helpers pour extraire dernière valeur annuelle/disponible
    const lastNum = (arr?: any[], prop: string = "val") =>
      Array.isArray(arr) && arr.length ? (arr[arr.length - 1]?.[prop] ?? null) : null;

    // Revenue & OperatingIncome pour op_margin
    const revArr = usgaap.RevenueFromContractWithCustomerExcludingAssessedTax?.units?.USD || usgaap.Revenues?.units?.USD;
    const opIncArr = usgaap.OperatingIncomeLoss?.units?.USD;
    const revenue = lastNum(revArr);
    const opInc = lastNum(opIncArr);
    if (typeof revenue === "number" && revenue !== 0 && typeof opInc === "number") {
      fund.op_margin = opInc / revenue; // approx TTM/annual last
    }

    // Current ratio = CurrentAssets / CurrentLiabilities
    const ca = lastNum(usgaap.AssetsCurrent?.units?.USD);
    const cl = lastNum(usgaap.LiabilitiesCurrent?.units?.USD);
    if (typeof ca === "number" && typeof cl === "number" && cl !== 0) {
      fund.current_ratio = ca / cl;
    }

    // Shares outstanding, dilution 3y
    const shArr = usgaap.CommonStockSharesOutstanding?.units?.shares
               || usgaap.EntityCommonStockSharesOutstanding?.units?.shares;
    let dilution = null;
    if (Array.isArray(shArr) && shArr.length >= 2) {
      const last = shArr[shArr.length - 1]?.val;
      // cherche ~3 ans avant (prend i-3 si dispo sinon i-2 etc.)
      const i0 = Math.max(0, shArr.length - 13); // ~trimestriel -> ~12 trimestres ~3 ans
      const prev = shArr[i0]?.val;
      if (typeof last === "number" && typeof prev === "number" && prev > 0) {
        dilution = (last - prev) / prev; // +20% => 0.2
      }
    }
    fund.dilution_3y = dilution;

    // FCF positif (4 dernières périodes annuelles si dispo): CFO - CapEx
    const cfoArr = usgaap.NetCashProvidedByUsedInOperatingActivities?.units?.USD;
    const capexArr = usgaap.PaymentsToAcquireProductiveAssets?.units?.USD
                  || usgaap.PurchasesOfPropertyPlantAndEquipment?.units?.USD;
    if (Array.isArray(cfoArr) && Array.isArray(capexArr)) {
      // on prend les 4 dernières valeurs annuelles si possible
      const n = Math.min(4, Math.min(cfoArr.length, capexArr.length));
      let countPos = 0;
      for (let i = 1; i <= n; i++) {
        const cfo = cfoArr[cfoArr.length - i]?.val;
        const capex = capexArr[capexArr.length - i]?.val;
        if (typeof cfo === "number" && typeof capex === "number") {
          const fcf = cfo - Math.abs(capex);
          if (fcf > 0) countPos++;
        }
      }
      fund.fcf_positive_last4 = countPos;
    }

    // FCF yield approx = FCF (dernière période) / MarketCap
    const lastCFO = lastNum(cfoArr);
    const lastCapex = lastNum(capexArr);
    // MarketCap = price * shares
    let sharesLast = null;
    if (Array.isArray(shArr) && shArr.length) sharesLast = shArr[shArr.length - 1]?.val;
    if (typeof lastPrice === "number" && typeof sharesLast === "number" && sharesLast > 0) {
      const mcap = lastPrice * sharesLast;
      if (typeof lastCFO === "number" && typeof lastCapex === "number") {
        const fcf = lastCFO - Math.abs(lastCapex);
        if (mcap > 0) fund.fcf_yield = fcf / mcap; // ex: 0.04 = 4%
      }
    }
  } catch {
    // ignore — on reste avec nulls
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

  // ---- Qualité (max 35) — ici, on ne score que les métriques disponibles
  let q = 0, qMax = 0;
  if (typeof f.op_margin === "number") {
    qMax += 8;
    q += f.op_margin >= 0.25 ? 8 : f.op_margin >= 0.15 ? 6 : f.op_margin >= 0.05 ? 3 : 0;
  }

  // ---- Sécurité (max 25)
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

  // ---- Valorisation (max 25)
  let v = 0, vMax = 0;
  if (typeof f.fcf_yield === "number") {
    vMax += 10;
    const y = f.fcf_yield;
    v += y > 0.06 ? 10 : y >= 0.04 ? 7 : y >= 0.02 ? 4 : 1;
  }

  // ---- Momentum (max 15)
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
  // Pour l’instant, pas de red flags "durs" sans parsing plus fin (audit, etc.)
  return [] as string[];
}
