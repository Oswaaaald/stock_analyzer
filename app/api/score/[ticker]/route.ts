// /app/api/score/[ticker]/route.ts
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import type { ScorePayload, DataBundle, OppPoint } from "@/lib/types";
import { fetchYahooChartAndEnrich } from "@/lib/yahooPrice";
import { getYahooSession } from "@/lib/yahooSession";
import { fetchYahooV10, computeFundamentalsFromV10 } from "@/lib/yahooV10";
import { computeScore, buildReasons, makeVerdict } from "@/lib/scoring";
import { buildOpportunitySeries } from "@/lib/opportunity";

// -------- Cache mémoire --------
const MEM: Record<string, { expires: number; data: any }> = {};
const TTL_MS = 30 * 60 * 1000; // 30 min

export async function GET(req: Request, { params }: { params: { ticker: string } }) {
  const t = (params.ticker || "").toUpperCase().trim();
  if (!t) return NextResponse.json({ error: "Ticker requis" }, { status: 400 });

  const url = new URL(req.url);
  const isDebug = url.searchParams.get("debug") === "1";

  const cacheKey = `score_${t}${isDebug ? ":dbg" : ""}`;
  const now = Date.now();
  const hit = MEM[cacheKey];
  if (!isDebug && hit && hit.expires > now) return NextResponse.json(hit.data);

  try {
    // 1) Prix & momentum (v8)
    const priceFeed = await fetchYahooChartAndEnrich(t);

    // 2) v10 (fundamentaux & annuals)
    const sess = await getYahooSession();
    const v10 = await fetchYahooV10(t, sess, /*retryOnce*/ true);

    // 3) Fundamentals
    const fundamentals = computeFundamentalsFromV10(v10);
    const sources_used = ["price:yahoo(v8)", "yahoo:v10"];
    const bundle: DataBundle = { ticker: t, fundamentals, prices: priceFeed, sources_used };

    // 4) Opportunité d’achat
    let opportunity_series: OppPoint[] | undefined = undefined;
    if (priceFeed.series?.closes?.length && priceFeed.series?.ts?.length) {
      opportunity_series = buildOpportunitySeries(priceFeed.series.closes, priceFeed.series.ts, fundamentals);
    }

    // 5) Score & couverture
    const { subscores, maxes } = computeScore(bundle);

    // Couverture (UI)
    const covQuality = Math.min(1, (maxes.quality   || 0) / 8 ) * 35; // 0..35
    const covSafety  = Math.min(1, (maxes.safety    || 0) / 6 ) * 25; // 0..25
    const covVal     = Math.min(1, (maxes.valuation || 0) / 10) * 25; // 0..25
    const covMom     = Math.min(1, (maxes.momentum  || 0) / 15) * 15; // 0..15
    const coverage_display = Math.round(covQuality + covSafety + covVal + covMom); // 0..100

    const denom = Math.max(1, Math.round(maxes.quality + maxes.safety + maxes.valuation + maxes.momentum));
    const total = subscores.quality + subscores.safety + subscores.valuation + subscores.momentum;
    const raw = Math.max(0, Math.min(100, Math.round(total)));
    const score_adj = Math.round((total / denom) * 100);

    const shown = score_adj ?? raw;
    const color: ScorePayload["color"] = shown >= 65 ? "green" : shown >= 50 ? "orange" : "red";

    const { verdict, reason } = makeVerdict({
      coverage: coverage_display,
      total,
      momentumPresent: true,
      score_adj: shown,
    });

    const reasons = buildReasons(bundle, subscores);

    const payload: ScorePayload = {
      ticker: t,
      company_name: v10?.price?.longName ?? v10?.price?.shortName ?? null,
      exchange: v10?.price?.exchangeName ?? v10?.price?.exchange ?? null,

      score: raw,
      score_adj,
      color,
      verdict,
      verdict_reason: reason,
      reasons_positive: reasons.slice(0, 3),
      red_flags: [],
      subscores,
      coverage: coverage_display,
      opportunity_series,

      proof: {
        price_source: priceFeed.meta?.source_primary,
        price_points: priceFeed.meta?.points,
        price_has_200dma: priceFeed.px_vs_200dma.value !== null,
        price_recency_days: priceFeed.meta?.recency_days ?? null,
        price_last_date: priceFeed.series?.ts?.at(-1)
          ? new Date(priceFeed.series.ts.at(-1)!).toISOString().slice(0, 10)
          : null,
        valuation_used: (fundamentals.fcf_yield.value ?? fundamentals.earnings_yield.value) != null,
        valuation_metric:
          typeof fundamentals.fcf_yield.value === "number"
            ? "FCFY"
            : typeof fundamentals.earnings_yield.value === "number"
            ? "EY"
            : null,
        sources_used,
      },
      ratios: {
        roe: fundamentals.roe?.value ?? null,
        roa: fundamentals.roa?.value ?? null,
        fcf_over_netincome: fundamentals.fcf_over_netincome?.value ?? null,
        roic: fundamentals.roic?.value ?? null,
      },
    };

    if (!isDebug) MEM[cacheKey] = { expires: now + TTL_MS, data: payload };
    return NextResponse.json(payload, { headers: { "Cache-Control": "s-maxage=600, stale-while-revalidate=1200" } });
  } catch (e: any) {
    const msg = typeof e?.message === "string" ? e.message : e?.toString?.() || "Erreur provider";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}