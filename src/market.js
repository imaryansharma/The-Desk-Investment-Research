// ============================================================
// MARKET DATA — Yahoo Finance (free, no API key required)
// Routes through /api/yahoo Vite dev proxy to bypass browser CORS,
// with a public CORS proxy fallback for non-dev environments.
// ============================================================

const YAHOO_HOST  = 'https://query1.finance.yahoo.com';
const CORS_PROXY  = 'https://corsproxy.io/?';

// Ticker → Yahoo symbol overrides for indices, currencies, commodities.
const SPECIAL_MAP = {
  NIFTY:      '^NSEI',
  NIFTY50:    '^NSEI',
  SENSEX:     '^BSESN',
  BANKNIFTY:  '^NSEBANK',
  INDIAVIX:   '^INDIAVIX',
  NIFTYIT:    '^CNXIT',
  NIFTYBANK:  '^NSEBANK',
  NIFTYAUTO:  '^CNXAUTO',
  NIFTYPHARMA:'^CNXPHARMA',
  DOW:        '^DJI',
  DOWJONES:   '^DJI',
  SP500:      '^GSPC',
  NASDAQ:     '^IXIC',
  USDINR:     'INR=X',
  CRUDE:      'CL=F',
  GOLD:       'GC=F',
};

export function toYahooSymbol(ticker) {
  if (!ticker) return '';
  const raw = String(ticker).toUpperCase().trim();
  if (raw.startsWith('^')) return raw;
  const key = raw.replace(/\s+/g, '').replace(/[-_&]/g, '');
  if (SPECIAL_MAP[key]) return SPECIAL_MAP[key];
  if (raw.includes('=') || raw.endsWith('.NS') || raw.endsWith('.BO')) return raw;
  // Yahoo uses "M_M.NS" for M&M; strip & from source to match.
  const cleaned = raw.replace(/&/g, '_');
  return `${cleaned}.NS`;
}

// Curated NSE constituent lists — used by Today's Picks so we can render
// real prices without an LLM call. Update annually if index composition shifts.
export const SECTOR_TICKERS = {
  largecap: [
    { ticker: 'RELIANCE',    name: 'Reliance Industries' },
    { ticker: 'HDFCBANK',    name: 'HDFC Bank' },
    { ticker: 'TCS',         name: 'Tata Consultancy Services' },
    { ticker: 'INFY',        name: 'Infosys' },
    { ticker: 'ICICIBANK',   name: 'ICICI Bank' },
    { ticker: 'BHARTIARTL',  name: 'Bharti Airtel' },
    { ticker: 'ITC',         name: 'ITC' },
    { ticker: 'LT',          name: 'Larsen & Toubro' },
    { ticker: 'SBIN',        name: 'State Bank of India' },
    { ticker: 'HINDUNILVR',  name: 'Hindustan Unilever' },
    { ticker: 'BAJFINANCE',  name: 'Bajaj Finance' },
    { ticker: 'MARUTI',      name: 'Maruti Suzuki' },
    { ticker: 'ASIANPAINT',  name: 'Asian Paints' },
    { ticker: 'AXISBANK',    name: 'Axis Bank' },
    { ticker: 'KOTAKBANK',   name: 'Kotak Mahindra Bank' },
    { ticker: 'SUNPHARMA',   name: 'Sun Pharma' },
    { ticker: 'TITAN',       name: 'Titan Company' },
    { ticker: 'ULTRACEMCO',  name: 'UltraTech Cement' },
    { ticker: 'ADANIENT',    name: 'Adani Enterprises' },
    { ticker: 'NTPC',        name: 'NTPC' },
  ],
  midcap: [
    { ticker: 'PERSISTENT',  name: 'Persistent Systems' },
    { ticker: 'COFORGE',     name: 'Coforge' },
    { ticker: 'DIXON',       name: 'Dixon Technologies' },
    { ticker: 'POLYCAB',     name: 'Polycab India' },
    { ticker: 'MPHASIS',     name: 'Mphasis' },
    { ticker: 'INDIGO',      name: 'InterGlobe Aviation' },
    { ticker: 'ASTRAL',      name: 'Astral' },
    { ticker: 'BALKRISIND',  name: 'Balkrishna Industries' },
    { ticker: 'AUBANK',      name: 'AU Small Finance Bank' },
    { ticker: 'CUMMINSIND',  name: 'Cummins India' },
    { ticker: 'PIIND',       name: 'PI Industries' },
    { ticker: 'JUBLFOOD',    name: 'Jubilant FoodWorks' },
    { ticker: 'TVSMOTOR',    name: 'TVS Motor' },
    { ticker: 'MRF',         name: 'MRF' },
  ],
  it: [
    { ticker: 'TCS',         name: 'Tata Consultancy Services' },
    { ticker: 'INFY',        name: 'Infosys' },
    { ticker: 'HCLTECH',     name: 'HCL Technologies' },
    { ticker: 'WIPRO',       name: 'Wipro' },
    { ticker: 'TECHM',       name: 'Tech Mahindra' },
    { ticker: 'LTIM',        name: 'LTIMindtree' },
    { ticker: 'PERSISTENT',  name: 'Persistent Systems' },
    { ticker: 'COFORGE',     name: 'Coforge' },
    { ticker: 'MPHASIS',     name: 'Mphasis' },
    { ticker: 'OFSS',        name: 'Oracle Financial Services' },
  ],
  bank: [
    { ticker: 'HDFCBANK',    name: 'HDFC Bank' },
    { ticker: 'ICICIBANK',   name: 'ICICI Bank' },
    { ticker: 'SBIN',        name: 'State Bank of India' },
    { ticker: 'KOTAKBANK',   name: 'Kotak Mahindra Bank' },
    { ticker: 'AXISBANK',    name: 'Axis Bank' },
    { ticker: 'INDUSINDBK',  name: 'IndusInd Bank' },
    { ticker: 'FEDERALBNK',  name: 'Federal Bank' },
    { ticker: 'IDFCFIRSTB',  name: 'IDFC First Bank' },
    { ticker: 'PNB',         name: 'Punjab National Bank' },
    { ticker: 'BANKBARODA',  name: 'Bank of Baroda' },
  ],
  auto: [
    { ticker: 'MARUTI',      name: 'Maruti Suzuki' },
    { ticker: 'M&M',         name: 'Mahindra & Mahindra' },
    { ticker: 'TATAMOTORS',  name: 'Tata Motors' },
    { ticker: 'BAJAJ-AUTO',  name: 'Bajaj Auto' },
    { ticker: 'HEROMOTOCO',  name: 'Hero MotoCorp' },
    { ticker: 'EICHERMOT',   name: 'Eicher Motors' },
    { ticker: 'TVSMOTOR',    name: 'TVS Motor' },
    { ticker: 'ASHOKLEY',    name: 'Ashok Leyland' },
    { ticker: 'MRF',         name: 'MRF' },
    { ticker: 'BHARATFORG',  name: 'Bharat Forge' },
  ],
  pharma: [
    { ticker: 'SUNPHARMA',   name: 'Sun Pharma' },
    { ticker: 'DRREDDY',     name: 'Dr. Reddys Labs' },
    { ticker: 'CIPLA',       name: 'Cipla' },
    { ticker: 'DIVISLAB',    name: 'Divis Laboratories' },
    { ticker: 'LUPIN',       name: 'Lupin' },
    { ticker: 'AUROPHARMA',  name: 'Aurobindo Pharma' },
    { ticker: 'TORNTPHARM',  name: 'Torrent Pharma' },
    { ticker: 'ZYDUSLIFE',   name: 'Zydus Lifesciences' },
    { ticker: 'BIOCON',      name: 'Biocon' },
    { ticker: 'GLENMARK',    name: 'Glenmark Pharma' },
  ],
};

// momentum & value are computed dynamically from largecap by sort/filter
SECTOR_TICKERS.momentum = SECTOR_TICKERS.largecap;
SECTOR_TICKERS.value    = SECTOR_TICKERS.largecap;

async function yahooFetch(path) {
  // 1) Try Vite dev proxy (fastest, most reliable in dev)
  try {
    const res = await fetch(`/api/yahoo${path}`);
    if (res.ok) {
      const ct = res.headers.get('content-type') || '';
      if (ct.includes('application/json')) return res.json();
    }
  } catch { /* fall through */ }

  // 2) Fallback: public CORS proxy (works in preview/prod static)
  const url = `${CORS_PROXY}${encodeURIComponent(YAHOO_HOST + path)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Yahoo ${res.status}`);
  return res.json();
}

export async function getQuote(ticker) {
  const symbol = toYahooSymbol(ticker);
  const data = await yahooFetch(`/v8/finance/chart/${encodeURIComponent(symbol)}?range=5d&interval=1d`);
  const result = data?.chart?.result?.[0];
  if (!result) throw new Error(`No data for ${ticker}`);
  const meta  = result.meta || {};
  const price = meta.regularMarketPrice;
  const prev  = meta.chartPreviousClose ?? meta.previousClose ?? price;
  const change    = price - prev;
  const changePct = prev ? (change / prev) * 100 : 0;
  return {
    ticker: String(ticker).toUpperCase(),
    symbol,
    name:  meta.longName || meta.shortName || String(ticker).toUpperCase(),
    price,
    previousClose: prev,
    change,
    changePct,
    currency: meta.currency || 'INR',
    dayHigh:  meta.regularMarketDayHigh,
    dayLow:   meta.regularMarketDayLow,
    volume:   meta.regularMarketVolume,
    exchange: meta.exchangeName,
  };
}

export async function getHistory(ticker, range = '5y', interval = '1mo') {
  const symbol = toYahooSymbol(ticker);
  const data = await yahooFetch(`/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}`);
  const result = data?.chart?.result?.[0];
  if (!result) throw new Error(`No history for ${ticker}`);
  const timestamps = result.timestamp || [];
  const closes = result.indicators?.quote?.[0]?.close || [];
  return timestamps
    .map((t, i) => ({ date: new Date(t * 1000), close: closes[i] }))
    .filter(p => p.close != null);
}

export function computeReturns(history) {
  if (!history || history.length < 2) return null;
  const last = history[history.length - 1];
  const price = last.close;
  const today = last.date;
  const daysBefore = (d) => new Date(today.getTime() - d * 86400000);
  const findAtOrBefore = (target) => {
    let best = null;
    for (const p of history) {
      if (p.date <= target) best = p; else break;
    }
    return best;
  };
  const pct  = (past) => past?.close ? ((price - past.close) / past.close) * 100 : null;
  const cagr = (past, years) => past?.close ? (Math.pow(price / past.close, 1 / years) - 1) * 100 : null;
  const fmt  = (n, suffix = '') => n == null ? null : `${n >= 0 ? '+' : ''}${n.toFixed(1)}%${suffix}`;

  return {
    '1M': fmt(pct(findAtOrBefore(daysBefore(30)))),
    '3M': fmt(pct(findAtOrBefore(daysBefore(90)))),
    '6M': fmt(pct(findAtOrBefore(daysBefore(180)))),
    '1Y': fmt(pct(findAtOrBefore(daysBefore(365)))),
    '3Y': fmt(cagr(findAtOrBefore(daysBefore(365 * 3)), 3), ' CAGR'),
    '5Y': fmt(cagr(findAtOrBefore(daysBefore(365 * 5)), 5), ' CAGR'),
  };
}

export async function getBatchQuotes(tickers) {
  const results = await Promise.allSettled(tickers.map(t => getQuote(t)));
  return results.map((r, i) =>
    r.status === 'fulfilled'
      ? r.value
      : { ticker: tickers[i], error: r.reason?.message, failed: true }
  );
}

export function formatPrice(price, currency = 'INR') {
  if (price == null || !Number.isFinite(price)) return '—';
  const sym = currency === 'INR' ? '₹' : currency === 'USD' ? '$' : `${currency} `;
  return `${sym}${price.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function formatChangePct(pct) {
  if (pct == null || !Number.isFinite(pct)) return '—';
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`;
}
