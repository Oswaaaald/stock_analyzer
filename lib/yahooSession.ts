// /lib/yahooSession.ts
export const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";
export const AL = "en-US,en;q=0.9";

export type YSession = { cookie: string; crumb?: string; exp: number };
let YSESSION: YSession | null = null;

// Agrège Set-Cookie -> "k=v; k2=v2"
export function collectCookies(res: Response, prev = ""): string {
  // @ts-ignore next/undici compat
  const raw: string[] =
    typeof (res.headers as any).getSetCookie === "function"
      ? // @ts-ignore
        (res.headers as any).getSetCookie()
      : // @ts-ignore
        ((res.headers as any).raw?.()["set-cookie"] as string[] | undefined) || [];
  const parts: string[] = [];
  for (const sc of raw) {
    const kv = sc.split(";")[0]?.trim();
    if (kv) parts.push(kv);
  }
  if (prev) parts.push(...prev.split("; ").filter(Boolean));
  const map = new Map<string, string>();
  for (const p of parts) {
    const i = p.indexOf("=");
    if (i > 0) map.set(p.slice(0, i).trim(), p.trim());
  }
  return Array.from(map.values()).join("; ");
}

export async function getYahooSession(): Promise<YSession> {
  const now = Date.now();
  if (YSESSION && YSESSION.exp > now && YSESSION.cookie) return YSESSION;

  let cookie = "";
  const base = { "User-Agent": UA, "Accept-Language": AL } as const;

  // 1) boot consent
  const q = await fetch("https://finance.yahoo.com/quote/AAPL?guccounter=1", { headers: base, redirect: "manual" });
  cookie = collectCookies(q, cookie);

  // 2) follow consent hops
  let loc = q.headers.get("location") || "";
  for (let i = 0; i < 3 && loc && /guce|consent\.yahoo\.com/i.test(loc); i++) {
    const r = await fetch(loc, { headers: base, redirect: "manual" });
    cookie = collectCookies(r, cookie);
    loc = r.headers.get("location") || "";
  }

  // 3) cookies communs
  const fc = await fetch("https://fc.yahoo.com", { headers: base, redirect: "manual" });
  cookie = collectCookies(fc, cookie);

  // 4) finance once more
  const fin = await fetch("https://finance.yahoo.com/quote/AAPL", { headers: { ...base, Cookie: cookie }, redirect: "manual" });
  cookie = collectCookies(fin, cookie);

  // 5) crumb (q2 -> q1)
  const ch = { ...base, Cookie: cookie, Origin: "https://finance.yahoo.com", Referer: "https://finance.yahoo.com/" };
  let crumb = "";
  for (const host of ["query2", "query1"] as const) {
    try {
      const r = await fetch(`https://${host}.finance.yahoo.com/v1/test/getcrumb`, { headers: ch });
      if (r.ok) {
        const t = (await r.text()).trim();
        if (t && t !== "Unauthorized") { crumb = t; break; }
      }
    } catch {}
  }
  YSESSION = { cookie, crumb: crumb || undefined, exp: now + 45 * 60 * 1000 };
  return YSESSION;
}