// lib/yahoo.ts
import axios, { AxiosInstance } from "axios";
import { CookieJar } from "tough-cookie";
import { wrapper } from "axios-cookiejar-support";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";

type QuoteSummary = {
  price?: { regularMarketPrice?: { raw?: number } };
  defaultKeyStatistics?: {
    sharesOutstanding?: { raw?: number };
    priceToBook?: { raw?: number };
    trailingPE?: { raw?: number };
  };
  summaryDetail?: { trailingPE?: { raw?: number } };
  financialData?: {
    currentRatio?: { raw?: number };
    operatingCashflow?: { raw?: number };
    capitalExpenditures?: { raw?: number };
    freeCashflow?: { raw?: number };
  };
};

export type YahooVitals = {
  price: number | null;
  shares: number | null;
  trailingPE: number | null;
  priceToBook: number | null;
  currentRatio: number | null;
  ocfTTM: number | null;
  capexTTM: number | null;
  fcfTTM: number | null;
};

export type YahooChartLite = {
  lastClose: number | null;
  pxVs200dma: number | null;
};

export class YahooClient {
  private jar: CookieJar;
  private http: AxiosInstance;
  private crumb: string | null = null;

  constructor() {
    this.jar = new CookieJar();
    this.http = wrapper(
      axios.create({
        headers: {
          "User-Agent": UA,
          Origin: "https://finance.yahoo.com",
          Referer: "https://finance.yahoo.com/",
          Accept: "application/json, text/plain, */*",
        },
        // important: on laisse axios-cookiejar-support gérer le jar
        jar: this.jar as any,
        withCredentials: true,
        // on suit les redirections
        maxRedirects: 5,
        // timeouts raisonnables
        timeout: 10_000,
        validateStatus: () => true,
      }) as any
    );
  }

  /** Initialise la session (pose des cookies) + récupère un crumb */
  async warmupAndGetCrumb(): Promise<string> {
    // 1) “chauffer” la session
    await this.http.get("https://finance.yahoo.com/", { responseType: "text" });

    // 2) tenter query2 puis fallback query1
    let crumb = await this.tryGetCrumb("https://query2.finance.yahoo.com/v1/test/getcrumb");
    if (!crumb || crumb === "Unauthorized") {
      crumb = await this.tryGetCrumb("https://query1.finance.yahoo.com/v1/test/getcrumb");
    }
    if (!crumb || crumb === "Unauthorized") {
      throw new Error("Yahoo crumb introuvable");
    }
    this.crumb = crumb.trim();
    return this.crumb;
  }

  private async tryGetCrumb(url: string): Promise<string | null> {
    const res = await this.http.get(url, { responseType: "text" });
    if (res.status === 200 && typeof res.data === "string" && res.data.length > 0) {
      return res.data;
    }
    return null;
  }

  /** QuoteSummary v10 avec retry auto si “Invalid Crumb” */
  async fetchQuoteSummary(symbol: string): Promise<QuoteSummary> {
    if (!this.crumb) await this.warmupAndGetCrumb();

    const run = async () => {
      const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(
        symbol
      )}?modules=financialData,defaultKeyStatistics,price,summaryDetail&crumb=${encodeURIComponent(
        this.crumb!
      )}`;
      return this.http.get(url);
    };

    let res = await run();

    // retry si invalid crumb
    if (res.status === 401 && this.messageIncludes(res.data, "Invalid Crumb")) {
      await this.warmupAndGetCrumb();
      res = await run();
    }

    if (res.status !== 200 || !res.data?.quoteSummary?.result?.[0]) {
      const err = res.data?.finance?.error?.description || `HTTP ${res.status}`;
      throw new Error(`quoteSummary failed: ${err}`);
    }

    return res.data.quoteSummary.result[0] as QuoteSummary;
  }

  /** v8 chart (pas besoin de crumb/cookies strictement, mais on garde la même session) */
  async fetchChartLite(symbol: string): Promise<YahooChartLite> {
    const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
      symbol
    )}?range=2y&interval=1d`;
    const res = await this.http.get(url);
    if (res.status !== 200 || !res.data?.chart?.result?.[0]) {
      return { lastClose: null, pxVs200dma: null };
    }
    try {
      const r = res.data.chart.result[0];
      const closes: number[] = r?.indicators?.quote?.[0]?.close ?? [];
      const lastClose = closes.at(-1) ?? null;
      let pxVs200dma: number | null = null;
      if (closes.length >= 200 && lastClose != null) {
        const tail = closes.slice(-200).filter((x) => typeof x === "number");
        const avg200 = tail.reduce((a, b) => a + b, 0) / tail.length;
        pxVs200dma = avg200 > 0 ? lastClose / avg200 - 1 : null;
      }
      return { lastClose, pxVs200dma };
    } catch {
      return { lastClose: null, pxVs200dma: null };
    }
  }

  /** Extrait les vitaux utiles pour EY/FCFY/PB/Current ratio/OCF/FCF */
  static extractVitals(qs: QuoteSummary): YahooVitals {
    const price =
      qs.price?.regularMarketPrice?.raw ??
      (qs as any)?.price?.regularMarketPrice ??
      null;

    const shares =
      qs.defaultKeyStatistics?.sharesOutstanding?.raw ??
      (qs as any)?.defaultKeyStatistics?.sharesOutstanding ??
      null;

    const trailingPE =
      qs.summaryDetail?.trailingPE?.raw ??
      qs.defaultKeyStatistics?.trailingPE?.raw ??
      (qs as any)?.summaryDetail?.trailingPE ??
      null;

    const priceToBook =
      qs.defaultKeyStatistics?.priceToBook?.raw ??
      (qs as any)?.defaultKeyStatistics?.priceToBook ??
      null;

    const currentRatio =
      qs.financialData?.currentRatio?.raw ??
      (qs as any)?.financialData?.currentRatio ??
      null;

    const ocfTTM =
      qs.financialData?.operatingCashflow?.raw ??
      (qs as any)?.financialData?.operatingCashflow ??
      null;

    const capexTTM =
      qs.financialData?.capitalExpenditures?.raw ??
      (qs as any)?.financialData?.capitalExpenditures ??
      null;

    const fcfTTM =
      qs.financialData?.freeCashflow?.raw ??
      (qs as any)?.financialData?.freeCashflow ??
      null;

    return {
      price: toNum(price),
      shares: toNum(shares),
      trailingPE: toNum(trailingPE),
      priceToBook: toNum(priceToBook),
      currentRatio: toNum(currentRatio),
      ocfTTM: toNum(ocfTTM),
      capexTTM: toNum(capexTTM),
      fcfTTM: toNum(fcfTTM),
    };
  }

  private messageIncludes(data: any, needle: string): boolean {
    const s =
      typeof data === "string"
        ? data
        : JSON.stringify(data ?? {});
    return s.toLowerCase().includes(needle.toLowerCase());
  }
}

function toNum(v: any): number | null {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const t = Number(v.replace(/[^\d.-]/g, ""));
    return Number.isFinite(t) ? t : null;
  }
  return null;
}