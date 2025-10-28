// /lib/types.ts
export type Metric = { value: number | null; confidence: number; source?: string };

// ===== Données Yahoo v10 normalisées =====
export type Fundamentals = {
  // Core
  op_margin: Metric;          // financialData.operatingMargins
  current_ratio: Metric;      // financialData.currentRatio
  fcf_yield: Metric;          // FCF / MarketCap
  earnings_yield: Metric;     // 1 / trailingPE
  net_cash: Metric;           // proxy (cash>debt) sinon PB<1.2

  // Ratios avancés (affichage)
  roe?: Metric;
  roa?: Metric;
  fcf_over_netincome?: Metric;
  roic?: Metric;

  // Croissance (alimente Growth)
  rev_growth?: Metric;        // financialData.revenueGrowth (YoY)
  eps_growth?: Metric;        // financialData.earningsGrowth (YoY)

  // -------- Champs additionnels pour couvrir les 8 piliers --------
  // Safety
  debt_to_equity?: Metric;        // totalDebt / totalEquity
  net_debt_to_ebitda?: Metric;    // (debt - cash) / EBITDA
  interest_coverage?: Metric;     // EBIT / interestExpense

  // Valuation
  ev_to_ebitda?: Metric;          // EnterpriseValue / EBITDA

  // Governance
  payout_ratio?: Metric;          // summaryDetail.payoutRatio
  dividend_cagr_3y?: Metric;      // à remplir plus tard si source dispo
  buyback_yield?: Metric;         // à remplir plus tard
  insider_ownership?: Metric;     // defaultKeyStatistics.heldPercentInsiders

  // ESG
  esg_score?: Metric;             // autre source
  controversies_low?: Metric;     // 1 = peu de controverses (proxy)

  // Moat (proxy quantitatif ajouté)
  moat_proxy?: Metric;            // proxy basé sur ROIC/ROE/marge - pénalités levier & décroissance
};

export type Prices = {
  px: Metric;
  px_vs_200dma: Metric;       // (last - MA200)/MA200
  pct_52w: Metric;            // position dans le range 52w (0=low, 1=high)
  max_dd_1y: Metric;
  ret_20d: Metric;
  ret_60d: Metric;
  meta?: { source_primary: "yahoo"; points: number; recency_days: number };
  series?: { ts: number[]; closes: number[] };
};

export type OppPoint = { t: number; close: number; opp: number };

export type DataBundle = {
  ticker: string;
  fundamentals: Fundamentals;
  prices: Prices;
  sources_used: string[];
};

// ===== Types moteur par piliers =====
export type Metrics = {
  // Qualité
  roe?: number | null;
  roic?: number | null;
  netMargin?: number | null;
  fcfOverNetIncome?: number | null;
  marginStability?: number | null;

  // Solidité
  debtToEquity?: number | null;
  netDebtToEbitda?: number | null;
  interestCoverage?: number | null;
  currentRatio?: number | null;

  // Valorisation
  pe?: number | null;
  evToEbitda?: number | null;
  fcfYield?: number | null;
  earningsYield?: number | null;

  // Croissance
  cagrRevenue3y?: number | null;
  cagrEps3y?: number | null;
  forwardRevGrowth?: number | null;

  // Momentum
  perf6m?: number | null;
  perf12m?: number | null;
  above200dma?: boolean | null;
  rsi?: number | null;

  // Moat
  roicPersistence?: number | null;
  grossMarginLevel?: number | null;
  marketShareTrend?: number | null;

  // ✅ Nouveau : proxy unifié (0..1)
  moatProxy?: number | null;

  // ESG
  esgScore?: number | null;
  controversiesLow?: boolean | null;

  // Gouvernance
  dividendCagr3y?: number | null;
  payoutRatio?: number | null;
  buybackYield?: number | null;
  insiderOwnership?: number | null;
};

export type PillarScores = {
  quality: number;     // /35
  safety: number;      // /25
  valuation: number;   // /25
  growth: number;      // /15
  momentum: number;    // /15
  moat: number | null; // /10 (peut être null si proxy manquant)
  esg: number;         // /5
  governance: number;  // /5
};

export type ComputeResult = {
  subscores: PillarScores;
  coverage: number;
  reasons_positive: string[];
  red_flags: string[];
};

// ===== Résultat API =====
export type ScorePayload = {
  ticker: string;
  company_name?: string | null;
  exchange?: string | null;

  score: number;          // 0..100 (somme des 8 piliers, déjà bornée)
  score_adj?: number;     // réservé si tu veux une normalisation différente
  color: "green" | "orange" | "red";
  verdict: "sain" | "a_surveiller" | "fragile";
  verdict_reason: string;

  reasons_positive: string[];
  red_flags: string[];

  subscores: PillarScores;
  coverage: number;

  opportunity_series?: OppPoint[];

  proof?: {
    price_source?: string;
    price_points?: number;
    price_has_200dma: boolean;
    price_recency_days?: number | null;
    price_last_date?: string | null;

    valuation_used?: boolean;
    valuation_metric?: "FCFY" | "EY" | null;

    sources_used?: string[];
  };
  ratios?: {
    roe?: number | null;
    roa?: number | null;
    fcf_over_netincome?: number | null;
    roic?: number | null;
  };
};

export type ScoreResult = {
  score: number;
  pillars: ComputeResult;
  summary: string;
};