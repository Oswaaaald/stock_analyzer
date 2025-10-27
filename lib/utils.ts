// /lib/utils.ts

/**
 * Crée un objet Metric standardisé (valeur + confiance + source)
 */
export const asMetric = (v: number | null, conf = 0, source?: string) => ({
  value: typeof v === "number" && Number.isFinite(v) ? v : null,
  confidence: conf,
  source,
});

/**
 * Coupe une valeur dans l’intervalle [lo, hi]
 */
export const clip = (x: number, lo: number, hi: number): number =>
  Math.max(lo, Math.min(hi, x));

/**
 * Force une valeur à rester dans [0, 1]
 */
export const clamp01 = (x: number): number =>
  Math.max(0, Math.min(1, x));

/**
 * Mappe linéairement une valeur x dans [a,b] → [0,1]
 * Retourne 0.5 si x invalide pour éviter les NaN dans les agrégations.
 */
export const linMap = (x: number, a: number, b: number): number => {
  if (!Number.isFinite(x)) return 0.5;
  if (a === b) return 0.5;
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  return clamp01((x - lo) / (hi - lo));
};

/**
 * Convertit une entrée en nombre valide (ou null sinon)
 */
export const num = (x: any): number | null =>
  typeof x === "number" && Number.isFinite(x) ? x : null;

/**
 * Fetch JSON robuste (renvoie null si erreur réseau ou JSON invalide)
 */
export async function fetchJsonSafe(
  url: string,
  headers?: Record<string, string>
) {
  try {
    const r = await fetch(url, { headers });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}