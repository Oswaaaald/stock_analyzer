// app/api/suggest/route.ts
export const runtime = "nodejs";

import { NextResponse } from "next/server";

// exemple simple : retourne les symboles Yahoo suggérés pour une requête donnée
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const q = searchParams.get("q");
  if (!q) return NextResponse.json({ error: "Paramètre ?q= requis" }, { status: 400 });

  const res = await fetch(
    `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}`
  );
  const js = await res.json();

  const suggestions = (js?.quotes || [])
    .map((x: any) => ({
      symbol: x.symbol,
      name: x.longname || x.shortname,
      exch: x.exchDisp,
    }))
    .slice(0, 8);

  return NextResponse.json({ q, suggestions });
}