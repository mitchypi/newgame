export interface TickerMeta {
  symbol: string;
  name: string;
  type: string;
  segment?: string | null;
}

export interface PricePointDTO {
  date: string;
  price: number;
}

const BASE = (import.meta as any).env?.BASE_URL || '/';

export async function fetchTickers(): Promise<TickerMeta[]> {
  const manifestUrl = new URL('data/manifest.json', BASE).toString();
  const res = await fetch(manifestUrl, { cache: 'reload' });
  if (!res.ok) {
    console.error('Failed to load manifest', res.status, res.statusText);
    throw new Error(`tickers: ${res.status}`);
  }
  const payload = await res.json();
  if (Array.isArray(payload)) {
    return payload as TickerMeta[];
  }
  if (payload && Array.isArray(payload.symbols)) {
    return payload.symbols as TickerMeta[];
  }
  return [];
}

export async function fetchHistory(symbol: string, _opts?: { start?: string; end?: string; agg?: 'monthly' | 'none' }): Promise<PricePointDTO[]> {
  const url = new URL(`data/history/${encodeURIComponent(symbol)}.json`, BASE).toString();
  const res = await fetch(url, { cache: 'reload' });
  if (!res.ok) {
    console.error('History fetch failed', symbol, res.status, res.statusText);
    return [];
  }
  const payload = await res.json();
  if (!Array.isArray(payload)) {
    console.error('Unexpected history payload', symbol, payload);
    return [];
  }
  return payload as PricePointDTO[];
}
