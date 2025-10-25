"use client";
import { useState } from "react";

type ScoreResponse = {
  ticker: string;
  score: number;
  color: "green" | "orange" | "red";
  reasons_positive: string[];
  red_flags: string[];
  subscores: Record<string, number>;
};

export default function Page() {
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<ScoreResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const lookup = async () => {
    if (!q) return;
    setLoading(true);
    setError(null);
    setData(null);
    try {
      const res = await fetch(`/api/score/${encodeURIComponent(q.trim())}`, {
        cache: "no-store",
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j?.error || `API ${res.status}`);
      }
      const json: ScoreResponse = await res.json();
      setData(json);
    } catch (e: any) {
      setError(e?.message || "Erreur inconnue");
    } finally {
      setLoading(false);
    }
  };

  const onEnter = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") lookup();
  };

  return (
    <main className="max-w-3xl mx-auto px-6 py-10">
      <h1 className="text-3xl font-bold tracking-tight">Stock Analyzer (no-key)</h1>
      <p className="text-slate-400 mt-1">
        Verdict clair en 2–3 clics. 100% gratuit, sans clé API.
      </p>

      <div className="mt-6 flex gap-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={onEnter}
          placeholder="AAPL, MSFT, NVDA, OR.PA…"
          className="flex-1 px-4 py-3 rounded-xl bg-slate-900 border border-slate-700 focus:outline-none focus:ring-2 focus:ring-sky-500"
        />
        <button
          onClick={lookup}
          disabled={!q || loading}
          className="px-5 py-3 rounded-xl bg-sky-600 hover:bg-sky-500 disabled:opacity-50"
        >
          {loading ? "Analyse…" : "Analyser"}
        </button>
      </div>

      {error && (
        <div className="mt-4 p-3 rounded-xl bg-red-950 border border-red-800 text-red-200">
          {error}
        </div>
      )}

      {data && (
        <div className="mt-8 space-y-6">
          <div className="p-5 rounded-2xl border border-slate-700 bg-slate-900/60">
            <div className="flex items-center justify-between">
              <h2 className="text-xl font-semibold">{data.ticker.toUpperCase()}</h2>
              <div className="flex items-center gap-3">
                <span
                  className={`w-3 h-3 rounded-full ${
                    data.color === "green"
                      ? "bg-green-500"
                      : data.color === "orange"
                      ? "bg-amber-500"
                      : "bg-red-500"
                  }`}
                />
                <span className="text-2xl font-bold tabular-nums">
                  {data.score}/100
                </span>
              </div>
            </div>

            <div className="mt-4 grid grid-cols-2 gap-4">
              <div>
                <h3 className="text-sm uppercase tracking-wide text-slate-400">
                  Raisons principales
                </h3>
                <ul className="mt-2 list-disc pl-5 space-y-1">
                  {data.reasons_positive.map((r, i) => (
                    <li key={i}>{r}</li>
                  ))}
                </ul>
              </div>
              <div>
                <h3 className="text-sm uppercase tracking-wide text-slate-400">
                  Drapeaux rouges
                </h3>
                <ul className="mt-2 list-disc pl-5 space-y-1">
                  {data.red_flags.length ? (
                    data.red_flags.map((r, i) => <li key={i}>{r}</li>)
                  ) : (
                    <li>Aucun majeur détecté</li>
                  )}
                </ul>
              </div>
            </div>

            <div className="mt-4">
              <h3 className="text-sm uppercase tracking-wide text-slate-400">
                Sous-scores
              </h3>
              <div className="mt-2 grid grid-cols-4 gap-3">
                {Object.entries(data.subscores).map(([k, v]) => (
                  <div
                    key={k}
                    className="p-3 rounded-xl bg-slate-800/60 border border-slate-700"
                  >
                    <div className="text-xs text-slate-400">{k}</div>
                    <div className="text-lg font-semibold">
                      {Math.round(v)}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="text-xs text-slate-400">
            Pas un conseil en investissement. Sources publiques, sans clé.
          </div>
        </div>
      )}
    </main>
  );
}
