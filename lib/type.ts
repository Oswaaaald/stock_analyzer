// /lib/types.ts
export type Metric = { value: number | null; confidence: number; source?: string };

export type Fundamentals = {
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
};

export type Prices = {
  px: Metric;
  px_vs_200dma: Metric;
  pct_52w: Metric;
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

export type ScorePayload = {
  ticker: string;
  company_name?: string | null;
  exchange?: string | null;

  score: number;          // brut 0..100
  score_adj?: number;     // normalisé 0..100
  color: "green" | "orange" | "red";
  verdict: "sain" | "a_surveiller" | "fragile";
  verdict_reason: string;

  reasons_positive: string[];
  red_flags: string[];

  subscores: Record<string, number>; // { quality,safety,valuation,momentum }
  coverage: number;       // 0..100

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