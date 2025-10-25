"use client";
import { useEffect, useState } from "react";

type ScoreResponse = {
  ticker: string;
  score: number;
  score_adj?: number;
  color: "green" | "orange" | "red";
  reasons_positive: string[];
  red_flags: string[];
  subscores: Record<string, number>;
  coverage?: number;
  verdict: "sain" | "a_surveiller" | "fragile";
  verdict_reason: string;
  proof?: {
    price_source?: "yahoo" | "stooq.com" | "stooq.pl";
    price_points?: number;
    price_has_200dma: boolean;
    price_recency_days?: number | null;
    sec_used?: string[];
    sec_note?: string | null;
  };
  debug?: Record<string, any>;
};

type SuggestItem = { symbol: string; shortname: string; exchDisp: string };

export default function Page() {
  const [q, setQ] = useState("");
  const [suggests, setSuggests] = useState<SuggestItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<ScoreResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  // suggestions (Yahoo search)
  useEffect(() => {
    const t = setTimeout(async () => {
      if (!q || q.trim().length < 2) { setSuggests([]); return; }
      try {
        const res = await fetch(`/api/suggest?q=${encodeURIComponent(q.trim())}`);
        const js = await res.json();
        setSuggests(js.items || []);
      } catch { setSuggests([]); }
    }, 250);
    return () => clearTimeout(t);
  }, [q]);

  const lookup = async (symbol?: string) => {
    const tick = (symbol || q).trim();
    if (!tick) return;
    setLoading(true);
    setError(null);
    setData(null);
    try {
      const res = await fetch(`/api/score/${encodeURIComponent(tick)}`, { cache: "no-store" });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j?.error || `API ${res.status}`);
      }
      const json: ScoreResponse = await res.json();
      setData(json);
      setSuggests([]);
      setQ(tick);
    } catch (e: any) {
      setError(e?.message || "Erreur inconnue");
    } finally {
      setLoading(false);
    }
  };

  const onEnter = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") lookup();
  };

  const coverageBadge = (cov?: number) => {
    if (typeof cov !== "number") return null;
    const level =
      cov >= 70 ? "bg-green-600/20 text-green-300 border-green-600/40" :
      cov >= 40 ? "bg-amber-600/20 text-amber-300 border-amber-600/40" :
                  "bg-red-600/20 text-red-300 border-red-600/40";
    return (
      <span className={`px-2 py-1 text-xs rounded-full border ${level}`} title="Part des critères effectivement scorés">
        Fiabilité {cov}%
      </span>
    );
  };

  return (
    <main className="max-w-3xl mx-auto px-6 py-10">
      <h1 className="text-3xl font-bold tracking-tight">Stock Analyzer (no-key, global)</h1>
      <p className="text-slate-400 mt-1">Tape un nom d’entreprise ou un ticker (ex: “Ferrari”, “OR.PA”, “7203.T”, “TSLA”).</p>

      <div className="mt-6 relative">
        <div className="flex gap-2">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onEnter}
            placeholder="AAPL, RACE, OR.PA, 7203.T, TSLA, ..."
            className="flex-1 px-4 py-3 rounded-xl bg-slate-900 border border-slate-700 focus:outline-none focus:ring-2 focus:ring-sky-500"
          />
          <button
            onClick={() => lookup()}
            disabled={!q || loading}
            className="px-5 py-3 rounded-xl bg-sky-600 hover:bg-sky-500 disabled:opacity-50"
          >
            {loading ? "Analyse…" : "Analyser"}
          </button>
        </div>

        {suggests.length > 0 && (
          <div className="absolute z-10 mt-2 w-full rounded-xl border border-slate-700 bg-slate-900/95 backdrop-blur p-2 max-h-72 overflow-auto">
            {suggests.map((s) => (
              <button
                key={s.symbol}
                onClick={() => lookup(s.symbol)}
                className="w-full text-left px-3 py-2 rounded-lg hover:bg-slate-800"
              >
                <div className="font-medium">{s.symbol}</div>
                <div className="text-xs text-slate-400">{s.shortname || "—"} · {s.exchDisp}</div>
              </button>
            ))}
          </div>
        )}
      </div>

      {error && (
        <div className="mt-4 p-3 rounded-xl bg-red-950 border border-red-800 text-red-200">
          {error}
        </div>
      )}

      {data && (
        <div className="mt-8 space-y-6">
          <div className="p-5 rounded-2xl border border-slate-700 bg-slate-900/60">
            {/* Header + verdict */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <h2 className="text-xl font-semibold">{data.ticker.toUpperCase()}</h2>
                {coverageBadge(data.coverage)}
              </div>
              <div className="flex items-center gap-3">
                <span
                  className={`px-2 py-1 text-xs rounded-full border ${
                    data.verdict === "sain"
                      ? "bg-green-600/20 text-green-300 border-green-600/40"
                      : data.verdict === "a_surveiller"
                      ? "bg-amber-600/20 text-amber-300 border-amber-600/40"
                      : "bg-red-600/20 text-red-300 border-red-600/40"
                  }`}
                  title={data.verdict_reason}
                >
                  {data.verdict === "sain" ? "SAIN"
                    : data.verdict === "a_surveiller" ? "À SURVEILLER" : "FRAGILE"}
                </span>
                {/* Mettre le score AJUSTÉ en avant */}
                {"score_adj" in data && typeof data.score_adj === "number" ? (
                  <span className="text-2xl font-bold tabular-nums">{data.score_adj}/100</span>
                ) : (
                  <span className="text-2xl font-bold tabular-nums">{data.score}/100</span>
                )}
              </div>
            </div>
            <div className="text-xs text-slate-400 mt-1">{data.verdict_reason}</div>

            {/* Affiche aussi le score brut à côté, discret */}
            <div className="text-xs text-slate-500">Score (brut): {data.score}/100</div>

            {/* Reasons + flags */}
            <div className="mt-4 grid grid-cols-2 gap-4">
              <div>
                <h3 className="text-sm uppercase tracking-wide text-slate-400">Raisons principales</h3>
                <ul className="mt-2 list-disc pl-5 space-y-1">
                  {data.reasons_positive.map((r, i) => <li key={i}>{r}</li>)}
                </ul>
              </div>
              <div>
                <h3 className="text-sm uppercase tracking-wide text-slate-400">Drapeaux rouges</h3>
                <ul className="mt-2 list-disc pl-5 space-y-1">
                  {data.red_flags.length ? data.red_flags.map((r, i) => <li key={i}>{r}</li>) : <li>Aucun majeur détecté</li>}
                </ul>
              </div>
            </div>

            {/* Subscores */}
            <div className="mt-4">
              <h3 className="text-sm uppercase tracking-wide text-slate-400">Sous-scores</h3>
              <div className="mt-2 grid grid-cols-4 gap-3">
                {Object.entries(data.subscores).map(([k, v]) => (
                  <div key={k} className="p-3 rounded-xl bg-slate-800/60 border border-slate-700">
                    <div className="text-xs text-slate-400">{k}</div>
                    <div className="text-lg font-semibold">{Math.round(v)}</div>
                  </div>
                ))}
              </div>
            </div>

            {/* PROOFS */}
            {"proof" in (data as any) && data.proof && (
              <details className="mt-4 text-xs text-slate-400">
                <summary className="cursor-pointer">Preuves (sources & fraîcheur)</summary>
                <div className="mt-2 space-y-1">
                  <div>
                    Prix: {data.proof.price_source || "—"}
                    {typeof data.proof.price_points === "number" ? ` · ${data.proof.price_points} points` : ""}
                    {data.proof.price_has_200dma ? " · 200DMA OK" : ""}
                    {typeof data.proof.price_recency_days === "number" ? ` · ${data.proof.price_recency_days}j` : ""}
                  </div>
                  <div>
                    SEC: {data.proof.sec_used?.length ? data.proof.sec_used.join(", ") : "—"}
                    {data.proof.sec_note ? ` · ${data.proof.sec_note}` : ""}
                  </div>
                </div>
              </details>
            )}

            {/* DEBUG optionnel */}
            {"debug" in (data as any) && data.debug && (
              <details className="mt-2 text-xs text-slate-400">
                <summary className="cursor-pointer">Debug</summary>
                <pre className="mt-2 whitespace-pre-wrap">
{JSON.stringify((data as any).debug, null, 2)}
                </pre>
              </details>
            )}
          </div>

          <div className="text-xs text-slate-400">Pas un conseil en investissement. Sources publiques, sans clé.</div>
        </div>
      )}
    </main>
  );
}
