// Exécuter sur runtime Node.js (les fetch externes sont plus permissifs qu'en Edge)
export const runtime = "nodejs";

import { NextResponse } from "next/server";

// --- Cache mémoire simple ---
const MEM: Record<string, { expires: number; data: any }> = {};
const TTL_MS = 30 * 60 * 1000; // 30 min

type DataBundle = {
  ticker: string;
  fundamentals: Record<string, any>;
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
  coverage: number; // 0..100 — part des points “disponibles” (ex: 15 => 15%)
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
  if (hit && hit.expires > now) {
    return NextResponse.json(hit.data);
  }

  try {
    const bundle = await fetchAllNoKeyStooq(t);

    // ----- scoring adaptatif -----
    const { subscores, malus, maxes } = computeScore(bundle);

    const total =
      subscores.quality +
      subscores.safety +
      subscores.valuation +
      subscores.momentum;

    const maxPossible =
      maxes.quality + maxes.safety + maxes.valuation + maxes.momentum;

    const raw = maxPossible > 0 ? Math.round((total / maxPossible) * 100) : 0;
    const final = Math.max(0, Math.min(100, raw)); // malus = 0 en stooq-only

    const color: ScorePayload["color"] =
      final >= 70 ? "green" : final >= 50 ? "orange" : "red";

    const reasons = buildReasons(bundle, subscores);
    const flags = detectRedFlags(bundle);

    const payload: ScorePayload = {
      ticker: t,
      score: final,
      color,
      reasons_positive: reasons.slice(0, 3),
      red_flags: flags.slice(0, 2),
      subscores,
      coverage: Math.max(
        0,
        Math.min(100, Math.round(maxPossible)) // ex: 15 -> 15%
      ),
    };

    MEM[key] = { expires: now + TTL_MS, data: payload };
    return NextResponse.json(payload, {
      headers: { "Cache-Control": "s-maxage=600, stale-while-revalidate=1200" },
    });
  } catch (e: any) {
    const msg =
      typeof e?.message === "string"
        ? e.message
        : e?.toString?.() || "Erreur provider";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

/* =======================================================================================
   Provider no-key via Stooq (CSV public)
   - URL jour: https://stooq.com/q/d/l/?s=<symbol>&i=d
   - On teste plusieurs variantes de symbole (aapl, aapl.us, or.pa, etc.)
   - On parse le CSV à la main et on calcule la 200DMA
======================================================================================= */

async function fetchAllNoKeyStooq(ticker: string): Promise<DataBundle> {
  const candidates = makeStooqCandidates(ticker);

  // essaie chaque candidate jusqu'à trouver un CSV valide
  let closes: number[] | null = null;
  for (const sym of candidates) {
    try {
      const csv = await fetchCsv(
        `https://stooq.com/q/d/l/?s=${encodeURIComponent(sym)}&i=d`
      );
      const parsed = parseStooqCsv(csv); // { dates: string[], closes: number[] }
      if (parsed.closes.length > 0) {
        closes = parsed.closes;
        break;
      }
    } catch {
      // continue
    }
  }

  if (!closes || closes.length === 0) {
    throw new Error(
      `Aucune donnée Stooq pour ${ticker} (essais: ${candidates.join(", ")})`
    );
  }

  // prix = dernier close connu
  const px = closes[closes.length - 1] ?? null;

  // px vs 200DMA
  let px_vs_200dma: number | null = null;
  if (closes.length >= 200 && typeof px === "number") {
    const last200 = closes.slice(-200);
    const avg = last200.reduce((a, b) => a + b, 0) / last200.length;
    if (avg) px_vs_200dma = (px - avg) / avg;
  }

  return {
    ticker,
    fundamentals: {
      // Sans états financiers publics no-key, on laisse à null pour MVP
      op_margin: null,
      fcf_yield: null,
    },
    prices: {
      px,
      px_vs_200dma,
      rs_6m_vs_sector_percentile: 0.5, // neutre
      eps_revisions_3m: 0,
    },
  };
}

function makeStooqCandidates(ticker: string): string[] {
  // Stooq utilise des symboles lowercase, souvent suffixés .us pour US.
  const t = ticker.toLowerCase();
  const out = new Set<string>();

  // 1) tel quel
  out.add(t);

  // 2) version US
  out.add(`${t}.us`);

  // 3) remplacements fréquents (ex: BRK.B -> brk-b.us)
  out.add(`${t.replace(/\./g, "-")}.us`);
  out.add(t.replace(/\./g, "-"));

  // 4) cas Euronext déjà suffixé (ex: or.pa)
  if (/\.[a-z]{2,3}$/.test(t)) out.add(t);

  return Array.from(out);
}

async function fetchCsv(url: string): Promise<string> {
  const r = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; StockAnalyzer/1.0)",
      Accept: "text/csv, text/plain, */*",
      "Cache-Control": "no-cache",
    },
  });
  if (!r.ok) throw new Error(`HTTP ${r.status} on ${url}`);
  return r.text();
}

function parseStooqCsv(csv: string): { dates: string[]; closes: number[] } {
  // CSV format: Date,Open,High,Low,Close,Volume
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
    if (d && Number.isFinite(c)) {
      dates.push(d);
      closes.push(c);
    }
  }
  return { dates, closes };
}

/* =======================================================================================
   Scoring adaptatif (tolérant aux nulls)
======================================================================================= */
function clip(x: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, x));
}

function computeScore(data: DataBundle) {
  const f = data.fundamentals;
  const p = data.prices;

  // ---- Qualité (max effectif selon métriques dispo)
  let q = 0;
  let qMax = 0;
  if (typeof f.op_margin === "number") {
    // Si on a la marge op, Qualité max 8 pts dans ce mode (sur 35 dans le design complet)
    qMax += 8;
    q += f.op_margin >= 0.25 ? 8 : f.op_margin >= 0.15 ? 6 : f.op_margin >= 0.05 ? 3 : 0;
  }

  // ---- Sécurité (rien de fiable en no-key stooq)
  let s = 0;
  let sMax = 0;

  // ---- Valorisation (rien de fiable en no-key stooq)
  let v = 0;
  let vMax = 0;

  // ---- Momentum (on a la 200DMA via Stooq)
  let m = 0;
  let mMax = 0;
  if (typeof p.px_vs_200dma === "number") {
    // Échelle officielle Momentum = 15 pts max
    mMax = 15;
    m = p.px_vs_200dma >= 0.05 ? 15 : p.px_vs_200dma > -0.05 ? 8 : 3;
  }

  const subscores = {
    quality: clip(q, 0, 35),
    safety: clip(s, 0, 25),
    valuation: clip(v, 0, 25),
    momentum: clip(m, 0, 15),
  };

  const maxes = {
    quality: qMax,
    safety: sMax,
    valuation: vMax,
    momentum: mMax,
  };

  const malus = 0; // pas de red flags fiables en stooq-only
  return { subscores, malus, maxes };
}

function buildReasons(_data: DataBundle, subs: Record<string, number>) {
  const reasons: string[] = [];
  if (isHigh(subs.momentum, 6))
    reasons.push("Cours au-dessus de la moyenne 200 jours");
  if (isHigh(subs.valuation, 7))
    reasons.push("Valorisation potentiellement attractive (proxy)");
  if (isHigh(subs.quality, 20))
    reasons.push("Qualité opérationnelle décente (proxy)");
  if (!reasons.length)
    reasons.push("Données limitées (mode gratuit) : vérifiez les détails");
  return reasons;

  function isHigh(val: number, thr: number) {
    return typeof val === "number" && val >= thr;
  }
}

function detectRedFlags(_data: DataBundle) {
  return [] as string[];
}
