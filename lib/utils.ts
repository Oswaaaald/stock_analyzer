// /lib/utils.ts
export const asMetric = (v: number | null, conf = 0, source?: string) =>
  ({ value: v, confidence: conf, source });

export const clip = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
export const num = (x: any) => (typeof x === "number" && Number.isFinite(x) ? x : null);
export const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
export const linMap = (x: number, a: number, b: number) => {
  if (!Number.isFinite(x)) return 0.5;
  return clamp01((x - a) / (b - a));
};

export async function fetchJsonSafe(url: string, headers?: Record<string, string>) {
  try {
    const r = await fetch(url, { headers });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}