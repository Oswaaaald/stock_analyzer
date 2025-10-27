// /lib/pillars.ts

export type Metrics = {
  // Qualité
  roe?: number | null;              // ex: 0.18 = 18%
  roic?: number | null;             // ex: 0.12
  netMargin?: number | null;        // marge nette
  fcfOverNetIncome?: number | null; // FCF / Net Income
  marginStability?: number | null;  // 0..1 (stabilité des marges sur 5 ans)

  // Solidité
  debtToEquity?: number | null;     // dette / capitaux propres
  netDebtToEbitda?: number | null;  // net debt / EBITDA
  interestCoverage?: number | null; // EBIT / intérêts
  currentRatio?: number | null;     // liquidité CT

  // Valorisation
  pe?: number | null;
  evToEbitda?: number | null;
  fcfYield?: number | null;         // FCF / MarketCap (0.08 = 8%)
  earningsYield?: number | null;    // 1/PE

  // Croissance
  cagrRevenue3y?: number | null;    // 3y CAGR ventes
  cagrEps3y?: number | null;        // 3y CAGR EPS
  forwardRevGrowth?: number | null; // consensus / guide management

  // Momentum
  perf6m?: number | null;           // perf prix 6m (0.12 = +12%)
  perf12m?: number | null;          // perf prix 12m
  above200dma?: boolean | null;     // prix > MM200 ?
  rsi?: number | null;              // 0..100

  // Moat (proxies)
  roicPersistence?: number | null;  // 0..1 (ROIC > WACC sur 5 ans)
  grossMarginLevel?: number | null; // marge brute niveau (0..1 vs pairs/sector)
  marketShareTrend?: number | null; // 0..1 amélioration part de marché

  // ESG (proxies)
  esgScore?: number | null;         // 0..100 si dispo
  controversiesLow?: boolean | null;

  // Gouvernance / retour actionnaire
  dividendCagr3y?: number | null;   // 0.05 = 5%/an
  payoutRatio?: number | null;      // dividende / bénéfice
  buybackYield?: number | null;     // rachats / mkt cap
  insiderOwnership?: number | null; // 0..1
};

export type PillarScores = {
  quality: number;     // /35
  safety: number;      // /25
  valuation: number;   // /25
  growth: number;      // /15
  momentum: number;    // /15
  moat: number;        // /10
  esg: number;         // /5
  governance: number;  // /5
};

export type ComputeResult = {
  subscores: PillarScores;
  coverage: number;            // 0..100
  reasons_positive: string[];
  red_flags: string[];
};

// ----------------- helpers -----------------
const nz = (v: number | null | undefined) => (typeof v === "number" && isFinite(v) ? v : null);
const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));

/** Map linéaire robuste -> 0..1 (supporte v1 < v0, v1 = v0) */
function lin(v: number | null, v0: number, v1: number, invert = false) {
  if (v == null || !isFinite(v)) return null;
  if (v0 === v1) return 0;
  const lo = Math.min(v0, v1), hi = Math.max(v0, v1);
  let t = (v - lo) / (hi - lo);
  t = clamp(t, 0, 1);
  return invert ? 1 - t : t;
}

/** Sweet-spot triangulaire : lo..a ↗, a..b = 1, b..hi ↘ (tout normalisé 0..1) */
function sweetSpot(x: number | null | undefined, a: number, b: number, lo: number, hi: number) {
  const v = nz(x);
  if (v == null) return 0.5;
  if (a > b) [a, b] = [b, a];
  if (lo > hi) [lo, hi] = [hi, lo];
  if (v <= lo || v >= hi) return 0;
  if (v <= a) return (v - lo) / (a - lo);
  if (v <= b) return 1;
  return 1 - (v - b) / (hi - b);
}

// ----------------- core -----------------
export function computePillars(m: Metrics): ComputeResult {
  const reasons: string[] = [];
  const flags: string[] = [];
  let fieldsPresent = 0, fieldsTotal = 0;

  // compte un champ comme "présent" même si la valeur est 0 ou false
  function has(x: any) { fieldsTotal++; if (x !== undefined && x !== null && !(typeof x === "number" && !isFinite(x))) fieldsPresent++; }

  // ---- Quality /35
  has(m.roe); has(m.roic); has(m.netMargin); has(m.fcfOverNetIncome); has(m.marginStability);
  const q_roe  = lin(nz(m.roe), 0.08, 0.25) ?? 0;              // 8% → ok ; 25% → top
  const q_roic = lin(nz(m.roic), 0.07, 0.20) ?? 0;
  const q_nm   = lin(nz(m.netMargin), 0.05, 0.25) ?? 0;
  const q_fcf  = lin(nz(m.fcfOverNetIncome), 0.6, 1.2) ?? 0;   // FCF ≳ RN apprécié
  const q_stab = clamp(nz(m.marginStability) ?? 0, 0, 1);
  let s_quality = (q_roe*0.28 + q_roic*0.28 + q_nm*0.18 + q_fcf*0.16 + q_stab*0.10) * 35;

  if ((m.roic ?? 0) > 0.15 && (m.marginStability ?? 0) > 0.6) reasons.push("ROIC élevé & marges stables");
  if ((m.fcfOverNetIncome ?? 1) < 0.5) flags.push("Conversion FCF→RN faible");

  // ---- Safety /25
  has(m.debtToEquity); has(m.netDebtToEbitda); has(m.interestCoverage); has(m.currentRatio);
  const s_dte   = lin(nz(m.debtToEquity), 2.0, 0.2, true) ?? 0;     // moins = mieux
  const s_ndebt = lin(nz(m.netDebtToEbitda), 3.5, 0.0, true) ?? 0;  // < 0 = net cash
  const s_cov   = lin(nz(m.interestCoverage), 2, 15) ?? 0;
  const s_curr  = lin(nz(m.currentRatio), 1.0, 2.0) ?? 0;
  let s_safety  = (s_dte*0.28 + s_ndebt*0.32 + s_cov*0.24 + s_curr*0.16) * 25;

  if ((m.netDebtToEbitda ?? 0) > 3.5) flags.push("Levier financier élevé");
  if ((m.interestCoverage ?? 999) < 2) flags.push("Couverture des intérêts faible");

  // ---- Valuation /25
  has(m.pe); has(m.evToEbitda); has(m.fcfYield); has(m.earningsYield);
  const v_pe   = lin(nz(m.pe), 30, 10, true) ?? 0;           // 10 meilleur que 30
  const v_ev   = lin(nz(m.evToEbitda), 20, 6, true) ?? 0;
  const v_fcf  = lin(nz(m.fcfYield), 0.02, 0.08) ?? 0;       // 2%→faible ; 8%→top
  const v_ey   = lin(nz(m.earningsYield), 0.03, 0.10) ?? 0;
  let s_valuation = (v_pe*0.30 + v_ev*0.20 + v_fcf*0.35 + v_ey*0.15) * 25;

  if ((m.fcfYield ?? 0) >= 0.08) reasons.push("Rendement FCF attractif");
  if ((m.pe ?? 0) > 40) flags.push("Multiples de valorisation élevés");

  // ---- Growth /15
  has(m.cagrRevenue3y); has(m.cagrEps3y); has(m.forwardRevGrowth);
  const g_rev = lin(nz(m.cagrRevenue3y), 0.00, 0.20) ?? 0;   // 0 → 0 ; 20% → 1
  const g_eps = lin(nz(m.cagrEps3y), 0.00, 0.20) ?? 0;
  const g_fwd = lin(nz(m.forwardRevGrowth), 0.00, 0.15) ?? 0;
  let s_growth = (g_rev*0.35 + g_eps*0.45 + g_fwd*0.20) * 15;

  if ((m.cagrEps3y ?? 0) > 0.15) reasons.push("Croissance EPS soutenue");
  if ((m.cagrRevenue3y ?? 0) < 0) flags.push("Revenus en recul");

  // ---- Momentum /15
  has(m.perf6m); has(m.perf12m); has(m.above200dma); has(m.rsi);
  const mo_6   = lin(nz(m.perf6m),  -0.10, 0.25) ?? 0;
  const mo_12  = lin(nz(m.perf12m), -0.10, 0.35) ?? 0;
  const mo_200 = m.above200dma == null ? 0.5 : (m.above200dma ? 1 : 0);
  // rsi sweet-spot ~45..60 (centre 52.5, demi-largeur 22.5)
  const mo_rsi = m.rsi == null ? 0.5 : clamp(1 - Math.abs((m.rsi - 52.5) / 22.5), 0, 1);
  let s_momentum = (mo_6*0.30 + mo_12*0.35 + mo_200*0.25 + mo_rsi*0.10) * 15;

  // ---- Moat /10
  has(m.roicPersistence); has(m.grossMarginLevel); has(m.marketShareTrend);
  const mt_roic = clamp(nz(m.roicPersistence) ?? 0, 0, 1);
  const mt_gm   = clamp(nz(m.grossMarginLevel) ?? 0, 0, 1);
  const mt_ms   = clamp(nz(m.marketShareTrend) ?? 0, 0, 1);
  let s_moat = (mt_roic*0.5 + mt_gm*0.3 + mt_ms*0.2) * 10;

  if ((m.roicPersistence ?? 0) > 0.6) reasons.push("ROIC > WACC de façon durable (moat)");
  if ((m.marketShareTrend ?? 1) < 0.3) flags.push("Part de marché peu défendue");

  // ---- ESG /5
  has(m.esgScore); has(m.controversiesLow);
  const esg_base  = m.esgScore == null ? 0.5 : clamp((m.esgScore ?? 50) / 100, 0, 1);
  const esg_bonus = m.controversiesLow == null ? 0.0 : (m.controversiesLow ? 0.1 : -0.1);
  let s_esg = clamp(esg_base + esg_bonus, 0, 1) * 5;

  // ---- Governance /5
  has(m.dividendCagr3y); has(m.payoutRatio); has(m.buybackYield); has(m.insiderOwnership);
  const gv_div = lin(nz(m.dividendCagr3y), 0.00, 0.08) ?? 0;
  const gv_pay = sweetSpot(m.payoutRatio, /*a=*/0.30, /*b=*/0.60, /*lo=*/0.00, /*hi=*/1.50);
  const gv_bb  = lin(nz(m.buybackYield), 0.00, 0.04) ?? 0;
  const gv_in  = lin(nz(m.insiderOwnership), 0.00, 0.15) ?? 0;
  let s_gov = (gv_div*0.30 + gv_pay*0.25 + gv_bb*0.25 + gv_in*0.20) * 5;

  if ((m.buybackYield ?? 0) > 0.03) reasons.push("Rachats d’actions significatifs");
  if ((m.payoutRatio ?? 0) > 1.0) flags.push("Payout >100% (risque sur dividende)");

  // ---- Clamp par pilier (sécurité future)
  const subscores: PillarScores = {
    quality:    clamp(s_quality,   0, 35),
    safety:     clamp(s_safety,    0, 25),
    valuation:  clamp(s_valuation, 0, 25),
    growth:     clamp(s_growth,    0, 15),
    momentum:   clamp(s_momentum,  0, 15),
    moat:       clamp(s_moat,      0, 10),
    esg:        clamp(s_esg,       0, 5),
    governance: clamp(s_gov,       0, 5),
  };

  // Couverture = part des champs réellement présents
  const coverage = Math.round((fieldsPresent / Math.max(1, fieldsTotal)) * 100);

  return {
    subscores,
    coverage,
    reasons_positive: reasons,
    red_flags: flags,
  };
}