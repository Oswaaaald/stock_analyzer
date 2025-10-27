// /lib/scoring.ts
import { DataBundle } from "./types";
import { clip } from "./utils";

export function computeScore(d: DataBundle) {
  const f = d.fundamentals, p = d.prices;

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

  // Momentum (15)
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
  m = Math.min(m, 15);

  const subscores = {
    quality: clip(q, 0, 35),
    safety: clip(s, 0, 25),
    valuation: clip(v, 0, 25),
    momentum: clip(m, 0, 15),
  };
  const maxes = { quality: qMax, safety: sMax, valuation: vMax, momentum: mMax };
  return { subscores, maxes };
}

export function buildReasons(_d: DataBundle, subs: Record<string, number>) {
  const out: string[] = [];
  if (subs.quality >= 6) out.push("Entreprise rentable et efficace");
  if (subs.safety >= 4) out.push("Bilans plutôt sains");
  if (subs.valuation >= 7) out.push("Valorisation potentiellement attractive");
  if (subs.momentum >= 8) out.push("Cours au-dessus de la MM200 et dynamique récente positive");
  if (!out.length) out.push("Données limitées : vérifiez les détails");
  return out;
}

export function makeVerdict(args: { coverage: number; total: number; momentumPresent: boolean; score_adj: number }) {
  const { coverage, momentumPresent, score_adj } = args;
  const coverageOk = coverage >= 40;
  if (score_adj >= 70 && coverageOk && momentumPresent)
    return { verdict: "sain" as const, reason: "Score élevé et couverture suffisante" };
  if (score_adj >= 50 || momentumPresent)
    return { verdict: "a_surveiller" as const, reason: "Signal positif mais incomplet" + (coverageOk ? "" : " (couverture limitée)") };
  return { verdict: "fragile" as const, reason: "Signal faible" + (coverageOk ? "" : " (données partielles)") };
}