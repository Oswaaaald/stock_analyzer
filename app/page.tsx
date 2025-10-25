"use client";
import { useEffect, useMemo, useState } from "react";

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
    price_source?: string;
    price_points?: number;
    price_has_200dma: boolean;
    price_recency_days?: number | null;
    sec_used?: string[];
    sec_note?: string | null;
    valuation_used?: boolean;
    sources_used?: string[];
  };
};

type SuggestItem = { symbol: string; shortname: string; exchDisp: string };

export default function Page() {
  const [q, setQ] = useState("");
  const [suggests, setSuggests] = useState<SuggestItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<ScoreResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  // suggestions via /api/suggest (déjà présent chez toi)
  useEffect(() => {
    const t = setTimeout(async () => {
      if (!q || q.trim().length < 2) { setSuggests([]); return; }
      try {
        const res = await fetch(`/api/suggest?q=${encodeURIComponent(q.trim())}`);
        const js = await res.json();
        setSuggests(js.items || []);
      } catch { setSuggests([]); }
    }, 200);
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
      setData(json); setSuggests([]); setQ(tick);
    } catch (e: any) {
      setError(e?.message || "Erreur inconnue");
    } finally {
      setLoading(false);
    }
  };

  const onEnter = (e: React.KeyboardEvent<HTMLInputElement>) => { if (e.key === "Enter") lookup(); };

  // UI helpers
  const scoreDisplay = useMemo(() => (!data ? 0 : typeof data.score_adj === "number" ? data.score_adj : data.score), [data]);

  const verdictChip = (v: ScoreResponse["verdict"]) =>
    v === "sain" ? "bg-green-600/20 text-green-300 border-green-500/40"
      : v === "a_surveiller" ? "bg-amber-600/20 text-amber-300 border-amber-500/40"
      : "bg-red-600/20 text-red-300 border-red-500/40";

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

  const ringStyle = useMemo(() => {
    const pct = Math.max(0, Math.min(100, scoreDisplay));
    const hue = pct >= 70 ? 140 : pct >= 40 ? 40 : 0;
    const grad = `conic-gradient(hsl(${hue}deg 70% 50%) ${pct * 3.6}deg, rgba(148,163,184,.2) 0)`;
    return { backgroundImage: grad };
  }, [scoreDisplay]);

  return (
    <main className="min-h-screen bg-[radial-gradient(1200px_600px_at_10%_-10%,rgba(56,189,248,.15),transparent),radial-gradient(800px_400px_at_90%_-10%,rgba(94,234,212,.12),transparent)]">
      <div className="max-w-4xl mx-auto px-6 py-10">
        {/* Header */}
        <header className="flex items-center justify-between">
          <h1 className="text-3xl md:text-4xl font-extrabold tracking-tight bg-clip-text text-transparent bg-gradient-to-r from-sky-300 via-emerald-300 to-slate-200">
            Stock Analyzer
          </h1>
          <div className="text-xs text-slate-400">no-key · global</div>
        </header>

        {/* Search */}
        <div className="mt-8 relative">
          <div className="flex items-center gap-2 rounded-2xl bg-slate-900/70 backdrop-blur border border-slate-700 px-3 py-2 shadow-lg ring-1 ring-black/20">
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={onEnter}
              placeholder="Rechercher : AAPL, RACE, OR.PA, 7203.T, TSLA…"
              className="flex-1 bg-transparent px-3 py-3 outline-none placeholder:text-slate-500"
            />
            <button
              onClick={() => lookup()}
              disabled={!q || loading}
              className="px-5 py-2.5 rounded-xl bg-gradient-to-r from-sky-500 to-emerald-500 text-slate-900 font-semibold hover:opacity-95 disabled:opacity-50 transition"
            >
              {loading ? "Analyse…" : "Analyser"}
            </button>
          </div>

          {suggests.length > 0 && (
            <div className="absolute z-10 mt-3 w-full rounded-2xl border border-slate-700 bg-slate-900/95 backdrop-blur p-2 max-h-72 overflow-auto shadow-2xl">
              {suggests.map((s) => (
                <button
                  key={s.symbol}
                  onClick={() => lookup(s.symbol)}
                  className="w-full text-left px-3 py-2 rounded-xl hover:bg-slate-800/70 transition"
                >
                  <div className="font-medium text-slate-100">{s.symbol}</div>
                  <div className="text-xs text-slate-400">{s.shortname || "—"} · {s.exchDisp}</div>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Error */}
        {error && (
          <div className="mt-6 p-4 rounded-2xl bg-red-900/30 border border-red-700 text-red-100">
            {error}
          </div>
        )}

        {/* Result */}
        {data && (
          <section className="mt-8">
            <div className="rounded-3xl border border-slate-700/70 bg-slate-900/60 backdrop-blur shadow-xl p-6 md:p-8">
              {/* Top row */}
              <div className="grid grid-cols-1 md:grid-cols-[1fr_auto] gap-6 items-center">
                <div className="space-y-2">
                  <div className="flex items-center gap-3 flex-wrap">
                    <h2 className="text-2xl md:text-3xl font-bold tracking-tight">{data.ticker.toUpperCase()}</h2>
                    {coverageBadge(data.coverage)}
                    <span
                      className={`px-2 py-1 text-xs rounded-full border ${
                        data.verdict === "sain" ? "bg-green-600/20 text-green-300 border-green-500/40"
                        : data.verdict === "a_surveiller" ? "bg-amber-600/20 text-amber-300 border-amber-500/40"
                        : "bg-red-600/20 text-red-300 border-red-500/40"
                      }`}
                      title={data.verdict_reason}
                    >
                      {data.verdict === "sain" ? "SAIN" : data.verdict === "a_surveiller" ? "À SURVEILLER" : "FRAGILE"}
                    </span>
                  </div>
                  <div className="text-sm text-slate-400">{data.verdict_reason}</div>
                  <div className="text-xs text-slate-500">Score (brut) : {data.score}/100</div>
                </div>

                {/* Score ring */}
                <div className="mx-auto md:mx-0">
                  <div className="relative w-28 h-28 rounded-full p-[6px] bg-slate-800/60 border border-slate-700">
                    <div className="absolute inset-0 m-[6px] rounded-full" style={ringStyle} />
                    <div className="relative w-full h-full rounded-full bg-slate-950/80 flex items-center justify-center">
                      <div className="text-center">
                        <div className="text-3xl font-extrabold tabular-nums">{scoreDisplay}</div>
                        <div className="text-[10px] uppercase tracking-wide text-slate-400">/100</div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* Reasons & flags */}
              <div className="mt-6 grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="rounded-2xl bg-slate-900/70 border border-slate-800 p-4">
                  <h3 className="text-sm uppercase tracking-wide text-slate-400">Raisons principales</h3>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {data.reasons_positive.map((r, i) => (
                      <span key={i} className="px-3 py-1 rounded-full bg-slate-800/60 border border-slate-700 text-sm">
                        {r}
                      </span>
                    ))}
                  </div>
                </div>
                <div className="rounded-2xl bg-slate-900/70 border border-slate-800 p-4">
                  <h3 className="text-sm uppercase tracking-wide text-slate-400">Drapeaux rouges</h3>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {data.red_flags.length ? data.red_flags.map((r, i) => (
                      <span key={i} className="px-3 py-1 rounded-full bg-red-900/20 border border-red-800/60 text-sm text-red-200">
                        {r}
                      </span>
                    )) : (
                      <span className="px-3 py-1 rounded-full bg-slate-800/60 border border-slate-700 text-sm">
                        Aucun majeur détecté
                      </span>
                    )}
                  </div>
                </div>
              </div>

              {/* Subscores bars */}
              <div className="mt-6">
                <h3 className="text-sm uppercase tracking-wide text-slate-400">Sous-scores</h3>
                <div className="mt-3 space-y-3">
                  {Object.entries(data.subscores).map(([k, v]) => {
                    const max = k === "momentum" ? 15 : k === "quality" ? 35 : k === "safety" ? 25 : 25;
                    const pct = Math.max(0, Math.min(100, Math.round((v / max) * 100)));
                    return (
                      <div key={k}>
                        <div className="flex items-center justify-between text-xs mb-1">
                          <span className="capitalize text-slate-300">{k}</span>
                          <span className="tabular-nums text-slate-400">{Math.round(v)}</span>
                        </div>
                        <div className="h-2.5 rounded-full bg-slate-800 overflow-hidden">
                          <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, backgroundImage: "linear-gradient(90deg, #22d3ee, #34d399)" }} />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Proofs & sources */}
              {data.proof && (
                <details className="mt-6 text-xs text-slate-400 group">
                  <summary className="cursor-pointer inline-flex items-center gap-2">
                    <span className="w-1.5 h-1.5 rounded-full bg-slate-500 group-open:bg-emerald-400 transition" />
                    Preuves (sources & fraîcheur)
                  </summary>
                  <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-3">
                    <div className="rounded-xl bg-slate-900/60 border border-slate-800 p-3">
                      <div className="text-[11px] uppercase tracking-wide text-slate-500 mb-1">Prix</div>
                      <div>Source : {data.proof.price_source || "—"}</div>
                      <div>Points : {typeof data.proof.price_points === "number" ? data.proof.price_points : "—"}</div>
                      <div>{data.proof.price_has_200dma ? "200DMA OK" : "200DMA indisponible"}</div>
                      <div>Fraîcheur : {typeof data.proof.price_recency_days === "number" ? `${data.proof.price_recency_days} j` : "—"}</div>
                    </div>
                    <div className="rounded-xl bg-slate-900/60 border border-slate-800 p-3">
                      <div className="text-[11px] uppercase tracking-wide text-slate-500 mb-1">Compta (SEC)</div>
                      <div>Taxonomies : {data.proof.sec_used?.length ? data.proof.sec_used.join(", ") : "—"}</div>
                      <div>Note : {data.proof.sec_note || "—"}</div>
                      <div>Valuation utilisée : {data.proof.valuation_used ? "oui" : "non"}</div>
                    </div>
                  </div>

                  {!!data.proof.sources_used?.length && (
                    <div className="mt-3 flex flex-wrap gap-2">
                      {data.proof.sources_used.map((s, i) => (
                        <span key={i} className="px-2 py-1 rounded-full bg-slate-800/60 border border-slate-700">
                          {s}
                        </span>
                      ))}
                    </div>
                  )}
                </details>
              )}
            </div>

            <div className="mt-4 text-xs text-slate-400">Pas un conseil en investissement. Sources publiques, sans clé.</div>
          </section>
        )}
      </div>
    </main>
  );
}
