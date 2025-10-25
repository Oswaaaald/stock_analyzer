// Exécuter sur runtime Node.js (plus permissif que Edge pour certaines libs)
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import yf from "yahoo-finance2";

// ---------------- Cache mémoire simple (persiste le temps de vie du process) -----------
const MEM: Record<string, { expires: number; data: any }> = {};
const TTL_MS = 30 * 60 * 1000; // 30 minutes

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

// ---------------------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------------------
// Provider sans clé (yahoo-finance2)

async function fetchAllNoKey(ticker: string): Promise<DataBundle> {
  // quote: prix & infos rapides
  const quote = await yf.quote(ticker).catch(() => null);

  // summary: secteur/industrie + quelques métriques financières
  const summary = await yf
    .quoteSummary(ticker, {
      modules: [
        "summaryProfile",
        "price",
        "defaultKeyStatistics",
        "financialData",
      ],
    })
    .catch(() => null);

  // historique 2 ans (1d) pour 200DMA
  const hist = await yf
    .historical(ticker, {
      period1: new Date(Date.now() - 1000 * 60 * 60 * 24 * 365 * 2),
      period2: new Date(),
      interval: "1d",
    })
    .catch(() => []);

  const price =
    (quote as any)?.regularMarketPrice ??
    (quote as any)?.previousClose ??
    null;

  // 200DMA
  let px_vs_200dma: number | null = null;
  if (Array.isArray(hist) && hist.length >= 200) {
    const closes = hist
      .map((h: any) => h?.close)
      .filter((x: any) => typeof x === "number")
      .slice(-200);
    if (closes.length >= 200) {
      const avg = closes.reduce((a: number, b: number) => a + b, 0) / closes.length;
      if (avg && typeof price === "number") {
        px_vs_200dma = (price - avg) / avg;
      }
    }
  }

  const sector = (summary as any)?.summaryProfile?.sector ?? undefined;
  const industry = (summary as any)?.summaryProfile?.industry ?? undefined;

  // marges & co (si dispo)
  const opMargin = (summary as any)?.financialData?.operatingMargins ?? null;

  // Beaucoup de métriques (ROIC, FCF yield…) nécessitent des retraitements lourds → null pour MVP
  return {
    ticker,
    sector,
    industry,
    fundamentals: {
      roic_3y: null, // non fiable sans retraitements approfondis
      op_margin: opMargin ?? null,
      rev_cagr_3y: null,
      fcf_to_ebit: null,
      rnd_to_sales_quantile: 0.5, // neutre
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
      rs_6m_vs_sector_percentile: 0.5, // neutre pour MVP
      eps_revisions_3m: 0,
    },
  };
}

// ---------------------------------------------------------------------------------------
// Scoring minimal tolérant aux valeurs nulles

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
  let s = 0; // inconnues -> neutre (0)

  // Valorisation (0..25)
  let v = 0;
  if (typeof f.fcf_yield === "number") {
    v += f.fcf_yield > 0.06 ? 10 : f.fcf_yield >= 0.04 ? 7 : f.fcf_yield >= 0.02 ? 4 : 1;
  }

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

  // Malus (désactivés pour MVP faute de data fiable)
  let malus = 0;

  return { subscores, malus };
}

function buildReasons(_data: DataBundle, subs: Record<string, number>) {
  // Règles simples basées sur ce qui est disponible
  const reasons: string[] = [];
  if (subscoresIsHigh(subs.quality, 20)) reasons.push("Qualité opérationnelle décente (proxy marges)");
  if (subscoresIsHigh(subs.momentum, 6)) reasons.push("Cours au-dessus de la moyenne 200 jours");
  if (subscoresIsHigh(subs.valuation, 7)) reasons.push("Valorisation potentiellement attractive (proxy FCF)");
  if (!reasons.length) reasons.push("Données limitées (mode gratuit) : vérifiez les détails");
  return reasons;

  function subscoresIsHigh(val: number, thr: number) {
    return typeof val === "number" && val >= thr;
  }
}

function detectRedFlags(_data: DataBundle) {
  // Sans états complets fiables, on reste prudent
  return [] as string[];
}
