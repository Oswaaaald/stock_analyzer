// Exécuter sur runtime Node.js (Edge pourrait bloquer certaines requêtes)
export const runtime = "nodejs";

import { NextResponse } from "next/server";

// --- Cache mémoire simple ---
const MEM: Record<string, { expires: number; data: any }> = {};
const TTL_MS = 30 * 60 * 1000; // 30 min

type DataBundle = {
  ticker: string;
  sector?: string;
  industry?: string;
  fundamentals: Record<string, any>;
  prices: Record<string, any>;
};

type ScorePayload = {
  ticker: string;
  score: number;
  color: "green" | "orange" | "red";
  reasons_positive: string[];
  red_flags: string[];
  subscores: Record<string, number>;
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
    const bundle = await fetchAllNoKey(t);
    const { subscores, malus } = computeScore(bundle);
    const raw = Math.round(
      0.35 * subscores.quality +
        0.25 * subscores.safety +
        0.25 * subscores.valuation +
        0.15 * subscores.momentum
    );
    const final = Math.max(0, Math.min(100, raw - malus));
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

// ------------------------------ Provider no-key via fetch Yahoo ------------------------------

async function fetchAllNoKey(ticker: string): Promise<DataBundle> {
  const ua = {
    "User-Agent":
      "Mozilla/5.0 (compatible; StockAnalyzer/1.0; +https://example.com)",
    "Accept": "application/json, text/plain, */*",
  };

  const [quote, summary, chart] = await Promise.all([
    fetchJson(
      `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(
        ticker
      )}`,
      ua
    ),
    fetchJson(
      `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(
        ticker
      )}?modules=summaryProfile,price,defaultKeyStatistics,financialData`,
      ua
    ),
    fetchJson(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
        ticker
      )}?range=2y&interval=1d`,
      ua
    ),
  ]);

  const qRes = quote?.quoteResponse?.result?.[0] || {};
  const sRes = summary?.quoteSummary?.result?.[0] || {};
  const cRes = chart?.chart?.result?.[0] || {};

  const price =
    qRes.regularMarketPrice ?? qRes.previousClose ?? null;

  // 200DMA
  let px_vs_200dma: number | null = null;
  try {
    const closes: number[] = (cRes?.indicators?.quote?.[0]?.close || []).filter(
      (x: any) => typeof x === "number"
    );
    if (closes.length >= 200) {
      const last = closes.at(-1)!;
      const avg =
        closes.slice(-200).reduce((a: number, b: number) => a + b, 0) / 200;
      if (avg && typeof last === "number") {
        px_vs_200dma = (last - avg) / avg;
      }
    }
  } catch {}

  const sector = sRes?.summaryProfile?.sector;
  const industry = sRes?.summaryProfile?.industry;
  const opMargin = sRes?.financialData?.operatingMargins ?? null;

  return {
    ticker,
    sector,
    industry,
    fundamentals: {
      roic_3y: null,
      op_margin: opMargin ?? null,
      rev_cagr_3y: null,
      fcf_to_ebit: null,
      rnd_to_sales_quantile: 0.5,
      net_debt_to_ebitda: null,
      current_ratio: null,
      interest_coverage: null,
      dilution_3y: null,
      fcf_positive_last4: null,
      fcf_yield: null,
      pe_vs_sector: null,
      ev_ebitda_vs_sector: null,
      gross_margin_yoy_delta: null,
      receivables_to_sales_yoy_delta: null,
      short_term_debt_gt_cash: false,
      audit_concern: false,
    },
    prices: {
      px: price,
      px_vs_200dma,
      rs_6m_vs_sector_percentile: 0.5,
      eps_revisions_3m: 0,
    },
  };
}

async function fetchJson(url: string, headers: Record<string, string>) {
  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} on ${url}`);
  }
  return res.json();
}

// ------------------------------ Scoring minimal ------------------------------

function clip(x: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, x));
}

function computeScore(data: DataBundle) {
  const f = data.fundamentals;
  const p = data.prices;

  // Qualité (0..35)
  let q = 0;
  if (typeof f.op_margin === "number") {
    q += f.op_margin >= 0.25 ? 8 : f.op_margin >= 0.15 ? 6 : f.op_margin >= 0.05 ? 3 : 0;
  }

  // Sécurité (0..25)
  let s = 0;

  // Valorisation (0..25)
  let v = 0;

  // Momentum (0..15)
  let m = 0;
  if (typeof p.px_vs_200dma === "number") {
    m += p.px_vs_200dma >= 0.05 ? 6 : p.px_vs_200dma > -0.05 ? 3 : 1;
  }

  const subscores = {
    quality: clip(q, 0, 35),
    safety: clip(s, 0, 25),
    valuation: clip(v, 0, 25),
    momentum: clip(m, 0, 15),
  };

  let malus = 0;

  return { subscores, malus };
}

function buildReasons(_data: DataBundle, subs: Record<string, number>) {
  const reasons: string[] = [];
  if (isHigh(subs.quality, 20)) reasons.push("Qualité opérationnelle décente (proxy marges)");
  if (isHigh(subs.momentum, 6)) reasons.push("Cours au-dessus de la moyenne 200 jours");
  if (isHigh(subs.valuation, 7)) reasons.push("Valorisation potentiellement attractive (proxy FCF)");
  if (!reasons.length) reasons.push("Données limitées (mode gratuit) : vérifiez les détails");
  return reasons;

  function isHigh(val: number, thr: number) {
    return typeof val === "number" && val >= thr;
  }
}

function detectRedFlags(_data: DataBundle) {
  return [] as string[];
}
