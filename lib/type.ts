// lib/types.ts

// --- Metrics de base ---
export type Metric = { value: number | null; confidence: number; source?: string };

// --- Fundamentals extraits de Yahoo v10 ---
export type Fundamentals = {
  op_margin: Metric;
  current_ratio: Metric;
  fcf_yield: Metric;
  earnings_yield: Metric;
  net_cash: Metric;

  // ratios affichage
  roe?: Metric;
  roa?: Metric;
  fcf_over_netincome?: Metric;
  roic?: Metric;
};

// --- Prix + série pour le graphe ---
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

// --- Point “opportunité” pour le bandeau vert/rouge ---
export type OppPoint = { t: number; close: number; opp: number };

// --- Bundle interne au scoring ---
export type DataBundle = {
  ticker: string;
  fundamentals: Fundamentals;
  prices: Prices;
  sources_used: string[];
};

// --- Payload renvoyé par l’API /api/score/[ticker] ---
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

  subscores: Record<string, number>; // { quality:0..35, safety:0..25, valuation:0..25, momentum:0..15, ... }
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