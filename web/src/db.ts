import { openDB, IDBPDatabase } from 'idb';

export type DB = IDBPDatabase;

const GAME_START_DATE = '2000-01-03';

export interface SystemState {
  id: string; // always 'system'
  currentDate: string; // YYYY-MM-DD
  timeOfDay: 'open' | 'close';
  cash: number;
}

export interface PortfolioHistoryEntry {
  date: string;
  time: 'open' | 'close';
  value: number;
}

export interface Holding {
  symbol: string;
  shares: number;
  avgCost: number;
}

export interface Transaction {
  id?: number;
  date: string; // YYYY-MM-DD
  time: 'open' | 'close';
  type: 'BUY' | 'SELL';
  symbol: string;
  shares: number;
  price: number;
  total: number;
}

export interface PricePoint {
  key: string; // `${symbol}:${date}`
  symbol: string;
  date: string; // YYYY-MM-DD
  price: number;
}

export async function getDB() {
  // Bump DB version to ensure newer object stores (e.g., 'transactions')
  // are created for users who opened an older version of the app.
  return openDB('time-machine', 2, {
    upgrade(db) {
      if (!db.objectStoreNames.contains('system')) {
        db.createObjectStore('system');
      }
      if (!db.objectStoreNames.contains('holdings')) {
        db.createObjectStore('holdings', { keyPath: 'symbol' });
      }
      if (!db.objectStoreNames.contains('transactions')) {
        db.createObjectStore('transactions', { keyPath: 'id', autoIncrement: true });
      }
      if (!db.objectStoreNames.contains('prices')) {
        const store = db.createObjectStore('prices', { keyPath: 'key' });
        store.createIndex('bySymbol', 'symbol', { unique: false });
        store.createIndex('bySymbolDate', ['symbol', 'date'] as unknown as string, { unique: false });
      }
      if (!db.objectStoreNames.contains('tickers')) {
        db.createObjectStore('tickers', { keyPath: 'symbol' });
      }
    },
  });
}

export async function initDefaults() {
  const db = await getDB();
  const system = (await db.get('system', 'system')) as SystemState | undefined;
  if (!system) {
    const defaults: SystemState = {
      id: 'system',
      currentDate: GAME_START_DATE,
      timeOfDay: 'open',
      cash: 10000,
    };
    await db.put('system', defaults, 'system');
    const initialHistory: PortfolioHistoryEntry[] = [
      { date: defaults.currentDate, time: defaults.timeOfDay, value: defaults.cash },
    ];
    await db.put('system', initialHistory, 'history');
    return defaults;
  }
  const historyExists = await db.get('system', 'history');
  if (!historyExists) {
    const fallback: PortfolioHistoryEntry[] = [
      { date: system.currentDate, time: system.timeOfDay, value: system.cash },
    ];
    await db.put('system', fallback, 'history');
  }
  return system;
}

export async function putPrices(symbol: string, points: { date: string; price: number }[]) {
  const db = await getDB();
  const tx = db.transaction('prices', 'readwrite');
  const store = tx.objectStore('prices');
  for (const p of points) {
    const rec: PricePoint = {
      key: `${symbol}:${p.date}`,
      symbol,
      date: p.date,
      price: p.price,
    };
    await store.put(rec);
  }
  await tx.done;
}

export async function getPrices(symbol: string) {
  const db = await getDB();
  const idx = db.transaction('prices').store.index('bySymbol');
  const all: PricePoint[] = [];
  let cursor = await idx.openCursor(symbol);
  while (cursor) {
    all.push(cursor.value as PricePoint);
    cursor = await cursor.continue();
  }
  return all.sort((a, b) => a.date.localeCompare(b.date));
}

export async function getPortfolioHistory(): Promise<PortfolioHistoryEntry[]> {
  const db = await getDB();
  const history = (await db.get('system', 'history')) as PortfolioHistoryEntry[] | undefined;
  return history ? [...history] : [];
}

export async function appendPortfolioHistory(entry: PortfolioHistoryEntry): Promise<PortfolioHistoryEntry[]> {
  const db = await getDB();
  const tx = db.transaction('system', 'readwrite');
  const store = tx.store;
  const history = ((await store.get('history')) as PortfolioHistoryEntry[] | undefined) ?? [];
  if (!history.length) {
    history.push({ date: GAME_START_DATE, time: 'open', value: entry.value });
  }
  const last = history[history.length - 1];
  if (last && last.date === entry.date && last.time === entry.time) {
    history[history.length - 1] = entry;
  } else {
    history.push(entry);
  }
  await store.put(history, 'history');
  await tx.done;
  return history;
}
