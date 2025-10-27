// /app/api/score/[ticker]/route.ts
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import type { ScorePayload, DataBundle, OppPoint } from "@/lib/types";
import { fetchYahooChartAndEnrich } from "@/lib/yahooPrice";
import { getYahooSession } from "@/lib/yahooSession";
import { fetchYahooV10, computeFundamentalsFromV10 } from "@/lib/yahooV10";
import { buildOpportunitySeries } from "@/lib/opportunity";
import { bundleToMetrics } from "@/lib/adapter";
import { computePillars } from "@/lib/pillars";

// -------- Cache mémoire --------
const MEM: Record<string, { expires: number; data: any }> = {};
const TTL_MS = 30 * 60 * 1000; // 30 min

// -------- Helpers debug --------
function missingFundamentals(f: DataBundle["fundamentals"]) {
  const miss: string[] = [];
  for (const [k, v] of Object.entries(f)) {
    if (v == null) {
      miss.push(k);
      continue;
    }
    if (typeof v === "object" && "value" in v && (v as any).value == null) {
      miss.push(k);
    }
  }
  return miss.sort();
}
function missingMetrics(m: Record<string, any>) {
  return Object.entries(m)
    .filter(([_, v]) => v == null || (typeof v === "number" && !Number.isFinite(v)))
    .map(([k]) => k)
    .sort();
}

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
    // --- 1) Prix & momentum (Yahoo v8)
    const priceFeed = await fetchYahooChartAndEnrich(t);

    // --- 2) Fundamentals & ratios (Yahoo v10)
    const sess = await getYahooSession();
    const v10 = await fetchYahooV10(t, sess, /*retryOnce*/ true);
    const fundamentals = computeFundamentalsFromV10(v10);
    const sources_used = ["price:yahoo(v8)", "yahoo:v10"];

    const bundle: DataBundle = { ticker: t, fundamentals, prices: priceFeed, sources_used };

    // --- 3) Série d’opportunité d’achat
    let opportunity_series: OppPoint[] | undefined = undefined;
    if (priceFeed.series?.closes?.length && priceFeed.series?.ts?.length) {
      opportunity_series = buildOpportunitySeries(priceFeed.series.closes, priceFeed.series.ts, fundamentals);
    }

    // --- 4) Conversion Yahoo → Metrics → Pillars
    const metrics = bundleToMetrics(bundle);
    const pillars = computePillars(metrics);

    // --- 5) Score global et couleur
    const totalScore = Object.values(pillars.subscores).reduce((a, b) => a + b, 0);
    const score_adj = Math.round(totalScore);
    const color: ScorePayload["color"] =
      score_adj >= 65 ? "green" : score_adj >= 50 ? "orange" : "red";

    // --- 6) Construction du verdict synthétique
    let verdict: ScorePayload["verdict"] = "fragile";
    let verdict_reason = "Signal faible ou données incomplètes";
    if (score_adj >= 70 && pillars.coverage >= 50) {
      verdict = "sain";
      verdict_reason = "Entreprise solide et bien valorisée";
    } else if (score_adj >= 50) {
      verdict = "a_surveiller";
      verdict_reason = "Profil intéressant mais à surveiller";
    }

    // --- 7) Payload final
    const payload: ScorePayload = {
      ticker: t,
      company_name: v10?.price?.longName ?? v10?.price?.shortName ?? null,
      exchange: v10?.price?.exchangeName ?? v10?.price?.exchange ?? null,

      score: score_adj,
      score_adj,
      color,
      verdict,
      verdict_reason,
      reasons_positive: pillars.reasons_positive,
      red_flags: pillars.red_flags,
      subscores: pillars.subscores,
      coverage: pillars.coverage,
      opportunity_series,

      proof: {
        price_source: priceFeed.meta?.source_primary,
        price_points: priceFeed.meta?.points,
        price_has_200dma: priceFeed.px_vs_200dma.value !== null,
        price_recency_days: priceFeed.meta?.recency_days ?? null,
        price_last_date: priceFeed.series?.ts?.at(-1)
          ? new Date(priceFeed.series.ts.at(-1)!).toISOString().slice(0, 10)
          : null,
        valuation_used:
          (fundamentals.fcf_yield.value ?? fundamentals.earnings_yield.value) != null,
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

    // --- 8) Debug payload (seulement si ?debug=1)
    if (isDebug) {
      (payload as any).debug = {
        fundamentals_raw: fundamentals,
        prices_raw: priceFeed,
        metrics,
        subscores: pillars.subscores,
        coverage_calc: pillars.coverage,
        missing: {
          fundamentals: missingFundamentals(fundamentals),
          metrics: missingMetrics(metrics as any),
        },
      };
      // Log serveur compact
      console.log(`[score dbg ${t}]`, JSON.stringify((payload as any).debug.missing));
    }

    // --- 9) Mise en cache et retour
    if (!isDebug) MEM[cacheKey] = { expires: now + TTL_MS, data: payload };
    return NextResponse.json(payload, {
      headers: { "Cache-Control": "s-maxage=600, stale-while-revalidate=1200" },
    });
  } catch (e: any) {
    const msg = typeof e?.message === "string" ? e.message : e?.toString?.() || "Erreur provider";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}