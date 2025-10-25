// lib/valuation.ts
import type { YahooVitals } from "./yahoo";

export type ValuationMetrics = {
  earningsYield: number | null;
  fcfYield: number | null;
};

export function computeValuation(v: YahooVitals): ValuationMetrics {
  const ey =
    v.trailingPE != null && v.trailingPE > 0 ? 1 / v.trailingPE : null;

  let fcfy: number | null = null;
  if (
    v.fcfTTM != null &&
    v.fcfTTM !== 0 &&
    v.price != null &&
    v.price > 0 &&
    v.shares != null &&
    v.shares > 0
  ) {
    const denom = v.price * v.shares;
    fcfy = denom > 0 ? v.fcfTTM / denom : null;
  }

  return { earningsYield: ey, fcfYield: fcfy };
}