// app/api/score/[ticker]/route.ts
export const runtime = "nodejs";

import { NextResponse } from "next/server";

/* ============================== Cache mémoire ============================== */
const MEM: Record<string, { expires: number; data: any }> = {};
const TTL_MS = 30 * 60 * 1000; // 30 min

/* ============================== Types ============================== */
type Metric = { value: number | null; confidence: number; source?: string };

type Fundamentals = {
  op_margin: Metric;          // financialData.operatingMargins (si dispo)
  current_ratio: Metric;      // financialData.currentRatio
  fcf_yield: Metric;          // FCF / MarketCap
  earnings_yield: Metric;     // 1 / trailingPE
  net_cash: Metric;           // proxy (cash>debt) si dispo, sinon via PB<1.2
  // Ratios avancés (affichage)
  roe?: Metric;
  roa?: Metric;
  fcf_over_netincome?: Metric;
  roic?: Metric;
};

type Prices = {
  px: Metric;
  px_vs_200dma: Metric;
  pct_52w: Metric;
  max_dd_1y: Metric;
  ret_20d: Metric;
  ret_60d: Metric;
  meta?: { source_primary: "yahoo"; points: number; recency_days: number };
};

type DataBundle = { ticker: string; fundamentals: Fundamentals; prices: Prices; sources_used: string[] };

type ScorePayload = {
  ticker: string;
  score: number;
  score_adj?: number;
  color: "green" | "orange" | "red";
  verdict: "sain" | "a_surveiller" | "fragile";
  verdict_reason: string;
  reasons_positive: string[];
  red_flags: string[];
  subscores: Record<string, number>;
  coverage: number; // 0..100 pour l'UI (piliers)
  proof?: {
    price_source?: string;
    price_points?: number;
    price_has_200dma: boolean;
    price_recency_days?: number | null;
    valuation_used?: boolean;
    sources_used?: string[];
  };
  ratios?: {
    roe?: number | null;
    roa?: number | null;
    fcf_over_netincome?: number | null;
    roic?: number | null;
  };
};

/* ============================== UA & Session Yahoo ============================== */
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";
const AL = "en-US,en;q=0.9";
type YSession = { cookie: string; crumb?: string; exp: number };
let YSESSION: YSession | null = null;

// Agrège Set-Cookie -> "k=v; k2=v2"
function collectCookies(res: Response, prev = ""): string {
  // @ts-ignore next/undici compat
  const raw: string[] =
    typeof (res.headers as any).getSetCookie === "function"
      ? // @ts-ignore
        (res.headers as any).getSetCookie()
      : // @ts-ignore
        ((res.headers as any).raw?.()["set-cookie"] as string[] | undefined) || [];
  const parts: string[] = [];
  for (const sc of raw) {
    const kv = sc.split(";")[0]?.trim();
    if (kv) parts.push(kv);
  }
  if (prev) parts.push(...prev.split("; ").filter(Boolean));
  const map = new Map<string, string>();
  for (const p of parts) {
    const i = p.indexOf("=");
    if (i > 0) map.set(p.slice(0, i).trim(), p.trim());
  }
  return Array.from(map.values()).join("; ");
}

async function getYahooSession(): Promise<YSession> {
  const now = Date.now();
  if (YSESSION && YSESSION.exp > now && YSESSION.cookie) return YSESSION;

  let cookie = "";
  const base = { "User-Agent": UA, "Accept-Language": AL } as const;

  // 1) boot consent
  const q = await fetch("https://finance.yahoo.com/quote/AAPL?guccounter=1", { headers: base, redirect: "manual" });
  cookie = collectCookies(q, cookie);

  // 2) follow consent hops (si besoin)
  let loc = q.headers.get("location") || "";
  for (let i = 0; i < 3 && loc && /guce|consent\.yahoo\.com/i.test(loc); i++) {
    const r = await fetch(loc, { headers: base, redirect: "manual" });
    cookie = collectCookies(r, cookie);
    loc = r.headers.get("location") || "";
  }

  // 3) cookies communs
  const fc = await fetch("https://fc.yahoo.com", { headers: base, redirect: "manual" });
  cookie = collectCookies(fc, cookie);

  // 4) finance once more (A1/A3/GUC)
  const fin = await fetch("https://finance.yahoo.com/quote/AAPL", { headers: { ...base, Cookie: cookie }, redirect: "manual" });
  cookie = collectCookies(fin, cookie);

  // 5) crumb (q2 -> q1)
  const ch = { ...base, Cookie: cookie, Origin: "https://finance.yahoo.com", Referer: "https://finance.yahoo.com/" };
  let crumb = "";
  for (const host of ["query2", "query1"] as const) {
    try {
      const r = await fetch(`https://${host}.finance.yahoo.com/v1/test/getcrumb`, { headers: ch });
      if (r.ok) {
        const t = (await r.text()).trim();
        if (t && t !== "Unauthorized") { crumb = t; break; }
      }
    } catch {}
  }
  YSESSION = { cookie, crumb: crumb || undefined, exp: now + 45 * 60 * 1000 };
  return YSESSION;
}

/* ============================== Handler ============================== */
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
    // 1) Prix & momentum (v8, sans cookies)
    const priceFeed = await fetchYahooChartAndEnrich(t);

    // 2) Session + v10 (fundamentaux & historiques annuels pour ratios)
    const sess = await getYahooSession();
    const v10 = await fetchYahooV10(t, sess, /*retryOnce*/ true);

    // 3) Extraire fondamentaux + ratios
    const fundamentals = computeFundamentalsFromV10(v10);
    const sources_used = ["price:yahoo(v8)", "yahoo:v10"];

    const bundle: DataBundle = { ticker: t, fundamentals, prices: priceFeed, sources_used };
    const { subscores, maxes } = computeScore(bundle);

    // ===== Dénominateur réel (ce qui est disponible) : 0..39 =====
    const denom = Math.max(
      1,
      Math.round(maxes.quality + maxes.safety + maxes.valuation + maxes.momentum)
    );

    // ===== Score bruts / normalisés =====
    const total = subscores.quality + subscores.safety + subscores.valuation + subscores.momentum;
    const raw = Math.max(0, Math.min(100, Math.round(total)));
    const score_adj = Math.round((total / denom) * 100); // 0..100 (normalisé sur "dispo")

    // ===== Fiabilité (UI) =====
    // Base = proportion de briques réellement disponibles (denom/39), puis pénalités “richesse” douces.
    let coverage_display = Math.round((denom / 39) * 100); // 0..100

    // Pénalités de richesse/fraîcheur (n’affecte pas le score, juste la fiabilité affichée)
    let penalty = 0;

    // Prix pas assez dense / pas assez frais
    const pts = priceFeed.meta?.points ?? 0;
    const recency = priceFeed.meta?.recency_days ?? 999;
    if (pts < 240) penalty += 8;                // pas ~1 an de données “pleines”
    if (recency > 7) penalty += 8;              // données trop anciennes (> 7 j)

    // Valorisation basée uniquement sur EY (pas de FCFY)
    const hasFCFY = fundamentals.fcf_yield.value != null;
    const hasEY   = fundamentals.earnings_yield.value != null;
    if (!hasFCFY && hasEY) penalty += 7;

    // Sécurité basée uniquement sur "net_cash" (pas de current ratio)
    const hasCR = fundamentals.current_ratio.value != null;
    const hasNC = fundamentals.net_cash.value != null;
    if (!hasCR && hasNC) penalty += 5;

    // Ratios avancés manquants → chaque absence retire un peu de confiance
    const missingRatios =
      (fundamentals.roe?.value == null ? 1 : 0) +
      (fundamentals.roa?.value == null ? 1 : 0) +
      (fundamentals.roic?.value == null ? 1 : 0) +
      (fundamentals.fcf_over_netincome?.value == null ? 1 : 0);
    penalty += missingRatios * 3; // max -12

    coverage_display = Math.round(Math.max(5, Math.min(100, coverage_display - penalty)));

    // Couleur & verdict basés sur le score affiché (shown)
    const shown = score_adj ?? raw;
    const color: ScorePayload["color"] = shown >= 65 ? "green" : shown >= 50 ? "orange" : "red";

    // Momentum considéré “présent” si la 200DMA est calculable
    const momentumPresent = typeof priceFeed.px_vs_200dma.value === "number";

    const { verdict, reason } = makeVerdict({
      coverage: coverage_display,
      total,
      momentumPresent,
      score_adj: shown,
    });

    const reasons = buildReasons(bundle, subscores);

    const payload: ScorePayload = {
      ticker: t,
      score: raw,
      score_adj,
      color,
      verdict,
      verdict_reason: reason,
      reasons_positive: reasons.slice(0, 3),
      red_flags: [],
      subscores,
      coverage: coverage_display, // ← nouvelle fiabilité
      proof: {
        price_source: priceFeed.meta?.source_primary,
        price_points: priceFeed.meta?.points,
        price_has_200dma: priceFeed.px_vs_200dma.value !== null,
        price_recency_days: priceFeed.meta?.recency_days ?? null,
        valuation_used: (fundamentals.fcf_yield.value ?? fundamentals.earnings_yield.value) != null,
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
    return NextResponse.json(payload, {
      headers: { "Cache-Control": "s-maxage=600, stale-while-revalidate=1200" },
    });
  } catch (e: any) {
    const msg = typeof e?.message === "string" ? e.message : e?.toString?.() || "Erreur provider";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

/* ============================== Helpers généraux ============================== */
const asMetric = (v: number | null, conf = 0, source?: string): Metric => ({ value: v, confidence: conf, source });
const clip = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
const num = (x: any) => (typeof x === "number" && Number.isFinite(x) ? x : null);

/* ============================== v8 chart (prix & momentum) ============================== */
async function fetchYahooChartAndEnrich(ticker: string): Promise<Prices> {
  const urls = [
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=2y&interval=1d`,
    `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=2y&interval=1d`,
  ];
  let js: any = null;
  for (const u of urls) {
    js = await fetchJsonSafe(u, {
      "User-Agent": UA,
      "Accept": "application/json, text/plain, */*",
      "Accept-Language": AL,
    });
    if (js?.chart?.result?.[0]) break;
  }
  const r = js?.chart?.result?.[0];
  if (!r) throw new Error("Aucune donnée de prix (v8)");
  const ts: number[] = (r.timestamp || []).map((t: number) => t * 1000);
  const closes = ((r.indicators?.quote?.[0]?.close || r.indicators?.adjclose?.[0]?.adjclose) || []) as number[];
  const arr = (closes || []).filter((v: any) => typeof v === "number" && Number.isFinite(v));
  if (!arr.length) throw new Error("Clôtures vides (v8)");

  const enriched = enrichCloses(arr);
  return {
    px: asMetric(enriched.px, confFromPts(arr.length), "yahoo"),
    px_vs_200dma: asMetric(enriched.px_vs_200dma, confFromPts(arr.length), "yahoo"),
    pct_52w: asMetric(enriched.pct_52w, confFromPts(arr.length), "yahoo"),
    max_dd_1y: asMetric(enriched.max_dd_1y, confFromPts(arr.length), "yahoo"),
    ret_20d: asMetric(enriched.ret_20d, confFromPts(arr.length), "yahoo"),
    ret_60d: asMetric(enriched.ret_60d, confFromPts(arr.length), "yahoo"),
    meta: {
      source_primary: "yahoo",
      points: arr.length,
      recency_days: Math.round((Date.now() - (ts.at(-1) ?? Date.now())) / (1000 * 3600 * 24)),
    },
  };
}
function enrichCloses(closes: number[]) {
  const last = closes.at(-1) ?? null;
  let px_vs_200dma: number | null = null;
  if (closes.length >= 200 && typeof last === "number") {
    const avg = closes.slice(-200).reduce((a, b) => a + b, 0) / 200;
    if (avg > 0) px_vs_200dma = (last - avg) / avg;
  }
  const last252 = closes.slice(-252);
  let pct_52w: number | null = null,
    max_dd_1y: number | null = null;
  if (last252.length >= 30 && typeof last === "number") {
    const hi = Math.max(...last252),
      lo = Math.min(...last252);
    if (hi > lo) pct_52w = (last - lo) / (hi - lo);
    let peak = last252[0];
    let mdd = 0;
    for (const c of last252) {
      peak = Math.max(peak, c);
      mdd = Math.min(mdd, (c - peak) / peak);
    }
    max_dd_1y = mdd;
  }
  let ret_20d: number | null = null,
    ret_60d: number | null = null;
  if (closes.length >= 21 && typeof last === "number") {
    const prev20 = closes[closes.length - 21];
    if (prev20 > 0) ret_20d = last / prev20 - 1;
  }
  if (closes.length >= 61 && typeof last === "number") {
    const prev60 = closes[closes.length - 61];
    if (prev60 > 0) ret_60d = last / prev60 - 1;
  }
  return { px: last, px_vs_200dma, pct_52w, max_dd_1y, ret_20d, ret_60d };
}
function confFromPts(pts: number) {
  if (pts >= 400) return 0.95;
  if (pts >= 250) return 0.85;
  if (pts >= 120) return 0.7;
  return 0.4;
}

/* ============================== v10 quoteSummary (fundamentaux+annuals) ============================== */
async function fetchYahooV10(ticker: string, sess: YSession, retryOnce: boolean): Promise<any> {
  const base = {
    "User-Agent": UA,
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": AL,
    Origin: "https://finance.yahoo.com",
    Referer: "https://finance.yahoo.com/",
    ...(sess.cookie ? { Cookie: sess.cookie } as any : {}),
  };
  const crumbQS = sess.crumb ? `&crumb=${encodeURIComponent(sess.crumb)}` : "";
  const modules =
    "financialData,defaultKeyStatistics,price,summaryDetail,incomeStatementHistory,balanceSheetHistory";
  const urls = [
    `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(
      ticker
    )}?modules=${modules}${crumbQS}`,
    `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(
      ticker
    )}?modules=${modules}${crumbQS}`,
  ];
  for (const u of urls) {
    const res = await fetch(u, { headers: base });
    if (res.status === 401 && retryOnce) {
      const s2 = await getYahooSession();
      return fetchYahooV10(ticker, s2, /*retryOnce*/ false);
    }
    if (res.ok) {
      const js = await res.json();
      const r = js?.quoteSummary?.result?.[0];
      if (r) return r;
    }
  }
  throw new Error("QuoteSummary indisponible");
}

function computeFundamentalsFromV10(r: any): Fundamentals {
  // --- existants ---
  const price = num(r?.price?.regularMarketPrice?.raw ?? r?.price?.regularMarketPrice);
  const shares = num(r?.defaultKeyStatistics?.sharesOutstanding?.raw ?? r?.defaultKeyStatistics?.sharesOutstanding);
  const trailingPE = num(r?.summaryDetail?.trailingPE?.raw ?? r?.defaultKeyStatistics?.trailingPE?.raw);
  const priceToBook = num(r?.defaultKeyStatistics?.priceToBook?.raw ?? r?.defaultKeyStatistics?.priceToBook);
  const currentRatio = num(r?.financialData?.currentRatio?.raw ?? r?.financialData?.currentRatio);
  const fcf = num(r?.financialData?.freeCashflow?.raw ?? r?.financialData?.freeCashflow);
  const opm = num(r?.financialData?.operatingMargins?.raw ?? r?.financialData?.operatingMargins);
  const cash = num(r?.financialData?.totalCash?.raw ?? r?.financialData?.totalCash);
  const debt = num(r?.financialData?.totalDebt?.raw ?? r?.financialData?.totalDebt);

  // --- nouveaux (annual) ---
  const ishs: any[] = r?.incomeStatementHistory?.incomeStatementHistory || [];
  const bsh: any[] = r?.balanceSheetHistory?.balanceSheetStatements || [];

  const ni0 = num(ishs?.[0]?.netIncome?.raw ?? ishs?.[0]?.netIncome);
  const opInc0 = num(ishs?.[0]?.operatingIncome?.raw ?? ishs?.[0]?.operatingIncome);
  const taxExp0 = num(ishs?.[0]?.incomeTaxExpense?.raw ?? ishs?.[0]?.incomeTaxExpense);
  const preTax0 = num(ishs?.[0]?.incomeBeforeTax?.raw ?? ishs?.[0]?.incomeBeforeTax);

  const eq0 = num(bsh?.[0]?.totalStockholderEquity?.raw ?? bsh?.[0]?.totalStockholderEquity);
  const eq1 = num(bsh?.[1]?.totalStockholderEquity?.raw ?? bsh?.[1]?.totalStockholderEquity);
  const assets0 = num(bsh?.[0]?.totalAssets?.raw ?? bsh?.[0]?.totalAssets);

  // EY & FCFY
  const ey = trailingPE && trailingPE > 0 ? 1 / trailingPE : null;
  const mc = price && shares ? price * shares : null;
  const fcfy = mc && fcf != null ? fcf / mc : null;

  // net_cash proxy
  let netCash: number | null = null;
  if (cash != null && debt != null) netCash = cash - debt > 0 ? 1 : 0;
  else if (priceToBook && priceToBook > 0) netCash = priceToBook < 1.2 ? 1 : 0;

  // ROE (direct si dispo, sinon calc NI / avg equity)
  const roe_direct = num(r?.financialData?.returnOnEquity?.raw ?? r?.financialData?.returnOnEquity);
  const avgEq = eq0 != null && eq1 != null ? (eq0 + eq1) / 2 : eq0 ?? null;
  const roe_calc = ni0 != null && avgEq ? (avgEq !== 0 ? ni0 / avgEq : null) : null;
  const roe = roe_direct ?? roe_calc;

  // ROA (direct si dispo, sinon NI / Assets)
  const roa_direct = num(r?.financialData?.returnOnAssets?.raw ?? r?.financialData?.returnOnAssets);
  const roa = roa_direct ?? (ni0 != null && assets0 ? (assets0 !== 0 ? ni0 / assets0 : null) : null);

  // FCF / Net Income
  const fcf_over_ni = fcf != null && ni0 != null && ni0 !== 0 ? fcf / ni0 : null;

  // ROIC ~ NOPAT / (Debt + Equity - Cash)
  const taxRate =
    preTax0 && taxExp0 != null && preTax0 !== 0 ? Math.min(0.5, Math.max(0, taxExp0 / preTax0)) : 0.21;
  const nopat = opInc0 != null ? opInc0 * (1 - taxRate) : (ni0 != null ? ni0 : null);
  const invested =
    (debt ?? null) != null || (eq0 ?? null) != null ? ((debt ?? 0) + (eq0 ?? 0) - (cash ?? 0)) : null;
  const roic = nopat != null && invested && invested !== 0 ? nopat / invested : null;

  return {
    op_margin: asMetric(opm, opm != null ? 0.45 : 0, "yahoo-v10"),
    current_ratio: asMetric(currentRatio, currentRatio != null ? 0.4 : 0, "yahoo-v10"),
    fcf_yield: asMetric(fcfy != null ? clampFcfy(fcfy) : null, fcfy != null ? 0.45 : 0, "yahoo-v10"),
    earnings_yield: asMetric(ey, ey != null ? 0.45 : 0, "yahoo-v10"),
    net_cash: asMetric(netCash, netCash != null ? 0.35 : 0, "yahoo-v10"),

    roe: asMetric(roe ?? null, roe != null ? 0.45 : 0, roe_direct != null ? "yahoo-v10" : "calc"),
    roa: asMetric(roa ?? null, roa != null ? 0.4 : 0, roa_direct != null ? "yahoo-v10" : "calc"),
    fcf_over_netincome: asMetric(fcf_over_ni, fcf_over_ni != null ? 0.35 : 0, "calc"),
    roic: asMetric(roic, roic != null ? 0.3 : 0, "calc"),
  };
}
const clampFcfy = (y: number) => Math.max(-0.05, Math.min(0.08, y));

/* ============================== Scoring ============================== */
function computeScore(d: DataBundle) {
  const f = d.fundamentals,
    p = d.prices;

  // Qualité (35) — plafond interne 8
  let q = 0, qMax = 0;
  if (typeof f.op_margin.value === "number") {
    qMax += 8;
    q += f.op_margin.value >= 0.25 ? 8 : f.op_margin.value >= 0.15 ? 6 : f.op_margin.value >= 0.05 ? 3 : 0;
  }

  // Sécurité (25) — plafond interne 6 (4 + 2)
  let s = 0, sMax = 0;
  if (typeof f.current_ratio.value === "number") {
    sMax += 4;
    s += f.current_ratio.value > 1.5 ? 4 : f.current_ratio.value >= 1 ? 2 : 0;
  }
  if (typeof f.net_cash.value === "number") {
    sMax += 2;
    s += f.net_cash.value > 0 ? 2 : 0;
  }

  // Valorisation (25) — plafond interne 10
  let v = 0, vMax = 0;
  if (typeof f.fcf_yield.value === "number") {
    vMax += 10;
    const y = f.fcf_yield.value;
    v += y > 0.06 ? 10 : y >= 0.04 ? 7 : y >= 0.02 ? 4 : 1;
  } else if (typeof f.earnings_yield.value === "number") {
    vMax += 10;
    const y = f.earnings_yield.value;
    v += y > 0.07 ? 9 : y >= 0.05 ? 6 : y >= 0.03 ? 3 : 1;
  }

  // Momentum (15) — plafond interne 15
  let m = 0, mMax = 0;
  if (typeof p.px_vs_200dma.value === "number") {
    mMax += 10;
    m += p.px_vs_200dma.value >= 0.05 ? 10 : p.px_vs_200dma.value > -0.05 ? 6 : 2;
  }
  if (typeof p.ret_20d.value === "number") {
    mMax += 3;
    m += p.ret_20d.value > 0.03 ? 3 : p.ret_20d.value > 0 ? 2 : 0;
  }
  if (typeof p.ret_60d.value === "number") {
    mMax += 2;
    m += p.ret_60d.value > 0.06 ? 2 : p.ret_60d.value > 0 ? 1 : 0;
  }
  // borne logique côté score
  m = Math.min(m, 15);
  // mMax reste ce qui est réellement disponible (0..15)

  const subscores = {
    quality: clip(q, 0, 35),
    safety: clip(s, 0, 25),
    valuation: clip(v, 0, 25),
    momentum: clip(m, 0, 15),
  };
  const maxes = { quality: qMax, safety: sMax, valuation: vMax, momentum: mMax };
  return { subscores, maxes };
}

function buildReasons(_d: DataBundle, subs: Record<string, number>) {
  const out: string[] = [];
  if (subs.quality >= 6) out.push("Marge opérationnelle décente");
  if (subs.safety >= 4) out.push("Bilans plutôt sains");
  if (subs.valuation >= 7) out.push("Valorisation potentiellement attractive");
  if (subs.momentum >= 8) out.push("Au-dessus de la 200j + dynamique positive");
  if (!out.length) out.push("Données limitées : vérifiez les détails");
  return out;
}

function makeVerdict(args: { coverage: number; total: number; momentumPresent: boolean; score_adj: number }) {
  const { coverage, momentumPresent, score_adj } = args;
  const coverageOk = coverage >= 40; // assoupli pour éviter “À SURVEILLER” partout
  if (score_adj >= 70 && coverageOk && momentumPresent) return { verdict: "sain" as const, reason: "Score élevé et couverture suffisante" };
  if (score_adj >= 50 || momentumPresent) return { verdict: "a_surveiller" as const, reason: "Signal positif mais incomplet" + (coverageOk ? "" : " (couverture limitée)") };
  return { verdict: "fragile" as const, reason: "Signal faible" + (coverageOk ? "" : " (données partielles)") };
}

/* ============================== Fetch util ============================== */
async function fetchJsonSafe(url: string, headers?: Record<string, string>) {
  try {
    const r = await fetch(url, { headers });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}