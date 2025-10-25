// app/components/SearchBox.tsx
'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

type Suggest = {
  symbol: string;
  name?: string | null;
  exchange?: string | null;
  type?: string | null;
  score?: number | null;
  region?: string | null;
  currency?: string | null;
};

export default function SearchBox() {
  const router = useRouter();
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Suggest[]>([]);
  const [highlight, setHighlight] = useState(0);
  const abortRef = useRef<AbortController | null>(null);

  // simple debounce de 200ms
  const debouncedQ = useDebouncedValue(q, 200);

  useEffect(() => {
    if (!debouncedQ || debouncedQ.trim().length < 2) {
      setItems([]);
      setOpen(false);
      return;
    }

    // Annule la requête précédente si encore en vol
    if (abortRef.current) abortRef.current.abort();
    const ac = new AbortController();
    abortRef.current = ac;

    const run = async () => {
      try {
        const url = `/api/suggest?q=${encodeURIComponent(debouncedQ.trim())}`;
        const r = await fetch(url, { signal: ac.signal, cache: 'no-store' });
        if (!r.ok) return;
        const js = await r.json();
        const list: Suggest[] = Array.isArray(js?.suggestions) ? js.suggestions : [];
        setItems(list);
        setOpen(list.length > 0);
        setHighlight(0);
      } catch {
        // ignoré (abort ou net)
      }
    };
    run();

    return () => ac.abort();
  }, [debouncedQ]);

  const onSelect = (s: Suggest) => {
    setOpen(false);
    setQ(s.symbol);
    // adapte la navigation selon ton app (ex: query param ?ticker=)
    router.push(`/?ticker=${encodeURIComponent(s.symbol)}`);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!open || items.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlight((h) => Math.min(h + 1, items.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      onSelect(items[highlight]);
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  };

  return (
    <div className="relative w-full max-w-xl">
      <input
        value={q}
        onChange={(e) => { setQ(e.target.value); if (!e.target.value) setOpen(false); }}
        onKeyDown={onKeyDown}
        onFocus={() => items.length && setOpen(true)}
        placeholder="Cherche un ticker ou un nom (ex: apple, tesla, hermès)…"
        className="w-full rounded-xl border px-4 py-3 outline-none focus:ring"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls="suggest-list"
      />
      {open && items.length > 0 && (
        <ul
          id="suggest-list"
          className="absolute z-20 mt-2 max-h-80 w-full overflow-auto rounded-xl border bg-white shadow-lg"
          role="listbox"
        >
          {items.map((s, i) => (
            <li
              key={s.symbol}
              role="option"
              aria-selected={i === highlight}
              onMouseDown={(e) => { e.preventDefault(); onSelect(s); }}
              onMouseEnter={() => setHighlight(i)}
              className={`cursor-pointer px-4 py-2 ${i === highlight ? 'bg-gray-100' : ''}`}
            >
              <div className="flex items-center justify-between">
                <div className="font-medium">{s.symbol}</div>
                <div className="text-xs text-gray-500">{s.exchange ?? s.type ?? ''}</div>
              </div>
              <div className="text-sm text-gray-600 truncate">{s.name ?? ''}</div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// petit hook de debounce
function useDebouncedValue<T>(value: T, delay = 200) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), delay);
    return () => clearTimeout(id);
  }, [value, delay]);
  return v;
}