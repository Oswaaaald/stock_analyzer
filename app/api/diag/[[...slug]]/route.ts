import { NextResponse } from "next/server";
import { getYahooSession } from "@/lib/yahooSession";
import { fetchYahooV10 } from "@/lib/yahooV10";

export const runtime = "nodejs";       // évite Edge si ton code utilise des libs Node
export const dynamic = "force-dynamic";
export const revalidate = 0;

function tickerFrom(req: Request, params: { slug?: string[] } = {}): string | null {
  // 1) /api/diag/AAPL -> params.slug = ["AAPL"]
  const fromSlug = params.slug?.[0];
  if (fromSlug && fromSlug.trim()) return decodeURIComponent(fromSlug.trim());

  // 2) /api/diag?ticker=AAPL
  const t = new URL(req.url).searchParams.get("ticker");
  if (t && t.trim()) return t.trim();

  return null;
}

export async function GET(req: Request, { params }: { params: { slug?: string[] } }) {
  try {
    const ticker = tickerFrom(req, params);
    if (!ticker) {
      return NextResponse.json(
        { error: "Missing ticker. Use /api/diag/<TICKER> or /api/diag?ticker=<TICKER>" },
        { status: 400 }
      );
    }

    // log minimal pour vérifier l’appel dans Vercel logs
    console.log("[diag] fetching v10 for", ticker);

    const sess = await getYahooSession();
    const raw = await fetchYahooV10(ticker, sess, /*retryOnce*/ true);

    // renvoyer un diagnostic lisible
    return NextResponse.json({
      ticker,
      availableModules: Object.keys(raw || {}),
      priceKeys: Object.keys(raw?.price || {}),
      summaryDetailKeys: Object.keys(raw?.summaryDetail || {}),
      defaultKeyStatisticsKeys: Object.keys(raw?.defaultKeyStatistics || {}),
      financialDataKeys: Object.keys(raw?.financialData || {}),
      hasIncomeStatementHistory: !!raw?.incomeStatementHistory?.incomeStatementHistory?.length,
      hasBalanceSheetHistory: !!raw?.balanceSheetHistory?.balanceSheetStatements?.length,
      hasCashflowStatementHistory: !!raw?.cashflowStatementHistory?.cashflowStatements?.length,
      sample: {
        // attention: ça peut être verbeux — suffisant pour diagnostiquer
        financialData: raw?.financialData ?? null,
        defaultKeyStatistics: raw?.defaultKeyStatistics ?? null,
        summaryDetail: raw?.summaryDetail ?? null,
      },
    });
  } catch (e: any) {
    console.error("[diag] error:", e);
    return NextResponse.json({ error: e?.message ?? "diag failed" }, { status: 500 });
  }
}