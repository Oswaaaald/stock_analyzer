"use client";
import { useEffect, useMemo, useRef, useState } from "react";

/* ====================== Types ====================== */
type ScoreResponse = {
  ticker: string;
  score: number;
  score_adj?: number;
  color: "green" | "orange" | "red";
  verdict: "sain" | "a_surveiller" | "fragile";
  verdict_reason: string;
  reasons_positive: string[];
  red_flags: string[];
  subscores: Record<string, number>;
  coverage: number;
  proof?: {
    price_source?: string;
    price_points?: number;
    price_has_200dma: boolean;
    price_recency_days?: number | null;
    valuation_used?: boolean;
    sources_used?: string[];
  };
  ratios?: {
    roe?: number | null;
    roa?: number | null;
    fcf_over_netincome?: number | null;
    roic?: number | null;
  };
};

type SuggestItem = {
  symbol: string;
  name: string;
  exchange: string | null;
  type: string | null;
  currency?: string | null;
  region?: string | null;
  score?: number;
};

const SUGGESTIONS = ["AAPL", "MSFT", "NVDA", "TSLA", "RMS.PA", "MC.PA", "ASML.AS"];

/* ====================== Page ====================== */
export default function Page() {
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<ScoreResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  // autosuggest
  const [sug, setSug] = useState<SuggestItem[]>([]);
  const [showSug, setShowSug] = useState(false);
  const [sugLoading, setSugLoading] = useState(false);
  const debounceId = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const sugRef = useRef<HTMLDivElement | null>(null);
  const suppressSuggestRef = useRef<boolean>(false); // évite réouverture auto

  /* ========= URL param -> auto lookup ========= */
  useEffect(() => {
    const sp = new URLSearchParams(location.search);
    const t = sp.get("ticker");
    if (t) {
      suppressSuggestRef.current = true;
      setQ(t);
      setShowSug(false);
      void lookup(t);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ========= Fetch score ========= */
  async function lookup(ticker?: string) {
    const sym = (ticker ?? q).trim();
    if (!sym) return;
    setLoading(true);
    setError(null);
    setData(null);
    try {
      const res = await fetch(`/api/score/${encodeURIComponent(sym)}`, { cache: "no-store" });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j?.error || `API ${res.status}`);
      }
      const json: ScoreResponse = await res.json();
      setData(json);

      const url = new URL(location.href);
      url.searchParams.set("ticker", sym);
      history.replaceState(null, "", url.toString());
    } catch (e: any) {
      setError(e?.message || "Erreur inconnue");
    } finally {
      setLoading(false);
      setShowSug(false);
      inputRef.current?.blur();
    }
  }

  /* ========= Suggest: debounced fetch ========= */
  useEffect(() => {
    if (!q.trim()) {
      setSug([]);
      setShowSug(false);
      return;
    }
    if (suppressSuggestRef.current) {
      suppressSuggestRef.current = false;
      return;
    }
    if (debounceId.current) clearTimeout(debounceId.current);
    debounceId.current = setTimeout(async () => {
      setSugLoading(true);
      try {
        const u = `/api/suggest?q=${encodeURIComponent(q.trim())}`;
        const r = await fetch(u, { cache: "no-store" });
        if (r.ok) {
          const j = (await r.json()) as { suggestions?: SuggestItem[] };
          const list = (j?.suggestions || []).slice(0, 8);
          setSug(list);
          setShowSug(list.length > 0);
        } else {
          setSug([]);
          setShowSug(false);
        }
      } catch {
        setSug([]);
        setShowSug(false);
      } finally {
        setSugLoading(false);
      }
    }, 200);
    return () => {
      if (debounceId.current) clearTimeout(debounceId.current);
    };
  }, [q]);

  /* ========= Outside click / Escape -> close suggest ========= */
  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (!showSug) return;
      const t = e.target as Node;
      if (sugRef.current && !sugRef.current.contains(t) && inputRef.current && !inputRef.current.contains(t)) {
        setShowSug(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setShowSug(false);
        inputRef.current?.blur();
      }
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [showSug]);

  /* ========= UI helpers ========= */
  const onEnter = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      setShowSug(false);
      lookup();
      inputRef.current?.blur();
    }
  };

  const verdictBadge = useMemo(() => {
    if (!data) return null;
    const map = {
      sain: { label: "SAIN", classes: "bg-emerald-500/10 text-emerald-300 border-emerald-600/50" },
      a_surveiller: { label: "À SURVEILLER", classes: "bg-amber-500/10 text-amber-300 border-amber-600/50" },
      fragile: { label: "FRAGILE", classes: "bg-rose-500/10 text-rose-300 border-rose-600/50" },
    } as const;
    const v = map[data.verdict];
    return <span className={`px-2.5 py-1 rounded-full text-xs border ${v.classes}`}>{v.label}</span>;
  }, [data]);

  // === couleur unique pilotée par le verdict (ruban + barre) ===
  function verdictColor(v: "sain" | "a_surveiller" | "fragile") {
    switch (v) {
      case "sain":
        return "bg-emerald-500";
      case "a_surveiller":
        return "bg-amber-500";
      case "fragile":
        return "bg-rose-500";
    }
  }

  function fmtPct(x?: number | null) {
    return typeof x === "number" ? `${(x * 100).toFixed(1)}%` : "—";
  }

  /* ====================== Render ====================== */
  return (
    <main className="min-h-screen bg-slate-950 text-slate-100">
      {/* Top bar */}
      <header className="sticky top-0 z-30 backdrop-blur supports-[backdrop-filter]:bg-slate-950/60 bg-slate-950/90 border-b border-slate-800">
        <div className="max-w-6xl mx-auto px-5 py-3 flex items-center gap-3">
          <div className="w-2.5 h-2.5 rounded-full bg-sky-500 shadow-[0_0_18px] shadow-sky-500/70" />
          <h1 className="text-lg md:text-xl font-semibold">Stock Analyzer</h1>
          <span className="ml-2 text-xs px-2 py-0.5 rounded-full border border-slate-700 text-slate-300">
            no-key · global
          </span>
          <div className="ml-auto hidden md:flex items-center gap-2 text-xs text-slate-400">
            <span className="hidden sm:inline">Gratuit · sans API key</span>
            <span className="opacity-40">|</span>
            <span>200DMA, Yahoo v10</span>
          </div>
        </div>
      </header>

      {/* Search */}
      <section className="max-w-6xl mx-auto px-5 pt-8">
        <div className="grid gap-4 md:grid-cols-[1fr_auto] relative">
          <div className="flex relative rounded-2xl border border-slate-800 bg-slate-900/40 focus-within:ring-2 focus-within:ring-sky-500">
            <input
              ref={inputRef}
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setShowSug(!!e.target.value);
              }}
              onKeyDown={onEnter}
              placeholder="Tapez un ticker… (AAPL, TSLA, RMS.PA, ASML.AS)"
              className="flex-1 px-4 py-3.5 bg-transparent outline-none placeholder:text-slate-500"
              autoComplete="off"
              aria-autocomplete="list"
              aria-expanded={showSug}
              aria-controls="suggest-list"
              role="combobox"
            />

            {/* Suggest list */}
            {showSug && (
              <div
                ref={sugRef}
                id="suggest-list"
                role="listbox"
                className="absolute left-0 right-0 top-full mt-2 rounded-2xl border border-slate-800 bg-slate-900/95 shadow-xl overflow-hidden z-20"
              >
                {sugLoading && (
                  <div className="px-4 py-3 text-sm text-slate-400 border-b border-slate-800">Recherche…</div>
                )}
                {!sugLoading && sug.length === 0 && (
                  <div className="px-4 py-3 text-sm text-slate-400">Aucun résultat</div>
                )}
                {sug.map((it, i) => (
                  <button
                    key={`${it.symbol}-${i}`}
                    role="option"
                    onClick={() => {
                      suppressSuggestRef.current = true;
                      setQ(it.symbol);
                      setShowSug(false);
                      void lookup(it.symbol);
                      inputRef.current?.blur();
                    }}
                    className="w-full text-left px-4 py-3 hover:bg-slate-800/70 flex items-center gap-3"
                  >
                    <span className="font-mono text-sm text-sky-300">{it.symbol}</span>
                    <span className="text-sm text-slate-200 truncate">{it.name}</span>
                    <span className="ml-auto text-xs text-slate-500">
                      {(it.exchange || "").toUpperCase()}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>

          <button
            onClick={() => {
              suppressSuggestRef.current = true;
              setShowSug(false);
              lookup();
              inputRef.current?.blur();
            }}
            disabled={!q || loading}
            className="px-6 py-3.5 rounded-2xl bg-sky-600 hover:bg-sky-500 disabled:opacity-50 font-medium"
          >
            {loading ? "Analyse…" : "Analyser"}
          </button>
        </div>

        {/* Chips */}
        <div className="flex flex-wrap gap-2 mt-3">
          {SUGGESTIONS.map((t) => (
            <button
              key={t}
              onClick={() => {
                suppressSuggestRef.current = true;
                setQ(t);
                setShowSug(false);
                void lookup(t);
                inputRef.current?.blur();
              }}
              className="text-xs px-2.5 py-1.5 rounded-full border border-slate-800 bg-slate-900/30 hover:bg-slate-800/50 text-slate-300"
            >
              {t}
            </button>
          ))}
        </div>

        {/* Errors */}
        {error && (
          <div className="mt-4 p-4 rounded-2xl bg-rose-950/40 border border-rose-800/60 text-rose-200">
            {error}
          </div>
        )}
      </section>

      {/* Result */}
      {data && (
        <section className="max-w-6xl mx-auto px-5 py-8 grid lg:grid-cols-3 gap-6">
          {/* Left: Score & reasons */}
          <div className="lg:col-span-2">
            <div className="relative overflow-hidden rounded-3xl border border-slate-800 bg-gradient-to-b from-slate-900/60 to-slate-900/30">
              {/* Ribbon */}
              <div className="absolute -right-14 top-6 rotate-45">
                <div className={`px-16 py-1 text-xs tracking-wider text-white/90 ${verdictColor(data.verdict)}`}>
                  {data.verdict.toUpperCase()}
                </div>
              </div>

              <div className="p-6 md:p-7">
                <div className="flex items-start gap-4">
                  <div className="flex-1">
                    <div className="flex items-center gap-3">
                      <h2 className="text-2xl font-semibold tracking-tight">{data.ticker.toUpperCase()}</h2>
                      {verdictBadge}
                      <span className="text-xs px-2 py-0.5 rounded-full border border-slate-700 text-slate-300">
                        Fiabilité {data.coverage}%
                      </span>
                    </div>

                    <p className="mt-1 text-slate-400">{data.verdict_reason}</p>
                  </div>

                  <div className="w-36 shrink-0">
                    <div className="text-4xl font-extrabold tabular-nums text-right">
                      {data.score_adj ?? data.score}
                      <span className="text-lg text-slate-400">/100</span>
                    </div>
                    <div className="mt-2 h-2 rounded-full bg-slate-800 overflow-hidden">
                      <div
                        className={`h-full ${verdictColor(data.verdict)}`}
                        style={{ width: `${Math.min(100, data.score_adj ?? data.score)}%` }}
                      />
                    </div>
                    <div className="mt-1 text-right text-xs text-slate-400">Score (brut) : {data.score}/100</div>
                  </div>
                </div>

                {/* Reasons */}
                <div className="mt-6 grid md:grid-cols-2 gap-5">
                  <div className="p-4 rounded-2xl bg-slate-900/50 border border-slate-800">
                    <h3 className="text-sm uppercase tracking-wide text-slate-400">Raisons principales</h3>
                    <ul className="mt-2 space-y-1.5">
                      {(data.reasons_positive || []).map((r, i) => (
                        <li key={i} className="flex items-start gap-2">
                          <span className="mt-1 w-1.5 h-1.5 rounded-full bg-emerald-400/90" />
                          <span>{r}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                  <div className="p-4 rounded-2xl bg-slate-900/50 border border-slate-800">
                    <h3 className="text-sm uppercase tracking-wide text-slate-400">Drapeaux rouges</h3>
                    <ul className="mt-2 space-y-1.5">
                      {data.red_flags?.length ? (
                        data.red_flags.map((r, i) => (
                          <li key={i} className="flex items-start gap-2">
                            <span className="mt-1 w-1.5 h-1.5 rounded-full bg-rose-400/90" />
                            <span>{r}</span>
                          </li>
                        ))
                      ) : (
                        <li className="flex items-start gap-2">
                          <span className="mt-1 w-1.5 h-1.5 rounded-full bg-slate-500/80" />
                          <span>Aucun majeur détecté</span>
                        </li>
                      )}
                    </ul>
                  </div>
                </div>

                {/* Subscores */}
                <div className="mt-6">
                  <h3 className="text-sm uppercase tracking-wide text-slate-400">Sous-scores</h3>
                  <div className="mt-2 grid grid-cols-2 sm:grid-cols-4 gap-3">
                    {Object.entries(data.subscores || {}).map(([k, v]) => (
                      <div key={k} className="p-4 rounded-2xl bg-slate-900/40 border border-slate-800">
                        <div className="text-xs text-slate-400 capitalize">{k}</div>
                        <div className="text-2xl font-semibold tabular-nums">{Math.round(v)}</div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Ratios */}
                <div className="mt-6">
                  <h3 className="text-sm uppercase tracking-wide text-slate-400">Ratios</h3>
                  <div className="mt-2 grid grid-cols-2 sm:grid-cols-4 gap-3">
                    <RatioCard label="ROE" value={fmtPct(data.ratios?.roe)} />
                    <RatioCard label="ROA" value={fmtPct(data.ratios?.roa)} />
                    <RatioCard label="FCF / RN" value={fmtPct(data.ratios?.fcf_over_netincome)} />
                    <RatioCard label="ROIC (approx.)" value={fmtPct(data.ratios?.roic)} />
                  </div>
                </div>
              </div>
            </div>

            {/* Disclaimer */}
            <p className="mt-3 text-xs text-slate-500">Pas un conseil en investissement. Sources publiques, sans clé.</p>
          </div>

          {/* Right: Proofs */}
          <aside className="lg:col-span-1">
            <div className="rounded-3xl border border-slate-800 bg-slate-900/40 p-5">
              <h3 className="text-sm uppercase tracking-wide text-slate-400">Preuves (sources &amp; fraîcheur)</h3>

              {/* Price block */}
              <div className="mt-3 p-3 rounded-2xl bg-slate-950/40 border border-slate-800">
                <div className="text-xs text-slate-400">Prix</div>
                <div className="mt-1 text-sm">
                  <span className="px-2 py-0.5 rounded-full border border-slate-700 bg-slate-900/60">
                    Source : {data.proof?.price_source || "?"}
                  </span>
                </div>
                <div className="mt-2 flex flex-wrap gap-2 text-xs">
                  {typeof data.proof?.price_points === "number" && <Badge>Points : {data.proof?.price_points}</Badge>}
                  {data.proof?.price_has_200dma && <Badge variant="ok">200DMA OK</Badge>}
                  {typeof data.proof?.price_recency_days === "number" && (
                    <Badge>Fraîcheur : {data.proof?.price_recency_days} j</Badge>
                  )}
                </div>
              </div>

              {/* Valuation */}
              <div className="mt-3 p-3 rounded-2xl bg-slate-950/40 border border-slate-800">
                <div className="text-xs text-slate-400">Valorisation utilisée</div>
                <div className="mt-2">
                  <Badge variant={data.proof?.valuation_used ? "ok" : "warn"}>
                    {data.proof?.valuation_used ? "oui" : "non"}
                  </Badge>
                </div>
              </div>

              {/* Sources */}
              <div className="mt-3 p-3 rounded-2xl bg-slate-950/40 border border-slate-800">
                <div className="text-xs text-slate-400">Sources</div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {(data.proof?.sources_used || []).map((s) => (
                    <SourceChip key={s} src={s} />
                  ))}
                </div>
              </div>
            </div>
          </aside>
        </section>
      )}
    </main>
  );
}

/* ---------------- UI helpers ---------------- */

function Badge({
  children,
  variant = "default",
}: {
  children: React.ReactNode;
  variant?: "default" | "ok" | "warn" | "muted";
}) {
  const map: Record<string, string> = {
    default: "border-slate-700 bg-slate-900/60 text-slate-200",
    ok: "border-emerald-700/50 bg-emerald-500/10 text-emerald-300",
    warn: "border-amber-700/50 bg-amber-500/10 text-amber-300",
    muted: "border-slate-800 bg-slate-900/40 text-slate-400",
  };
  return <span className={`text-xs px-2 py-0.5 rounded-full border ${map[variant]}`}>{children}</span>;
}

function SourceChip({ src }: { src: string }) {
  const label = src.replace(/^price:/, "price · ").replace(/^sec:/, "sec · ");
  const variant =
    /fin-html/.test(src) ? "ok" : /yahoo:html|yahoo:v7|yahoo:summary|yahoo:v10/.test(src) ? "default" : /wikipedia/.test(src) ? "muted" : "default";
  return <Badge variant={variant as any}>{label}</Badge>;
}

function RatioCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="p-4 rounded-2xl bg-slate-900/40 border border-slate-800">
      <div className="text-xs text-slate-400">{label}</div>
      <div className="text-xl md:text-2xl font-semibold tabular-nums mt-0.5">{value}</div>
    </div>
  );
}