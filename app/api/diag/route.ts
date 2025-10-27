// app/api/diag/[ticker]/route.ts
import { NextResponse } from "next/server";
import { getYahooSession } from "@/lib/yahooSession";
import { fetchYahooV10 } from "@/lib/yahooV10";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(
  _req: Request,
  { params }: { params: { ticker: string } }
) {
  try {
    const ticker = decodeURIComponent(params.ticker || "").trim();
    if (!ticker) return NextResponse.json({ error: "Missing ticker" }, { status: 400 });

    const sess = await getYahooSession();
    const raw = await fetchYahooV10(ticker, sess, /*retryOnce*/ true);

    // On retourne un diagnostic lisible: les clés top-level + quelques modules utiles
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
        financialData: raw?.financialData ?? null,
        defaultKeyStatistics: raw?.defaultKeyStatistics ?? null,
        summaryDetail: raw?.summaryDetail ?? null,
      },
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "diag failed" }, { status: 500 });
  }
}