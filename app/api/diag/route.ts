// /app/api/diag/[ticker]/route.ts
import { NextResponse } from "next/server";
import { getYahooSession } from "@/lib/yahooSession";
import { fetchYahooV10 } from "@/lib/yahooV10";

export async function GET(_: Request, { params }: { params: { ticker: string } }) {
  try {
    const sess = await getYahooSession();
    const r = await fetchYahooV10(params.ticker, sess, true);

    const pick = {
      price_keys: Object.keys(r?.price || {}),
      fin_keys: Object.keys(r?.financialData || {}),
      dks_keys: Object.keys(r?.defaultKeyStatistics || {}),
      is_hist_0: r?.incomeStatementHistory?.incomeStatementHistory?.[0] || null,
      bs_hist_0: r?.balanceSheetHistory?.balanceSheetStatements?.[0] || null,
      cfs_hist_0_keys: Object.keys(r?.cashflowStatementHistory?.cashflowStatements?.[0] || {}),
    };

    return NextResponse.json(pick);
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "diag error" }, { status: 500 });
  }
}