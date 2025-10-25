// app/api/score/[ticker]/route.ts
export const runtime = 'nodejs';          // IMPORTANT: pas d’Edge sur Vercel
export const dynamic = 'force-dynamic';   // évite le cache ISR par défaut

import { NextResponse } from 'next/server';
import { YahooClient } from '@/lib/yahoo';
import { computeValuation } from '@/lib/valuation';

export async function GET(
  req: Request,
  { params }: { params: { ticker: string } }
) {
  const symbol = (params?.ticker || '').toUpperCase();

  if (!symbol) {
    return NextResponse.json({ error: 'Missing ticker' }, { status: 400 });
  }

  try {
    const yahoo = new YahooClient();

    // 1) Fundamentals/price (v10 quoteSummary)
    const qs = await yahoo.fetchQuoteSummary(symbol);
    const vitals = YahooClient.extractVitals(qs);

    // 2) Prix & 200DMA (v8 chart)
    const chart = await yahoo.fetchChartLite(symbol);

    // 3) Tes métriques de valo
    const { earningsYield, fcfYield } = computeValuation(vitals);
    const valuation_used = earningsYield != null || fcfYield != null;

    // 4) Construire la réponse "score" comme tu l’exploites dans app/page.tsx
    const momentumSubscore =
      chart.pxVs200dma != null
        ? Math.round(Math.max(0, chart.pxVs200dma * 100))
        : 0;

    return NextResponse.json({
      ticker: symbol,
      subscores: {
        quality: 0,             // branche si tu as une logique
        safety: 0,              // idem
        valuation: valuation_used ? 10 : 0,
        momentum: momentumSubscore,
      },
      proof: {
        valuation_used,
        sources: ['yahoo:v10(quoteSummary)', 'yahoo:v8(chart)'],
      },
      debug: {
        yahoo: {
          vitals,               // price, shares, trailingPE, priceToBook, current_ratio, ocf_ttm, capex_ttm, fcf_ttm
          chart,                // lastClose, pxVs200dma
          earningsYield,
          fcfYield,
        },
      },
    });
  } catch (err: any) {
    return NextResponse.json(
      { error: err?.message ?? 'Yahoo fetch failed' },
      { status: 500 }
    );
  }
}