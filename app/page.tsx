// app/page.tsx
"use client";
import React, { useEffect, useMemo, useRef, useState } from "react";

/* ====================== Types ====================== */
type OppPoint = { t: number; close: number; opp: number };

type ScoreResponse = {
  ticker: string;
  company_name?: string | null;
  exchange?: string | null;

  score: number;          // brut 0..100
  score_adj?: number;     // normalisé 0..100 (affiché)
  color: "green" | "orange" | "red";
  verdict: "sain" | "a_surveiller" | "fragile";
  verdict_reason: string;

  reasons_positive: string[];
  red_flags: string[];

  subscores: Record<string, number>; // { quality:0..35, safety:0..25, valuation:0..25, momentum:0..15 }
  coverage: number;       // "Couverture des données" (0..100)

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

type SuggestItem = {
  symbol: string;
  name: string;
  exchange: string | null;
  type: string | null;
  currency?: string | null;
  region?: string | null;
  score?: number;
};

type SelectedMeta = { symbol: string; name?: string | null; exchange?: string | null };

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
  const suppressSuggestRef = useRef<boolean>(false);

  // sélection courante (pour afficher nom complet + place)
  const [selected, setSelected] = useState<SelectedMeta | null>(null);

  /* ========= URL param -> auto lookup ========= */
  useEffect(() => {
    const sp = new URLSearchParams(location.search);
    const t = sp.get("ticker");
    if (t) {
      suppressSuggestRef.current = true;
      setQ(t);
      setShowSug(false);
      setSelected({ symbol: t }); // pas de nom si chargé via URL
      void lookup(t);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ========= Fetch score ========= */
  async function lookup(ticker?: string, meta?: SelectedMeta | null) {
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

      // URL
      const url = new URL(location.href);
      url.searchParams.set("ticker", sym);
      history.replaceState(null, "", url.toString());

      // méta affichage si fourni, sinon fallback sur API (company_name/exchange)
      if (meta) {
        setSelected(meta);
      } else {
        setSelected({
          symbol: sym,
          name: json.company_name ?? undefined,
          exchange: json.exchange ?? undefined,
        });
      }
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
      lookup(undefined, { symbol: q });
      inputRef.current?.blur();
    }
  };

  const verdictBadge = useMemo(() => {
    if (!data) return null;
    const map = {
      sain: { label: "ENTREPRISE SOLIDE", classes: "bg-emerald-500/10 text-emerald-300 border-emerald-600/50" },
      a_surveiller: { label: "ENTREPRISE À SURVEILLER", classes: "bg-amber-500/10 text-amber-300 border-amber-600/50" },
      fragile: { label: "ENTREPRISE FRAGILE", classes: "bg-rose-500/10 text-rose-300 border-rose-600/50" },
    } as const;
    const v = map[data.verdict];
    return <span className={`px-2.5 py-1 rounded-full text-xs border ${v.classes}`}>{v.label}</span>;
  }, [data]);

  function barColor(score: number) {
    if (score >= 70) return "bg-emerald-500";
    if (score >= 50) return "bg-amber-500";
    return "bg-rose-500";
  }

  function fmtPct(x?: number | null) {
    return typeof x === "number" ? `${(x * 100).toFixed(1)}%` : "—";
  }
  // Clamp visuel pour éviter des chiffres absurdes (ex : ROIC proxy)
  function fmtPctClamped(x?: number | null, capAbs = 2.0) {
    if (typeof x !== "number") return "—";
    const capped = Math.max(-capAbs, Math.min(capAbs, x));
    const s = `${(capped * 100).toFixed(1)}%`;
    if (x > capAbs) return `> ${s}`;
    if (x < -capAbs) return `< ${s}`;
    return s;
  }

  // libellés piliers + dénominateurs
  const PILLAR_MAX: Record<string, number> = { quality: 35, safety: 25, valuation: 25, momentum: 15 };
  const PILLAR_LABEL: Record<string, string> = {
    quality: "Qualité opérationnelle",
    safety: "Solidité financière",
    valuation: "Valorisation",
    momentum: "Momentum / Tendance",
  };

  // texte d’interprétation sous le titre
  const interpretation = useMemo(() => {
    if (!data) return "";
    const shown = data.score_adj ?? data.score;
    if (shown >= 70) return "Profil globalement solide sur les piliers clés.";
    if (shown >= 50) return "Profil correct avec des points à surveiller.";
    return "Profil fragile ou données partielles.";
  }, [data]);

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
                      const meta: SelectedMeta = { symbol: it.symbol, name: it.name, exchange: it.exchange };
                      suppressSuggestRef.current = true;
                      setQ(it.symbol);
                      setShowSug(false);
                      setSelected(meta);
                      void lookup(it.symbol, meta);
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
              lookup(undefined, { symbol: q });
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
                setSelected({ symbol: t });
                void lookup(t, { symbol: t });
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
          {/* Left: Score & pillars */}
          <div className="lg:col-span-2">
            <div className="rounded-3xl border border-slate-800 bg-gradient-to-b from-slate-900/60 to-slate-900/30 p-6 md:p-7">
              {/* Header line: name + chips */}
              <div className="flex items-start gap-4">
                <div className="flex-1">
                  <div className="flex flex-col gap-1">
                    <h2 className="text-2xl font-semibold tracking-tight">
                      {selected?.name
                        ? `${selected.name}${selected.exchange ? " — " + selected.exchange?.toUpperCase() : ""}`
                        : (data.company_name
                            ? `${data.company_name}${data.exchange ? " — " + data.exchange?.toUpperCase() : ""}`
                            : data.ticker.toUpperCase())}
                    </h2>

                    <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-4 text-xs">
                      <abbr title="Estimation de la part des données réellement disponibles pour calculer la note finale.">
                        <span className="px-2 py-0.5 rounded-full border border-slate-700 text-slate-300 whitespace-nowrap">
                          Couverture des données&nbsp;: {data.coverage}%
                        </span>
                      </abbr>
                      <span className="whitespace-nowrap">{verdictBadge}</span>
                    </div>
                  </div>

                  {/* Interpretation (à gauche) */}
                  <div className="mt-2 text-slate-300 text-sm">{interpretation}</div>
                </div>

                {/* Score block (en haut à droite) */}
                <div className="w-40 shrink-0">
                  <div className="text-4xl font-extrabold tabular-nums text-right">
                    {data.score_adj ?? data.score}
                    <span className="text-lg text-slate-400">/100</span>
                  </div>
                  <div className="mt-2 h-2 rounded-full bg-slate-800 overflow-hidden">
                    <div
                      className={`h-full ${barColor(data.score_adj ?? data.score)}`}
                      style={{ width: `${Math.min(100, data.score_adj ?? data.score)}%` }}
                    />
                  </div>
                  <div className="mt-1 text-right text-xs text-slate-500">
                    <abbr title="Note brute issue de la somme des sous-scores, sans normalisation par la couverture.">
                      Note brute&nbsp;: {data.score}/100
                    </abbr>
                  </div>
                </div>
              </div>

              {/* ======== Opportunity Chart ======== */}
              {data.opportunity_series?.length ? (
                <div className="mt-6">
                  <h3 className="text-sm uppercase tracking-wide text-slate-400">
                    Opportunité d’achat (passé & présent)
                  </h3>
                  <OpportunityChart rows={data.opportunity_series} />
                  <p className="mt-2 text-xs text-slate-500">
                    Bandeau rouge→vert&nbsp;: plus c’est vert, plus l’opportunité semblait favorable ce jour-là
                    (mix qualité/sécurité, “prix attractif” vs 52s et momentum vs MM200).
                  </p>
                </div>
              ) : null}

              {/* Pillars */}
              <div className="mt-6">
                <h3 className="text-sm uppercase tracking-wide text-slate-400">Piliers de performance</h3>
                <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {Object.entries(data.subscores || {}).map(([k, v]) => {
                    const PILLAR_MAX: Record<string, number> = { quality: 35, safety: 25, valuation: 25, momentum: 15 };
                    const PILLAR_LABEL: Record<string, string> = {
                      quality: "Qualité opérationnelle",
                      safety: "Solidité financière",
                      valuation: "Valorisation",
                      momentum: "Momentum / Tendance",
                    };
                    const max = PILLAR_MAX[k] ?? 10;
                    const pct = Math.max(0, Math.min(100, (v / max) * 100));
                    const tips: Record<string, string> = {
                      quality: "Rentabilité & efficacité opérationnelle",
                      safety: "Liquidité, levier & trésorerie",
                      valuation: "Rendement FCF / bénéfices vs prix",
                      momentum: "Prix vs moyenne mobile 200 jours + performance récente",
                    };
                    return (
                      <div key={k} className="p-4 rounded-2xl bg-slate-900/40 border border-slate-800">
                        <div className="flex items-center justify-between">
                          <abbr title={tips[k] || ""} className="no-underline">
                            <div className="text-sm">{PILLAR_LABEL[k] || k}</div>
                          </abbr>
                          <abbr title={`Sous-score ${PILLAR_LABEL[k] || k}: ${Math.round(v)} sur ${max}`} className="no-underline">
                            <div className="text-sm font-semibold tabular-nums">{Math.round(v)} / {max}</div>
                          </abbr>
                        </div>
                        <div className="mt-2 h-2 rounded-full bg-slate-800 overflow-hidden">
                          <div className="h-full bg-slate-300" style={{ width: `${pct}%` }} />
                        </div>
                        <div className="mt-1 text-xs text-slate-500">{tips[k]}</div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Strengths & Risks */}
              <div className="mt-6 grid md:grid-cols-2 gap-5">
                <div className="p-4 rounded-2xl bg-slate-900/50 border border-slate-800">
                  <h3 className="text-sm uppercase tracking-wide text-slate-400">Points forts détectés</h3>
                  <ul className="mt-2 space-y-1.5">
                    {data.reasons_positive?.length ? (
                      data.reasons_positive.map((r, i) => (
                        <li key={i} className="flex items-start gap-2">
                          <span className="mt-1 w-1.5 h-1.5 rounded-full bg-emerald-400/90" />
                          <span>{r}</span>
                        </li>
                      ))
                    ) : (
                      <li className="text-slate-400 text-sm">—</li>
                    )}
                  </ul>
                </div>
                <div className="p-4 rounded-2xl bg-slate-900/50 border border-slate-800">
                  <h3 className="text-sm uppercase tracking-wide text-slate-400">Risques ou limites</h3>
                  <ul className="mt-2 space-y-1.5">
                    {data.red_flags?.length ? (
                      data.red_flags.map((r, i) => (
                        <li key={i} className="flex items-start gap-2">
                          <span className="mt-1 w-1.5 h-1.5 rounded-full bg-rose-400/90" />
                          <span>{r}</span>
                        </li>
                      ))
                    ) : (
                      <li className="text-slate-400 text-sm">Aucun point de vigilance majeur détecté</li>
                    )}
                  </ul>
                </div>
              </div>

              {/* Ratios */}
              <div className="mt-6">
                <h3 className="text-sm uppercase tracking-wide text-slate-400">Ratios</h3>
                <div className="mt-2 grid grid-cols-2 sm:grid-cols-4 gap-3">
                  <RatioCard label="ROE" value={fmtPctClamped(data.ratios?.roe)} />
                  <RatioCard label="ROA" value={fmtPctClamped(data.ratios?.roa)} />
                  <RatioCard label="FCF / RN" value={fmtPctClamped(data.ratios?.fcf_over_netincome)} />
                  <RatioCard label="ROIC (approx.)" value={fmtPctClamped(data.ratios?.roic)} />
                </div>
              </div>
            </div>

            {/* Disclaimer */}
            <p className="mt-3 text-xs text-slate-500">Pas un conseil en investissement. Sources publiques, sans clé.</p>
          </div>

          {/* Right: Proofs */}
          <aside className="lg:col-span-1">
            <div className="rounded-3xl border border-slate-800 bg-slate-900/40 p-5">
              <h3 className="text-sm uppercase tracking-wide text-slate-400">Sources &amp; fraîcheur</h3>

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
                  {data.proof?.price_last_date && <Badge>Dernier prix : {data.proof?.price_last_date}</Badge>}
                </div>
              </div>

              {/* Valuation */}
              <div className="mt-3 p-3 rounded-2xl bg-slate-950/40 border border-slate-800">
                <div className="text-xs text-slate-400">Valorisation utilisée</div>
                <div className="mt-2 flex items-center gap-2">
                  <Badge variant={data.proof?.valuation_used ? "ok" : "warn"}>
                    {data.proof?.valuation_used ? "oui" : "non"}
                  </Badge>
                  {data.proof?.valuation_metric && (
                    <Badge variant="muted">
                      Métrique : {data.proof.valuation_metric}
                    </Badge>
                  )}
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

/* ---------------- Opportunity Chart ---------------- */
function OpportunityChart({ rows }: { rows: { t: number; close: number; opp: number }[] }) {
  // --- Dimensions & mise en page -------------------------------------------
  const W = 760;                 // largeur logique du SVG
  const H = 260;                 // hauteur totale compacte
  const M = { top: 16, right: 48, bottom: 34, left: 56 }; // marges pour axes/labels
  const innerW = W - M.left - M.right;
  const priceH = 150;            // hauteur de la zone prix
  const bandH = 20;              // hauteur de la bande "opportunité"
  const gap = 8;                 // petit espace entre la courbe et la bande
  const bandY = priceH + gap;    // position verticale de la bande
  const axisY = bandY + bandH + 8; // axe X juste sous la bande

  const n = rows.length || 0;
  if (n === 0) {
    return (
      <div className="mt-2 rounded-2xl border border-slate-800 bg-slate-900/40 p-6 text-sm text-slate-400">
        Pas assez de données pour afficher le graphique.
      </div>
    );
  }

  // --- Scales ---------------------------------------------------------------
  const closes = rows.map(r => r.close);
  const pMin = Math.min(...closes);
  const pMax = Math.max(...closes);

  const x = (i: number) => (i * innerW) / Math.max(1, n - 1);
  const y = (p: number) =>
    priceH - ((p - pMin) * priceH) / Math.max(1e-9, pMax - pMin);

  // Chemin de la courbe
  const path = rows.map((r, i) => `${i === 0 ? "M" : "L"} ${x(i)} ${y(r.close)}`).join(" ");

  // Recalibrage local de l’opportunité (couleurs rouge→vert)
  const oppVals = rows.map(r => r.opp);
  const oMin = Math.min(...oppVals), oMax = Math.max(...oppVals);
  const scaleOpp01 = (v: number) => (oMax > oMin ? (v - oMin) / (oMax - oMin) : 0.5);
  const oppColor = (v: number) => {
    const s = Math.max(0, Math.min(1, scaleOpp01(v)));
    const hue = 10 + s * 120; // 10=rouge → 130≈vert
    return `hsl(${hue} 85% 48%)`;
  };

  // Axes X: ~5 ticks + première/dernière
  const tickCount = 5;
  const step = Math.max(1, Math.floor(n / (tickCount + 1)));
  const tickIdx = [0, ...Array.from({ length: tickCount }, (_, k) => Math.min(n - 1, (k + 1) * step)), n - 1]
    .filter((v, i, arr) => i === 0 || v !== arr[i - 1]); // unique
  const fmtDate = (ms: number) =>
    new Date(ms).toLocaleDateString("fr-FR", { year: "2-digit", month: "short" }).replace(".", "");

  // Axes Y: 4 ticks (min..max)
  const yTicks = [0, 1 / 3, 2 / 3, 1].map(f => pMax - f * (pMax - pMin));
  const fmtPrice = (v: number) => {
    const abs = Math.abs(v);
    if (abs >= 1000) return v.toFixed(0);
    if (abs >= 100) return v.toFixed(1);
    return v.toFixed(2);
  };

  // Min/Max markers
  const iMin = closes.indexOf(pMin);
  const iMax = closes.indexOf(pMax);

  // --- Tooltip (survol) -----------------------------------------------------
  const [hover, setHover] = React.useState<number | null>(null);
  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const svg = e.currentTarget;
    const pt = svg.createSVGPoint();
    pt.x = e.clientX; pt.y = e.clientY;
    const ctm = svg.getScreenCTM();
    if (!ctm) return;
    const loc = pt.matrixTransform(ctm.inverse());
    const xi = Math.max(0, Math.min(innerW, loc.x - M.left));
    const idx = Math.round((xi / innerW) * (n - 1));
    setHover(Math.max(0, Math.min(n - 1, idx)));
  };
  const onLeave = () => setHover(null);

  const hoverRow = hover != null ? rows[hover] : null;
  const hx = hover != null ? x(hover) : 0;
  const hy = hoverRow ? y(hoverRow.close) : 0;

  return (
    <div className="mt-3 rounded-2xl border border-slate-800 bg-slate-900/40 overflow-hidden">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full h-[260px]"
        onMouseMove={onMove}
        onMouseLeave={onLeave}
      >
        {/* Fond */}
        <rect x={0} y={0} width={W} height={H} fill="rgb(2,6,23)" />

        <g transform={`translate(${M.left},${M.top})`}>
          {/* Grille horizontale (prix) */}
          <g>
            {yTicks.map((v, i) => (
              <g key={i}>
                <line
                  x1={0} x2={innerW}
                  y1={y(v)} y2={y(v)}
                  stroke="rgba(148,163,184,0.18)" strokeWidth={1}
                />
              </g>
            ))}
          </g>

          {/* Courbe de prix */}
          <path
            d={path}
            fill="none"
            stroke="rgba(226,232,240,0.92)"
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
          />

          {/* Repères min/max */}
          {/* MAX */}
          <g transform={`translate(${x(iMax)}, ${y(pMax)})`}>
            <circle r={3.2} fill="rgba(34,197,94,0.9)" />
            <text x={6} y={-6} fontSize="10" fill="rgba(148,163,184,0.9)">Max {fmtPrice(pMax)}</text>
          </g>
          {/* MIN */}
          <g transform={`translate(${x(iMin)}, ${y(pMin)})`}>
            <circle r={3.2} fill="rgba(244,63,94,0.9)" />
            <text x={6} y={12} fontSize="10" fill="rgba(148,163,184,0.9)">Min {fmtPrice(pMin)}</text>
          </g>

          {/* Bande opportunité (heat strip) */}
          <g transform={`translate(0, ${bandY})`}>
            <rect x={0} y={0} width={innerW} height={bandH} fill="rgba(2,6,23,0.6)" />
            <rect x={0} y={0} width={innerW} height={bandH} fill="url(#bandShine)" />
            {rows.map((r, i) => {
              const curX = x(i);
              const nextX = x(Math.min(n - 1, i + 1));
              const w = Math.max(1, nextX - curX);
              return (
                <rect
                  key={i}
                  x={curX} y={0} width={w} height={bandH}
                  fill={oppColor(r.opp)}
                />
              );
            })}
            <rect x={0} y={0} width={innerW} height={bandH}
              fill="none" stroke="rgba(148,163,184,0.25)" />
          </g>

          {/* Axe Y (prix) : labels à droite */}
          <g>
            {yTicks.map((v, i) => (
              <text
                key={i}
                x={innerW + 6}
                y={y(v) + 3}
                fontSize="11"
                fill="rgba(148,163,184,0.75)"
              >
                {fmtPrice(v)}
              </text>
            ))}
          </g>

          {/* Axe X (dates) */}
          <g transform={`translate(0, ${axisY})`}>
            <line x1={0} x2={innerW} y1={0} y2={0} stroke="rgba(148,163,184,0.18)" />
            {tickIdx.map((idx, k) => (
              <g key={k} transform={`translate(${x(idx)},0)`}>
                <line y1={0} y2={5} stroke="rgba(148,163,184,0.35)" />
                <text
                  y={18}
                  textAnchor="middle"
                  fontSize="11"
                  fill="rgba(148,163,184,0.75)"
                >
                  {fmtDate(rows[idx].t)}
                </text>
              </g>
            ))}
          </g>

          {/* Crosshair + tooltip */}
          {hoverRow && (
            <g>
              {/* vertical line jusqu’à l’axe */}
              <line
                x1={hx} x2={hx}
                y1={0} y2={axisY}
                stroke="rgba(148,163,184,0.35)"
                strokeDasharray="3 3"
              />
              {/* point */}
              <circle cx={hx} cy={hy} r={3.8} fill="rgb(56,189,248)" stroke="white" strokeWidth={1} />

              {/* tooltip card */}
              {(() => {
                const pad = 8;
                const w = 160, h = 64;
                const left = hx + 12 + w > innerW ? hx - 12 - w : hx + 12;
                const top = Math.max(0, Math.min(priceH - h, hy - h / 2));
                return (
                  <g transform={`translate(${left}, ${top})`}>
                    <rect width={w} height={h} rx={10}
                      fill="rgba(2,6,23,0.92)"
                      stroke="rgba(148,163,184,0.35)" />
                    <text x={pad} y={pad + 10} fontSize="11"
                      fill="rgba(148,163,184,0.9)">
                      {new Date(hoverRow.t).toLocaleDateString("fr-FR",
                        { day: "2-digit", month: "short", year: "2-digit" }).replace(".", "")}
                    </text>
                    <text x={pad} y={pad + 26} fontSize="12" fill="white">
                      Prix: <tspan fontWeight={600}>{fmtPrice(hoverRow.close)}</tspan>
                    </text>
                    <text x={pad} y={pad + 42} fontSize="12" fill="white">
                      Opportunité:{" "}
                      <tspan fontWeight={600}>
                        {(Math.max(0, Math.min(100, hoverRow.opp))).toFixed(0)}%
                      </tspan>
                    </text>
                  </g>
                );
              })()}
            </g>
          )}
        </g>

        {/* Dégradé subtil pour la bande (gloss) */}
        <defs>
          <linearGradient id="bandShine" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="rgba(255,255,255,0.06)" />
            <stop offset="1" stopColor="rgba(255,255,255,0.00)" />
          </linearGradient>
        </defs>
      </svg>
    </div>
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
    /fin-html/.test(src) ? "ok" : /yahoo:html|yahoo:v7|yahoo:v10|yahoo:summary/.test(src) ? "default" : /wikipedia/.test(src) ? "muted" : "default";
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