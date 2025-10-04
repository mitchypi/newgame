import { fetchTickers, fetchHistory } from './api';
import { getDB, initDefaults, putPrices, getPrices, appendPortfolioHistory } from './db';
import type { Holding, PortfolioHistoryEntry } from './db';

declare const Chart: any;

type TimeOfDay = 'open' | 'close';
type TxType = 'BUY' | 'SELL';

const SHARE_STEP = 0.0001;
const CASH_STEP = 0.01;

const CRYPTO = {
  'BTC-USD': { name: 'Bitcoin', invention: '2009-01-03' },
  'ETH-USD': { name: 'Ethereum', invention: '2015-07-30' },
} as const;

const GAME_START_DATE = '2000-01-03';
const MAX_DATE = '2025-10-01';

function parseUtcDate(dateStr: string): Date {
  return new Date(`${dateStr}T00:00:00Z`);
}

function clampDate(dateStr: string): string {
  return dateStr > MAX_DATE ? MAX_DATE : dateStr;
}

function fmtCurrency(n: number) {
  return n.toLocaleString(undefined, { style: 'currency', currency: 'USD' });
}
function fmtSigned(n: number) {
  const sign = n >= 0 ? '+' : '-';
  return `${sign}${fmtCurrency(Math.abs(n))}`;
}
function fmtShares(n: number) {
  return n.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 4 });
}
function isWeekend(dateStr: string) {
  const day = parseUtcDate(dateStr).getUTCDay();
  return day === 0 || day === 6;
}
function plusDays(dateStr: string, days: number) {
  const d = parseUtcDate(dateStr);
  d.setUTCDate(d.getUTCDate() + days);
  return clampDate(d.toISOString().slice(0, 10));
}
function addMonths(dateStr: string, months: number) {
  const d = parseUtcDate(dateStr);
  d.setUTCMonth(d.getUTCMonth() + months);
  return clampDate(d.toISOString().slice(0, 10));
}
function dayName(dateStr: string) {
  return parseUtcDate(dateStr).toLocaleDateString(undefined, { weekday: 'long', timeZone: 'UTC' });
}

const priceCache = new Map<string, PricePointDTO[]>();
const priceFetches = new Map<string, Promise<PricePointDTO[]>>();

async function loadPriceSeries(symbol: string): Promise<PricePointDTO[]> {
  if (priceCache.has(symbol)) {
    return priceCache.get(symbol)!;
  }
  if (priceFetches.has(symbol)) {
    return priceFetches.get(symbol)!;
  }

  const promise = (async () => {
    const stored = await getPrices(symbol);
    if (stored.length) {
      const normalised = stored
        .map((entry) => ({ date: entry.date, price: entry.price }))
        .sort((a, b) => a.date.localeCompare(b.date));
      priceCache.set(symbol, normalised);
      priceFetches.delete(symbol);
      return normalised;
    }

    const fetched = await fetchHistory(symbol, { agg: 'none' });
    if (fetched.length) {
      priceCache.set(symbol, fetched);
      await putPrices(symbol, fetched);
    } else {
      priceCache.set(symbol, []);
    }
    priceFetches.delete(symbol);
    return priceCache.get(symbol)!;
  })();

  priceFetches.set(symbol, promise);
  return promise;
}

async function getPriceAtOrBefore(symbol: string, dateStr: string) {
  const series = await loadPriceSeries(symbol);
  let left = 0;
  let right = series.length - 1;
  let candidate: PricePointDTO | undefined;
  while (left <= right) {
    const mid = Math.floor((left + right) / 2);
    if (series[mid].date <= dateStr) {
      candidate = series[mid];
      left = mid + 1;
    } else {
      right = mid - 1;
    }
  }
  return candidate?.price;
}

async function getPrevTradingPrice(symbol: string, dateStr: string, maxLookbackDays = 10) {
  const series = await loadPriceSeries(symbol);
  let left = 0;
  let right = series.length - 1;
  let idx = -1;
  while (left <= right) {
    const mid = Math.floor((left + right) / 2);
    if (series[mid].date <= dateStr) {
      idx = mid;
      left = mid + 1;
    } else {
      right = mid - 1;
    }
  }
  if (idx <= 0) return undefined;
  const reference = series[idx].date;
  for (let j = idx - 1; j >= 0 && idx - j <= maxLookbackDays; j--) {
    if (series[j].date < reference) {
      return series[j].price;
    }
  }
  return undefined;
}

type HoldingRowData = {
  symbol: string;
  shares: number;
  avgCost: number;
  price?: number;
  change?: number;
  percentChange?: number;
  positionValue: number;
  gain: number;
  gainPercent?: number;
};

type PinnedCardData = {
  symbol: string;
  name: string;
  price?: number;
  change?: number;
  percentChange?: number;
  holdingShares: number;
  canTrade: boolean;
  showClosedNote: boolean;
};

type CryptoCardData = {
  symbol: string;
  name: string;
  price?: number;
  change?: number;
  percentChange?: number;
};

async function buildHoldingRow(holding: Holding, date: string): Promise<HoldingRowData> {
  const price = await getPriceAtOrBefore(holding.symbol, date);
  const prev = price !== undefined ? await getPrevTradingPrice(holding.symbol, date) : undefined;
  const positionValue = price !== undefined ? holding.shares * price : 0;
  const totalCost = holding.avgCost * holding.shares;
  const gain = price !== undefined ? positionValue - totalCost : 0;
  const gainPercent = price !== undefined && totalCost > 0 ? (gain / totalCost) * 100 : undefined;
  const change = price !== undefined && prev !== undefined ? price - prev : undefined;
  const percentChange = change !== undefined && prev ? (change / prev) * 100 : undefined;
  return {
    symbol: holding.symbol,
    shares: holding.shares,
    avgCost: holding.avgCost,
    price,
    change,
    percentChange,
    positionValue,
    gain,
    gainPercent,
  };
}

async function buildPinnedCard(symbol: string, name: string, date: string, holdingShares: number, canTrade: boolean, showClosedNote: boolean): Promise<PinnedCardData> {
  const price = await getPriceAtOrBefore(symbol, date);
  const prev = price !== undefined ? await getPrevTradingPrice(symbol, date) : undefined;
  const change = price !== undefined && prev !== undefined ? price - prev : undefined;
  const percentChange = change !== undefined && prev ? (change / prev) * 100 : undefined;
  return {
    symbol,
    name,
    price,
    change,
    percentChange,
    holdingShares,
    canTrade,
    showClosedNote,
  };
}

async function buildCryptoCard(symbol: string, name: string, date: string): Promise<CryptoCardData> {
  const price = await getPriceAtOrBefore(symbol, date);
  const prev = price !== undefined ? await getPrevTradingPrice(symbol, date) : undefined;
  const change = price !== undefined && prev !== undefined ? price - prev : undefined;
  const percentChange = change !== undefined && prev ? (change / prev) * 100 : undefined;
  return { symbol, name, price, change, percentChange };
}

function buildMonthlyHistory(entries: PortfolioHistoryEntry[], currentDate: string, currentValue: number) {
  const monthMap = new Map<string, { dateObj: Date; value: number }>();
  for (const entry of entries) {
    try {
      const dateObj = new Date(`${entry.date}T00:00:00Z`);
      if (Number.isNaN(dateObj.getTime())) {
        continue;
      }
      const key = entry.date.slice(0, 7);
      const existing = monthMap.get(key);
      if (!existing || dateObj > existing.dateObj) {
        monthMap.set(key, { dateObj, value: entry.value });
      }
    } catch (err) {
      continue;
    }
  }

  let monthly = Array.from(monthMap.values()).sort((a, b) => a.dateObj.getTime() - b.dateObj.getTime());
  const currentObj = new Date(`${currentDate}T00:00:00Z`);
  if (Number.isNaN(currentObj.getTime())) {
    return monthly.map((item) => ({ date: item.dateObj.toISOString().slice(0, 10), value: item.value }));
  }

  if (monthly.length === 0) {
    monthly = [{ dateObj: currentObj, value: currentValue }];
  } else {
    monthly.sort((a, b) => a.dateObj.getTime() - b.dateObj.getTime());
    const last = monthly[monthly.length - 1];
    const sameMonth =
      last.dateObj.getUTCFullYear() === currentObj.getUTCFullYear() &&
      last.dateObj.getUTCMonth() === currentObj.getUTCMonth();

    if (sameMonth) {
      last.dateObj = currentObj;
      last.value = currentValue;
    } else if (last.dateObj < currentObj) {
      let cursor = new Date(last.dateObj.getTime());
      let carryValue = last.value;
      while (cursor.getUTCFullYear() !== currentObj.getUTCFullYear() || cursor.getUTCMonth() !== currentObj.getUTCMonth()) {
        cursor.setUTCMonth(cursor.getUTCMonth() + 1);
        monthly.push({ dateObj: new Date(cursor.getTime()), value: carryValue });
      }
      monthly[monthly.length - 1].value = currentValue;
      monthly[monthly.length - 1].dateObj = currentObj;
    }
  }

  monthly.sort((a, b) => a.dateObj.getTime() - b.dateObj.getTime());
  return monthly.map((item) => ({ date: item.dateObj.toISOString().slice(0, 10), value: item.value }));
}

let refreshGeneration = 0;

async function main() {
  await initDefaults();
  const db = await getDB();

  const els = {
    date: document.getElementById('infoDate')!,
    day: document.getElementById('infoDay')!,
    time: document.getElementById('infoTime')!,
    cash: document.getElementById('infoCash')!,
    pv: document.getElementById('infoPV')!,
    // no visible status element in the old UI
    searchInput: document.getElementById('searchInput') as HTMLInputElement,
    suggestions: document.getElementById('suggestions')!,
    searchForm: document.getElementById('searchForm') as HTMLFormElement,
    weekendNote: document.getElementById('weekendNote')!,
    loadingMessage: document.getElementById('loadingMessage')!,
    pinnedSection: document.getElementById('pinnedSection')!,
    pinnedGrid: document.getElementById('pinnedGrid')!,
    portfolioSection: document.getElementById('portfolioSection')!,
    holdingsBody: document.getElementById('holdingsBody')!,
    txSection: document.getElementById('transactionsSection')!,
    txBody: document.getElementById('txBody')!,
    cryptoSection: document.getElementById('cryptoSection')!,
    cryptoGrid: document.getElementById('cryptoGrid')!,
    buySection: document.getElementById('buySection')!,
    chartCanvas: document.getElementById('portfolioChart') as HTMLCanvasElement,
    resetBtn: document.getElementById('resetBtn') as HTMLButtonElement,
    jumpWeek: document.getElementById('jumpWeek') as HTMLButtonElement,
    jumpMonth: document.getElementById('jumpMonth') as HTMLButtonElement,
    jumpYear: document.getElementById('jumpYear') as HTMLButtonElement,
    nextBtn: document.getElementById('nextBtn') as HTMLButtonElement,
    skipWeekend: document.getElementById('skipWeekend') as HTMLButtonElement,
    jumpForm: document.getElementById('jumpForm') as HTMLFormElement,
    jumpYearSel: document.getElementById('jumpYearSel') as HTMLSelectElement,
    jumpMonthSel: document.getElementById('jumpMonthSel') as HTMLSelectElement,
    jumpDaySel: document.getElementById('jumpDaySel') as HTMLSelectElement,
    jumpError: document.getElementById('jumpError')!,
    sellModal: document.getElementById('sellModal')!,
    sellClose: document.getElementById('sellClose')!,
    sellForm: document.getElementById('sellForm') as HTMLFormElement,
    sellSymbol: document.getElementById('sellSymbol')!,
    sellSharesMax: document.getElementById('sellSharesMax') as HTMLInputElement,
  };

  const showMaxDateMessage = () => {
    els.jumpError.textContent = 'You have reached the end of available data (Oct 1, 2025).';
    els.jumpError.style.display = 'block';
  };

  const hideJumpMessage = () => {
    if (els.jumpError) {
      els.jumpError.style.display = 'none';
    }
  };


  // State persistence helpers
  async function getSystem() {
    const s = await db.get('system', 'system');
    return s || { id: 'system', currentDate: GAME_START_DATE, timeOfDay: 'open', cash: 10000 };
  }
  async function putSystem(s: any) { await db.put('system', s, 'system'); }
  async function getHoldings() { return (await db.getAll('holdings')) as any[]; }
  async function putHolding(h: any) { await db.put('holdings', h); }
  async function delHolding(symbol: string) { await db.delete('holdings', symbol); }
  async function addTx(tx: any) { await db.add('transactions', tx); }
  async function getRecentTx(limit = 20) {
    const all = await db.getAll('transactions');
    return all.sort((a: any, b: any) => (a.date > b.date ? -1 : 1)).slice(0, limit);
  }
  async function getPinned(): Promise<string[]> { return (await db.get('system', 'pinned')) || []; }
  async function setPinned(list: string[]) { await db.put('system', list, 'pinned'); }

  // Remember the last symbol shown in the Buy Stocks card so we
  // can refresh its price/availability when the date changes.
  let currentBuySymbol: string | null = null;

  // Tickers and search
  let tickerCache: { symbol: string; name: string; type: string }[] = [];
  async function loadTickers() {
    try {
      tickerCache = await fetchTickers();
      const tx = db.transaction('tickers', 'readwrite');
      for (const t of tickerCache) await tx.store.put(t);
      await tx.done;
    } catch (e: any) {
      console.warn('Failed to load tickers', e);
    }
  }
  await loadTickers();
  await Promise.all(Object.keys(CRYPTO).map((symbol) => loadPriceSeries(symbol)));

  function renderJumpSelectors(current: string) {
    els.jumpYearSel.innerHTML = '';
    els.jumpMonthSel.innerHTML = '';
    els.jumpDaySel.innerHTML = '';
    const year = parseInt(current.slice(0, 4), 10);
    const month = parseInt(current.slice(5, 7), 10);
    const day = parseInt(current.slice(8, 10), 10);
    for (let y = 2000; y <= 2025; y++) {
      const opt = document.createElement('option');
      opt.value = String(y); opt.textContent = String(y);
      if (y === year) opt.selected = true;
      els.jumpYearSel.appendChild(opt);
    }
    for (let m = 1; m <= 12; m++) {
      const opt = document.createElement('option');
      opt.value = String(m); opt.textContent = new Date(2000, m - 1).toLocaleString(undefined, { month: 'short' });
      if (m === month) opt.selected = true;
      els.jumpMonthSel.appendChild(opt);
    }
  for (let d = 1; d <= 31; d++) {
    const opt = document.createElement('option');
    opt.value = String(d); opt.textContent = String(d);
    if (d === day) opt.selected = true;
    els.jumpDaySel.appendChild(opt);
  }
}

  function buildMonthlyLabels(dates: string[]) {
    const total = dates.length;
    const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

    // Short ranges: show most labels
    if (total <= 12) {
      return dates.map((d) => {
        const t = new Date(`${d}T00:00:00Z`);
        if (Number.isNaN(t.getTime())) return d;
        return `${monthNames[t.getUTCMonth()]} ${t.getUTCFullYear()}`;
      });
    }
    if (total <= 24) {
      return dates.map((d, i) => {
        const t = new Date(`${d}T00:00:00Z`);
        if (Number.isNaN(t.getTime())) return d;
        return (i % 2 === 0 || t.getUTCMonth() === 0) ? `${monthNames[t.getUTCMonth()]} ${t.getUTCFullYear()}` : '';
      });
    }
    if (total <= 60) {
      return dates.map((d, i) => {
        const t = new Date(`${d}T00:00:00Z`);
        if (Number.isNaN(t.getTime())) return d;
        return (i % 4 === 0 || t.getUTCMonth() === 0) ? `${monthNames[t.getUTCMonth()]} ${t.getUTCFullYear()}` : '';
      });
    }

    // Longer ranges: avoid crowding
    const start = new Date(`${dates[0]}T00:00:00Z`);
    const end = new Date(`${dates[dates.length - 1]}T00:00:00Z`);
    const startYear = start.getUTCFullYear();
    const endYear = end.getUTCFullYear();
    const yearSpan = Math.max(1, endYear - startYear + 1);

    // Strategy:
    // - up to ~7 years: semi-annual (Jan/Jul)
    // - 8–12 years: annual (Jan)
    // - 13–18 years: biennial (Jan every 2 years)
    // - >18 years: triennial (Jan every 3 years)
    let yearStep = 1;
    let semiAnnual = false;
    if (yearSpan <= 7) { semiAnnual = true; yearStep = 1; }
    else if (yearSpan <= 12) { semiAnnual = false; yearStep = 1; }
    else if (yearSpan <= 18) { semiAnnual = false; yearStep = 2; }
    else { semiAnnual = false; yearStep = 3; }

    return dates.map((d) => {
      const t = new Date(`${d}T00:00:00Z`);
      if (Number.isNaN(t.getTime())) return d;
      const y = t.getUTCFullYear();
      const m = t.getUTCMonth();
      if (semiAnnual) {
        if (m === 0 || m === 6) return `${monthNames[m]} ${y}`;
        return '';
      }
      if (m === 0 && ((y - startYear) % yearStep === 0)) {
        return `${monthNames[m]} ${y}`;
      }
      return '';
    });
  }

  function adaptHistory(monthly: { date: string; value: number }[]) {
    // Keep monthly granularity; label thinning handles readability.
    if (!monthly.length) return [];
    return monthly
      .map((item) => {
        const d = new Date(`${item.date}T00:00:00Z`);
        return Number.isNaN(d.getTime()) ? null : { date: d.toISOString().slice(0, 10), value: item.value };
      })
      .filter((x): x is { date: string; value: number } => !!x)
      .sort((a, b) => a.date.localeCompare(b.date));
  }

  // Helpers to generate month steps and compute missing monthly portfolio values
  function toMonthKey(dateStr: string) { return dateStr.slice(0, 7); }
  function monthEndDateStr(year: number, month1to12: number) {
    const d = new Date(Date.UTC(year, month1to12, 0)); // day 0 of next month = last day of this month
    return d.toISOString().slice(0, 10);
  }
  function incMonth(year: number, month1to12: number): [number, number] {
    let y = year; let m = month1to12 + 1; if (m > 12) { m = 1; y += 1; } return [y, m];
  }

  async function computeFilledMonthlyHistory(
    entries: PortfolioHistoryEntry[],
    currentDate: string,
    _cash: number,
    _holdings: Holding[],
  ): Promise<{ date: string; value: number }[]> {
    // 1) Build a map of the last known PV per month from stored history
    const perMonth = new Map<string, { date: string; value: number }>();
    let initialCash = 10000;
    if (entries && entries.length) {
      // Find earliest entry to infer starting cash
      const earliest = [...entries].sort((a, b) => (a.date === b.date ? a.time.localeCompare(b.time) : a.date.localeCompare(b.date)))[0];
      if (earliest && typeof earliest.value === 'number') initialCash = earliest.value;
      for (const e of entries) {
        const key = toMonthKey(e.date);
        const existing = perMonth.get(key);
        if (!existing || e.date > existing.date) perMonth.set(key, { date: e.date, value: e.value });
      }
    }

    // 2) Load all transactions and sort ascending
    const txs = (await db.getAll('transactions')) as any[];
    txs.sort((a, b) => (a.date === b.date ? a.time.localeCompare(b.time) : a.date.localeCompare(b.date)));

    // Preload price series for all symbols we’ve ever traded to speed up lookups
    const symbols = Array.from(new Set(txs.map((t) => t.symbol)));
    await Promise.all(symbols.map((s) => loadPriceSeries(s)));

    // 3) Iterate months from earliest to current, applying transactions as we go
    const keys = Array.from(new Set([...(perMonth.keys())])).sort();
    const startKey = keys.length ? keys[0] : toMonthKey(GAME_START_DATE);
    const endKey = toMonthKey(currentDate);

    let y = parseInt(startKey.slice(0, 4), 10);
    let m = parseInt(startKey.slice(5, 7), 10);
    let idx = 0; // tx pointer
    const sharesBySymbol = new Map<string, number>();
    let cash = initialCash;

    const out: { date: string; value: number }[] = [];
    let stepKey = `${y.toString().padStart(4, '0')}-${m.toString().padStart(2, '0')}`;
    while (stepKey <= endKey) {
      const monthEnd = monthEndDateStr(y, m);
      const useDate = stepKey === endKey && monthEnd > currentDate ? currentDate : monthEnd;

      // Apply all transactions up to and including useDate
      while (idx < txs.length && (txs[idx].date <= useDate)) {
        const t = txs[idx];
        const sym = t.symbol as string;
        const qty = Number(t.shares) || 0;
        const total = Number(t.total) || 0;
        if (!sharesBySymbol.has(sym)) sharesBySymbol.set(sym, 0);
        if (t.type === 'BUY') {
          sharesBySymbol.set(sym, +(sharesBySymbol.get(sym)! + qty).toFixed(4));
          cash = +(cash - total).toFixed(2);
        } else if (t.type === 'SELL') {
          sharesBySymbol.set(sym, Math.max(0, +(sharesBySymbol.get(sym)! - qty).toFixed(4)));
          cash = +(cash + total).toFixed(2);
        }
        idx++;
      }

      // If we already persisted a PV for this month, prefer it (it reflects exact day/time)
      const existing = perMonth.get(stepKey);
      if (existing) {
        out.push({ date: existing.date, value: existing.value });
      } else {
        // Compute holdings value at month end
        let hv = 0;
        for (const [sym, sh] of sharesBySymbol.entries()) {
          if (sh <= 0) continue;
          const p = await getPriceAtOrBefore(sym, useDate);
          if (p !== undefined) hv += sh * p;
        }
        out.push({ date: useDate, value: +(cash + hv).toFixed(2) });
      }

      [y, m] = incMonth(y, m);
      stepKey = `${y.toString().padStart(4, '0')}-${m.toString().padStart(2, '0')}`;
    }

    out.sort((a, b) => a.date.localeCompare(b.date));
    return out;
  }

  let chart: any;
  async function renderChart(history: { date: string; value: number }[]) {
    const ctx = els.chartCanvas.getContext('2d');
    if (!ctx) return;
    if (chart) chart.destroy();
    const labels = buildMonthlyLabels(history.map(h => h.date));
    chart = new Chart(ctx, {
      type: 'line',
      data: {
        labels,
        datasets: [{
          label: 'Monthly Portfolio Value',
          data: history.map(h => h.value),
          borderColor: '#28a745',
          backgroundColor: 'rgba(40, 167, 69, 0.1)',
          tension: 0.1,
          fill: true,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: true, position: 'top' },
          tooltip: {
            callbacks: {
              title: (items: any[]) => {
                if (!items.length) return '';
                const idx = items[0].dataIndex;
                const d = parseUtcDate(history[idx].date);
                return Number.isNaN(d.getTime()) ? history[idx].date : d.toLocaleDateString(undefined, { year: 'numeric', month: 'long' });
              },
              label: (ctx: any) => '$' + Number(ctx.parsed.y).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
            }
          }
        },
        scales: {
          x: { ticks: { maxRotation: 0, autoSkip: false } },
          y: {
            beginAtZero: false,
            ticks: {
              callback: (v: any) => '$' + Number(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
            }
          }
        }
      }
    });
  }

  function clear(el: Element) { while (el.firstChild) el.removeChild(el.firstChild); }

  async function renderPinned(pinned: string[], date: string, holdingsMap: Map<string, Holding>, generation: number) {
    els.pinnedSection.style.display = pinned.length ? '' : 'none';
    if (!pinned.length) {
      clear(els.pinnedGrid);
      return;
    }

    const data = await Promise.all(
      pinned.map(async (symbol) => {
        const meta = tickerCache.find((item) => item.symbol === symbol);
        const name = meta?.name || symbol;
        const holding = holdingsMap.get(symbol);
        const weekendClosed = isWeekend(date) && !isCrypto(symbol);
        const canTrade = !weekendClosed;
        const card = await buildPinnedCard(symbol, name, date, holding ? holding.shares : 0, canTrade, weekendClosed);
        return card;
      }),
    );

    if (generation !== refreshGeneration) return;

    clear(els.pinnedGrid);
    for (const cardData of data) {
      const card = document.createElement('div');
      card.className = 'pinned-card';
      const body = document.createElement('div');
      body.className = 'stock-buy-details pinned-stock-details';

      const header = document.createElement('div');
      header.className = 'pinned-header';
      const title = document.createElement('h3');
      title.textContent = `${cardData.symbol} - ${cardData.name}`;
      const unpin = document.createElement('button');
      unpin.className = 'unpin-btn';
      unpin.textContent = '—';
      unpin.title = 'Unpin';
      unpin.onclick = async () => {
        const list = (await getPinned()).filter((s) => s !== cardData.symbol);
        await setPinned(list);
        await refresh();
      };
      header.append(title, unpin);
      body.appendChild(header);

      const priceEl = document.createElement('p');
      priceEl.className = 'pinned-price';
      if (cardData.price === undefined) {
        priceEl.textContent = 'N/A';
      } else if (cardData.change === undefined) {
        priceEl.textContent = fmtCurrency(cardData.price);
      } else {
        const pctText = cardData.percentChange !== undefined ? `${cardData.percentChange >= 0 ? '+' : ''}${cardData.percentChange.toFixed(2)}%` : '';
        priceEl.innerHTML = `${fmtCurrency(cardData.price)} <span class="${cardData.change >= 0 ? 'positive' : 'negative'}">${cardData.change >= 0 ? '+' : ''}${fmtCurrency(Math.abs(cardData.change))} (${pctText})</span>`;
      }
      body.appendChild(priceEl);

      if (cardData.canTrade) {
        const buyRow = document.createElement('div');
        buyRow.className = 'buy-forms-inline';

        const formShares = document.createElement('form');
        formShares.className = 'trade-form-inline';
        formShares.innerHTML = `<input type="hidden" name="symbol" value="${cardData.symbol}"> <label>Shares:</label> <input type="number" name="shares" min="0.0001" step="0.0001" placeholder="Qty" required> <button type="submit" class="trade-button trade-button--buy">Buy</button>`;
        formShares.onsubmit = async (e) => {
          e.preventDefault();
          const form = new FormData(formShares);
          const shares = parseFloat(String(form.get('shares') || '0'));
          await buy(cardData.symbol, shares, undefined);
        };

        const formCash = document.createElement('form');
        formCash.className = 'trade-form-inline';
        formCash.innerHTML = `<input type="hidden" name="symbol" value="${cardData.symbol}"> <label>Cash:</label> <input type="number" name="cash" min="0.01" step="0.01" placeholder="$" required> <button type="submit" class="trade-button trade-button--buy">Buy</button>`;
        formCash.onsubmit = async (e) => {
          e.preventDefault();
          const form = new FormData(formCash);
          const cash = parseFloat(String(form.get('cash') || '0'));
          await buy(cardData.symbol, undefined, cash);
        };

        const formMax = document.createElement('form');
        formMax.className = 'trade-form-inline';
        formMax.innerHTML = `<input type="hidden" name="symbol" value="${cardData.symbol}"> <button type="submit" class="trade-button trade-button--buy">Buy Max</button>`;
        formMax.onsubmit = async (e) => {
          e.preventDefault();
          await buy(cardData.symbol, undefined, (await getSystem()).cash);
        };

        buyRow.append(formShares, formCash, formMax);
        body.appendChild(buyRow);
      } else if (cardData.showClosedNote) {
        const note = document.createElement('p');
        note.className = 'market-closed-note';
        note.textContent = 'Stock market is closed on weekends. Use Skip Weekend to place trades.';
        body.appendChild(note);
      }

      if (cardData.holdingShares > 0) {
        const holdingShares = cardData.holdingShares;
        if (cardData.canTrade) {
          const sellRow = document.createElement('div');
          sellRow.className = 'pinned-sell-actions trade-button-group';
          const sellBtn = document.createElement('button');
          sellBtn.className = 'trade-button trade-button--sell trade-button--wide';
          sellBtn.textContent = 'Sell';
          sellBtn.onclick = () => showSellForm(cardData.symbol, holdingShares);

          const sellAllForm = document.createElement('form');
          const sellAllBtn = document.createElement('button');
          sellAllBtn.className = 'trade-button trade-button--sell trade-button--wide';
          sellAllBtn.textContent = 'Sell All';
          sellAllForm.onsubmit = async (e) => {
            e.preventDefault();
            await sell(cardData.symbol, holdingShares, undefined);
          };
          sellAllForm.appendChild(sellAllBtn);
          sellRow.append(sellBtn, sellAllForm);
          body.appendChild(sellRow);
        } else {
          const note = document.createElement('span');
          note.className = 'market-closed-inline';
          note.textContent = 'Market closed (weekend)';
          body.appendChild(note);
        }
      }

      card.appendChild(body);
      els.pinnedGrid.appendChild(card);
    }
  }

  async function renderHoldings(holdings: Holding[], date: string, generation: number): Promise<number | undefined> {
    els.portfolioSection.style.display = holdings.length ? '' : 'none';
    if (!holdings.length) {
      clear(els.holdingsBody);
      return 0;
    }

    const rows = await Promise.all(holdings.map((holding) => buildHoldingRow(holding, date)));
    if (generation !== refreshGeneration) return undefined;

    // Sum up the current position values for all holdings where a price is available
    const totalHoldingsValue = rows.reduce((sum, r) => sum + (r.price !== undefined ? r.positionValue : 0), 0);

    clear(els.holdingsBody);
    for (const row of rows) {
      const tr = document.createElement('tr');
      const priceTd = document.createElement('td');
      if (row.price === undefined) {
        priceTd.textContent = '-';
      } else if (row.change === undefined) {
        priceTd.textContent = fmtCurrency(row.price);
      } else {
        const pctText = row.percentChange !== undefined ? `${row.percentChange >= 0 ? '+' : ''}${row.percentChange.toFixed(2)}%` : '';
        priceTd.innerHTML = `${fmtCurrency(row.price)} <span class="${row.change >= 0 ? 'positive' : 'negative'}">${row.change >= 0 ? '+' : ''}${fmtCurrency(Math.abs(row.change))} (${pctText})</span>`;
      }

      const positionValueText = row.price === undefined ? '-' : fmtCurrency(row.positionValue);
      const gainCell = row.price === undefined
        ? '-'
        : `<span class="${row.gain >= 0 ? 'positive' : 'negative'}">${fmtSigned(row.gain)}</span>`;
      const gainPercentFragment = row.price === undefined || row.gainPercent === undefined
        ? ''
        : ` (${row.gainPercent >= 0 ? '+' : ''}${row.gainPercent.toFixed(2)}%)`;

      const canTrade = isCrypto(row.symbol) || !isWeekend(date);
      const actionsHtml = canTrade
        ? '<button class="trade-button trade-button--sell">Sell</button> <button class="trade-button trade-button--sell" style="margin-left:8px">Sell All</button>'
        : '<span class="market-closed-inline">Market closed (weekend)</span>';

      tr.innerHTML = `
        <td><strong>${row.symbol}</strong></td>
        <td>${fmtShares(row.shares)}</td>
        <td></td>
        <td>${fmtCurrency(row.avgCost)}</td>
        <td>${positionValueText}</td>
        <td>${gainCell}${gainPercentFragment}</td>
        <td>${actionsHtml}</td>
      `;
      tr.children[2].replaceWith(priceTd);
      if (canTrade) {
        const sellBtn = tr.querySelector('button') as HTMLButtonElement | null;
        const sellAllBtn = tr.querySelectorAll('button')[1] as HTMLButtonElement | undefined;
        if (sellBtn) sellBtn.onclick = () => showSellForm(row.symbol, row.shares);
        if (sellAllBtn) sellAllBtn.onclick = async () => { await sell(row.symbol, row.shares, undefined); };
      }
      els.holdingsBody.appendChild(tr);
    }

    return totalHoldingsValue;
  }

  async function renderTransactions() {
    const txs = await getRecentTx(20);
    els.txSection.style.display = txs.length ? '' : 'none';
    clear(els.txBody);
    for (const tx of txs) {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${tx.date} (${tx.time})</td>
        <td><span class="${tx.type === 'BUY' ? 'buy-label' : 'sell-label'}">${tx.type}</span></td>
        <td>${tx.symbol}</td>
        <td>${fmtShares(tx.shares)}</td>
        <td>${fmtCurrency(tx.price)}</td>
        <td>${fmtCurrency(tx.total)}</td>
        <td>${typeof tx.profit_loss === 'number' ? `<span class="${tx.profit_loss>=0?'positive':'negative'}">${fmtSigned(tx.profit_loss)}</span>` : '-'}</td>
      `;
      els.txBody.appendChild(tr);
    }
  }

  function isCrypto(symbol: string) { return symbol in CRYPTO; }
  function cryptoAvailable(symbol: string, date: string) {
    const info = (CRYPTO as any)[symbol];
    if (!info) return true; // non-crypto
    return date >= info.invention;
  }

  async function renderCryptos(date: string, generation: number) {
    const available = Object.keys(CRYPTO).filter((sym) => cryptoAvailable(sym, date));
    els.cryptoSection.style.display = available.length ? '' : 'none';
    if (!available.length) {
      clear(els.cryptoGrid);
      return;
    }

    const cards = await Promise.all(
      available.map((symbol) => {
        const name = (CRYPTO as any)[symbol].name;
        return buildCryptoCard(symbol, name, date);
      }),
    );
    if (generation !== refreshGeneration) return;

    clear(els.cryptoGrid);
    for (const cardData of cards) {
      const card = document.createElement('div');
      card.className = 'crypto-card';
      const body = document.createElement('div');
      body.className = 'stock-buy-details crypto-buy-details';
      const h3 = document.createElement('h3');
      h3.textContent = `${cardData.name} (${cardData.symbol})`;
      const priceEl = document.createElement('p');
      priceEl.className = 'crypto-price';
      if (cardData.price === undefined) {
        priceEl.textContent = 'N/A';
      } else if (cardData.change === undefined) {
        priceEl.textContent = fmtCurrency(cardData.price);
      } else {
        const pctText = cardData.percentChange !== undefined ? `${cardData.percentChange >= 0 ? '+' : ''}${cardData.percentChange.toFixed(2)}%` : '';
        priceEl.innerHTML = `${fmtCurrency(cardData.price)} <span class="${cardData.change >= 0 ? 'positive' : 'negative'}">${pctText}</span>`;
      }

      const buyRow = document.createElement('div');
      buyRow.className = 'buy-forms-inline';

      const formShares = document.createElement('form');
      formShares.className = 'trade-form-inline';
      formShares.innerHTML = `<input type="hidden" name="symbol" value="${cardData.symbol}"> <label>Shares:</label> <input type="number" name="shares" min="0.0001" step="0.0001" placeholder="Qty" required> <button type="submit" class="trade-button trade-button--buy">Buy</button>`;
      formShares.onsubmit = async (e) => {
        e.preventDefault();
        const form = new FormData(formShares);
        const shares = parseFloat(String(form.get('shares') || '0'));
        await buy(cardData.symbol, shares, undefined);
      };

      const formCash = document.createElement('form');
      formCash.className = 'trade-form-inline';
      formCash.innerHTML = `<input type="hidden" name="symbol" value="${cardData.symbol}"> <label>Cash:</label> <input type="number" name="cash" min="0.01" step="0.01" placeholder="$" required> <button type="submit" class="trade-button trade-button--buy">Buy</button>`;
      formCash.onsubmit = async (e) => {
        e.preventDefault();
        const form = new FormData(formCash);
        const cash = parseFloat(String(form.get('cash') || '0'));
        await buy(cardData.symbol, undefined, cash);
      };

      const formMax = document.createElement('form');
      formMax.className = 'trade-form-inline';
      formMax.innerHTML = `<input type="hidden" name="symbol" value="${cardData.symbol}"> <button type="submit" class="trade-button trade-button--buy">Buy Max</button>`;
      formMax.onsubmit = async (e) => {
        e.preventDefault();
        await buy(cardData.symbol, undefined, (await getSystem()).cash);
      };

      buyRow.append(formShares, formCash, formMax);
      body.append(h3, priceEl, buyRow);
      card.appendChild(body);
      els.cryptoGrid.appendChild(card);
    }
  }

  async function buy(symbol: string, shares?: number, cash?: number) {
    const sys = await getSystem();
    const date = sys.currentDate; const time = sys.timeOfDay;
    if (!isCrypto(symbol) && isWeekend(date)) return;
    if (isCrypto(symbol) && !cryptoAvailable(symbol, date)) return;
    const price = await getPriceAtOrBefore(symbol, date);
    if (price === undefined) return;
    let qty = shares ?? (cash ? Math.floor((cash / price) / SHARE_STEP) * SHARE_STEP : 0);
    if (!qty || qty <= 0) return;
    const cost = Math.round(qty * price / CASH_STEP) * CASH_STEP;
    if (sys.cash < cost) return;
    const existing = (await db.get('holdings', symbol)) || { symbol, shares: 0, avgCost: 0 };
    const newShares = existing.shares + qty;
    const newAvg = existing.shares > 0 ? ((existing.avgCost * existing.shares) + cost) / newShares : price;
    await putHolding({ symbol, shares: newShares, avgCost: newAvg });
    sys.cash = +(sys.cash - cost).toFixed(2);
    await putSystem(sys);
    await addTx({ date, time, type: 'BUY', symbol, shares: qty, price, total: cost });
    await refresh();
  }

  async function sell(symbol: string, shares?: number, cash?: number) {
    const sys = await getSystem();
    const date = sys.currentDate; const time = sys.timeOfDay;
    if (!isCrypto(symbol) && isWeekend(date)) return;
    const price = await getPriceAtOrBefore(symbol, date);
    if (price === undefined) return;
    const existing = (await db.get('holdings', symbol));
    if (!existing || existing.shares <= 0) return;
    let qty = shares ?? (cash ? Math.floor((cash / price) / SHARE_STEP) * SHARE_STEP : 0);
    qty = Math.min(qty, existing.shares);
    if (!qty || qty <= 0) return;
    const proceeds = Math.round(qty * price / CASH_STEP) * CASH_STEP;
    const remaining = +(existing.shares - qty).toFixed(4);
    const costBasis = existing.avgCost * qty;
    const profitLoss = +(proceeds - costBasis).toFixed(2);
    if (remaining <= 0) await delHolding(symbol);
    else await putHolding({ symbol, shares: remaining, avgCost: existing.avgCost });
    sys.cash = +(sys.cash + proceeds).toFixed(2);
    await putSystem(sys);
    await addTx({ date, time, type: 'SELL', symbol, shares: qty, price, total: proceeds, profit_loss: profitLoss });
    await refresh();
  }

  async function showSellForm(symbol: string, maxShares: number) {
    els.sellSymbol.textContent = symbol;
    els.sellSharesMax.max = String(maxShares);
    els.sellForm.onsubmit = async (e) => {
      e.preventDefault();
      const form = new FormData(els.sellForm);
      const shares = parseFloat(String(form.get('shares') || '0')) || undefined;
      const cash = parseFloat(String(form.get('cash') || '0')) || undefined;
      await sell(symbol, shares, cash);
      els.sellModal.setAttribute('style', 'display:none');
    };
    els.sellModal.setAttribute('style', 'display:block');
  }
  (window as any).showSellForm = showSellForm;
  els.sellClose.onclick = () => els.sellModal.setAttribute('style', 'display:none');
  window.onclick = (e) => { if (e.target === els.sellModal) els.sellModal.setAttribute('style', 'display:none'); };

  // Search typeahead
  let currentMatches: { symbol: string; name: string }[] = [];
  let activeIndex = -1;
  function clearSuggestions() {
    els.suggestions.innerHTML = '';
    els.suggestions.classList.remove('is-visible');
    currentMatches = []; activeIndex = -1;
  }
  function renderSuggestions(matches: { symbol: string; name: string }[]) {
    currentMatches = matches.slice(0, 50);
    if (!currentMatches.length) { clearSuggestions(); return; }
    els.suggestions.innerHTML = currentMatches.map((m, i) => `<div class="autocomplete-item ${i===activeIndex?'is-active':''}" data-symbol="${m.symbol}"><span class="autocomplete-symbol">${m.symbol}</span><span class="autocomplete-name">${m.name}</span></div>`).join('');
    els.suggestions.classList.add('is-visible');
  }
  function handleSelection(symbol: string) {
    if (!symbol) return;
    els.searchInput.value = symbol; clearSuggestions();
    showBuySection(symbol);
  }
  els.searchInput.addEventListener('input', () => {
    const value = els.searchInput.value.trim();
    if (value.length < 2) { clearSuggestions(); return; }
    const upper = value.toUpperCase();
    const matches = tickerCache.filter(t => t.symbol.toUpperCase().startsWith(upper) || t.name.toUpperCase().includes(upper));
    renderSuggestions(matches);
  });
  els.suggestions.addEventListener('mousedown', (e) => {
    const target = (e.target as HTMLElement).closest('[data-symbol]') as HTMLElement | null;
    if (!target) return;
    e.preventDefault();
    handleSelection(target.getAttribute('data-symbol') || '');
  });
  const searchFormEl = document.getElementById('searchForm') as HTMLFormElement | null;
  if (searchFormEl) {
    searchFormEl.onsubmit = (ev) => {
      ev.preventDefault();
      const sym = (els.searchInput.value || '').trim().toUpperCase();
      if (sym) handleSelection(sym);
    };
  }
  els.searchInput.addEventListener('keydown', (event: KeyboardEvent) => {
    if (!currentMatches.length) return;
    switch (event.key) {
      case 'ArrowDown': event.preventDefault(); activeIndex = (activeIndex + 1) % currentMatches.length; renderSuggestions(currentMatches); break;
      case 'ArrowUp': event.preventDefault(); activeIndex = (activeIndex - 1 + currentMatches.length) % currentMatches.length; renderSuggestions(currentMatches); break;
      case 'Enter': if (activeIndex >= 0 && currentMatches[activeIndex]) { event.preventDefault(); handleSelection(currentMatches[activeIndex].symbol); } break;
      case 'Escape': clearSuggestions(); break;
    }
  });

  async function showBuySection(symbol: string) {
    const sys = await getSystem();
    const price = await getPriceAtOrBefore(symbol, sys.currentDate);
    const prev = await getPrevTradingPrice(symbol, sys.currentDate);
    const name = tickerCache.find(t => t.symbol === symbol)?.name || symbol;
    els.buySection.style.display = '';
    els.buySection.innerHTML = `
      <div class="stock-buy-details">
        <div style="display:flex; justify-content:space-between; align-items:center;">
          <h3>${symbol} - ${name}</h3>
          <button class="pin-btn" id="pinBtn">Pin Stock</button>
        </div>
        <p><strong>Current Price:</strong> ${price === undefined ? '-' : fmtCurrency(price)}
          ${prev!==undefined && price!==undefined ? `<span class="${(price-prev)>=0?'positive':'negative'}"> ${(price-prev)>=0?'+':''}${fmtCurrency(Math.abs(price-prev))} (${prev?(((price-prev)/prev)*100>=0?'+':''):''}${prev?(((price-prev)/prev)*100).toFixed(2):''}%)</span>` : ''}
        </p>
        ${(!isCrypto(symbol) && isWeekend(sys.currentDate)) ? '<p class="market-closed-note">Stock market is closed on weekends. Use Skip Weekend to place trades.</p>' : ''}
        <div class="buy-forms-inline">
          <form id="buySharesForm" class="trade-form-inline">
            <label>Shares:</label>
            <input type="number" name="shares" min="0.0001" step="0.0001" placeholder="Qty" required>
            <button type="submit" class="trade-button trade-button--buy">Buy</button>
          </form>
          <form id="buyCashForm" class="trade-form-inline">
            <label>Cash:</label>
            <input type="number" name="cash" min="0.01" step="0.01" placeholder="$" required>
            <button type="submit" class="trade-button trade-button--buy">Buy</button>
          </form>
          <form id="buyMaxForm" class="trade-form-inline">
            <input type="hidden" name="cash" value="${sys.cash}">
            <button type="submit" class="trade-button trade-button--buy">Buy Max</button>
          </form>
        </div>
      </div>
    `;
    // Hide buy forms on weekends for non-crypto symbols and remember active symbol
    const _canTrade = isCrypto(symbol) || !isWeekend(sys.currentDate);
    if (!_canTrade) {
      for (const id of ['buySharesForm','buyCashForm','buyMaxForm']) {
        const node = document.getElementById(id);
        if (node) (node as HTMLElement).style.display = 'none';
      }
    }
    currentBuySymbol = symbol;
    (document.getElementById('pinBtn') as HTMLButtonElement).onclick = async () => {
      const list = await getPinned();
      if (!list.includes(symbol)) { list.push(symbol); await setPinned(list); }
      await refresh();
    };
    (document.getElementById('buySharesForm') as HTMLFormElement).onsubmit = async (e) => {
      e.preventDefault();
      const form = new FormData(e.currentTarget as HTMLFormElement);
      const shares = parseFloat(String(form.get('shares') || '0'));
      await buy(symbol, shares, undefined);
    };
    (document.getElementById('buyCashForm') as HTMLFormElement).onsubmit = async (e) => {
      e.preventDefault();
      const form = new FormData(e.currentTarget as HTMLFormElement);
      const cash = parseFloat(String(form.get('cash') || '0'));
      await buy(symbol, undefined, cash);
    };
    (document.getElementById('buyMaxForm') as HTMLFormElement).onsubmit = async (e) => {
      e.preventDefault();
      await buy(symbol, undefined, (await getSystem()).cash);
    };
  }

  async function refresh() {
    const generation = ++refreshGeneration;
    try {
    const sys = await getSystem();
    if (generation !== refreshGeneration) return;

    els.date.textContent = sys.currentDate;
    els.day.textContent = dayName(sys.currentDate);
    els.time.textContent = sys.timeOfDay[0].toUpperCase() + sys.timeOfDay.slice(1);
    els.nextBtn.textContent = sys.timeOfDay === 'open' ? 'Jump to Market Close' : 'Next Day';
    els.cash.textContent = fmtCurrency(sys.cash);
    els.pv.textContent = fmtCurrency(sys.cash);
    hideJumpMessage();
    const weekend = isWeekend(sys.currentDate);
    els.skipWeekend.style.display = weekend ? '' : 'none';
    if (els.weekendNote) els.weekendNote.style.display = weekend ? '' : 'none';
    renderJumpSelectors(sys.currentDate);

    const [holdings, pinned] = await Promise.all([getHoldings(), getPinned()]);
    await Promise.all(holdings.map((holding) => loadPriceSeries(holding.symbol)));
    if (generation !== refreshGeneration) return;
    const holdingsMap = new Map(holdings.map((holding) => [holding.symbol, holding]));

    await renderPinned(pinned, sys.currentDate, holdingsMap, generation);
    if (generation !== refreshGeneration) return;

    const holdingsValue = await renderHoldings(holdings, sys.currentDate, generation);
    if (generation !== refreshGeneration || holdingsValue === undefined) return;

    await renderTransactions();
    if (generation !== refreshGeneration) return;

    await renderCryptos(sys.currentDate, generation);
    if (generation !== refreshGeneration) return;
    // If a buy card is open, refresh it so price and weekend state update
    if (els.buySection.style.display !== 'none' && currentBuySymbol) {
      await showBuySection(currentBuySymbol);
      if (generation !== refreshGeneration) return;
    }

    const pv = sys.cash + holdingsValue;
    if (generation !== refreshGeneration) return;
    els.pv.textContent = fmtCurrency(pv);

    const historyEntries = await appendPortfolioHistory({ date: sys.currentDate, time: sys.timeOfDay, value: pv });
    if (generation !== refreshGeneration) return;
    // Fill in missing months between the last recorded month and the current date,
    // recomputing portfolio value from holdings' prices so jumps still produce
    // a monthly data point per month.
    const monthlyFilled = await computeFilledMonthlyHistory(historyEntries, sys.currentDate, sys.cash, holdings);
    const chartData = adaptHistory(monthlyFilled);
    if (generation !== refreshGeneration) return;
    await renderChart(chartData);
  } catch (error) {
    console.error('refresh failed', error);
  }
}
  els.resetBtn.onclick = async () => {
    // Clear stores
    await db.clear('system');
    await db.clear('holdings');
    await db.clear('transactions');
    priceCache.clear();
    priceFetches.clear();
    await initDefaults();
    await refresh();
  };
    els.jumpWeek.onclick = async () => {
    const s = await getSystem();
    if (s.currentDate === MAX_DATE) {
      showMaxDateMessage();
      return;
    }
    const nextDate = plusDays(s.currentDate, 7);
    if (nextDate === MAX_DATE && nextDate !== s.currentDate) {
      showMaxDateMessage();
    } else {
      hideJumpMessage();
    }
    s.currentDate = nextDate;
    s.timeOfDay = 'open';
    await putSystem(s);
    await refresh();
  };
    els.jumpMonth.onclick = async () => {
    const s = await getSystem();
    if (s.currentDate === MAX_DATE) {
      showMaxDateMessage();
      return;
    }
    const nextDate = addMonths(s.currentDate, 1);
    if (nextDate === MAX_DATE && nextDate !== s.currentDate) {
      showMaxDateMessage();
    } else {
      hideJumpMessage();
    }
    s.currentDate = nextDate;
    s.timeOfDay = 'open';
    await putSystem(s);
    await refresh();
  };
    els.jumpYear.onclick = async () => {
    const s = await getSystem();
    if (s.currentDate === MAX_DATE) {
      showMaxDateMessage();
      return;
    }
    const nextDate = addMonths(s.currentDate, 12);
    if (nextDate === MAX_DATE && nextDate !== s.currentDate) {
      showMaxDateMessage();
    } else {
      hideJumpMessage();
    }
    s.currentDate = nextDate;
    s.timeOfDay = 'open';
    await putSystem(s);
    await refresh();
  };
    els.nextBtn.onclick = async () => {
    const s = await getSystem();
    if (s.currentDate === MAX_DATE && s.timeOfDay === 'close') {
      showMaxDateMessage();
      return;
    }
    hideJumpMessage();
    if (s.timeOfDay === 'open') {
      s.timeOfDay = 'close';
    } else {
      const nextDate = plusDays(s.currentDate, 1);
      if (nextDate === MAX_DATE && nextDate !== s.currentDate) {
        showMaxDateMessage();
      }
      s.currentDate = nextDate;
      s.timeOfDay = 'open';
    }
    await putSystem(s);
    await refresh();
  };
  els.skipWeekend.onclick = async () => {
    const s = await getSystem();
    if (s.currentDate === MAX_DATE && isWeekend(s.currentDate)) {
      showMaxDateMessage();
      return;
    }
    const current = parseUtcDate(s.currentDate);
    const dow = current.getUTCDay();
    const days = dow === 6 ? 2 : (dow === 0 ? 1 : (6 - dow));
    const nextDate = plusDays(s.currentDate, days);
    if (nextDate === MAX_DATE && nextDate !== s.currentDate) {
      showMaxDateMessage();
    } else {
      hideJumpMessage();
    }
    s.currentDate = nextDate;
    s.timeOfDay = 'open';
    await putSystem(s);
    await refresh();
  };
  els.jumpForm.onsubmit = async (e) => {
    e.preventDefault();
    const y = +els.jumpYearSel.value;
    const m = +els.jumpMonthSel.value;
    const d = +els.jumpDaySel.value;
    const target = new Date(Date.UTC(y, m - 1, d));
    const rawIso = target.toISOString().slice(0, 10);
    let iso = clampDate(rawIso);
    const s = await getSystem();
    if (iso < s.currentDate) {
      els.jumpError.textContent = "You can't travel backwards in time!";
      els.jumpError.style.display = 'block';
      return;
    }
    if (iso === MAX_DATE && rawIso > MAX_DATE) {
      showMaxDateMessage();
    } else {
      hideJumpMessage();
    }
    s.currentDate = iso;
    s.timeOfDay = 'open';
    await putSystem(s);
    await refresh();
  };

  await refresh();
}

main();







