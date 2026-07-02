// ============================================================
// ANALYSIS JOURNAL — Supabase-backed learning loop
// Every deep-dive analysis is saved. Prior calls for the same
// ticker + globally worst misses are injected into the next prompt
// so the model can learn from previous mistakes.
//
// Setup (one-time, per user):
//   1. Create a free Supabase project at supabase.com/dashboard
//   2. Paste the Project URL + anon key into the app's Settings modal
//   3. Run the SQL in JOURNAL_SETUP_SQL (below) in Supabase's SQL editor
//   4. Row-Level Security is disabled by default here since this is a
//      single-user personal app. Enable RLS + auth if that changes.
// ============================================================
import { createClient } from '@supabase/supabase-js';

export const JOURNAL_SETUP_SQL = `create table if not exists analyses (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz default now(),
  ticker text not null,
  company_name text,
  provider text,
  horizon text,
  price_at_analysis numeric,
  currency text,
  recommendation text,
  confidence int,
  risk text,
  fair_value text,
  buy_range text,
  target_price numeric,
  summary text,
  reasoning jsonb,
  bull_case jsonb,
  bear_case jsonb,
  full_data jsonb,
  reviewed_at timestamptz,
  price_at_review numeric,
  outcome text,
  return_pct numeric,
  lessons text
);
create index if not exists analyses_ticker_idx on analyses (ticker);
create index if not exists analyses_created_idx on analyses (created_at desc);
alter table analyses disable row level security;`;

function getConfig() {
  try {
    return {
      url: localStorage.getItem('supabaseUrl') || '',
      key: localStorage.getItem('supabaseAnonKey') || '',
    };
  } catch { return { url: '', key: '' }; }
}

let _client = null;
let _clientKey = '';

// Lazy singleton — rebuilds only when URL/key change.
function client() {
  const { url, key } = getConfig();
  if (!url || !key) return null;
  const cacheKey = `${url}|${key}`;
  if (_client && _clientKey === cacheKey) return _client;
  _client = createClient(url, key, {
    auth: { persistSession: false },
  });
  _clientKey = cacheKey;
  return _client;
}

export function journalReady() { return !!client(); }

// Parse "Rs 3,250" / "₹3,250.5" / "3250" into a plain number, or null.
function parsePrice(str) {
  if (str == null) return null;
  if (typeof str === 'number') return Number.isFinite(str) ? str : null;
  const cleaned = String(str).replace(/[,\s₹$€£]/g, '').replace(/^Rs\.?/i, '');
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}

export async function saveAnalysis(record) {
  const c = client();
  if (!c) return { ok: false, reason: 'not-configured' };
  const row = {
    ticker: record.ticker,
    company_name: record.companyName || null,
    provider: record.provider || null,
    horizon: record.horizon || null,
    price_at_analysis: parsePrice(record.priceAtAnalysis),
    currency: record.currency || 'INR',
    recommendation: record.recommendation || null,
    confidence: record.confidence != null ? parseInt(record.confidence, 10) || null : null,
    risk: record.risk || null,
    fair_value: record.fairValue || null,
    buy_range: record.buyRange || null,
    target_price: parsePrice(record.fairValue),
    summary: record.summary || null,
    reasoning: record.reasoning || null,
    bull_case: record.bullCase || null,
    bear_case: record.bearCase || null,
    full_data: record.fullData || null,
  };
  const { data, error } = await c.from('analyses').insert(row).select('id').single();
  if (error) return { ok: false, reason: error.message };
  return { ok: true, id: data.id };
}

export async function listForTicker(ticker, limit = 5) {
  const c = client();
  if (!c || !ticker) return [];
  const { data, error } = await c
    .from('analyses')
    .select('*')
    .eq('ticker', ticker.toUpperCase())
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) { console.warn('journal listForTicker:', error.message); return []; }
  return data || [];
}

// Worst-performing prior calls across all tickers — teaches the model
// what past mistakes look like.
export async function listRecentMisses(limit = 5) {
  const c = client();
  if (!c) return [];
  const { data, error } = await c
    .from('analyses')
    .select('*')
    .eq('outcome', 'MISS')
    .order('return_pct', { ascending: true }) // most negative first
    .limit(limit);
  if (error) { console.warn('journal listRecentMisses:', error.message); return []; }
  return data || [];
}

export async function listAll(limit = 100) {
  const c = client();
  if (!c) return [];
  const { data, error } = await c
    .from('analyses')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) { console.warn('journal listAll:', error.message); return []; }
  return data || [];
}

export async function updateReview(id, patch) {
  const c = client();
  if (!c) return { ok: false, reason: 'not-configured' };
  const row = {
    reviewed_at: new Date().toISOString(),
    price_at_review: patch.priceAtReview != null ? parsePrice(patch.priceAtReview) : undefined,
    outcome: patch.outcome || undefined,       // HIT | MISS | PENDING
    return_pct: patch.returnPct != null ? Number(patch.returnPct) : undefined,
    lessons: patch.lessons != null ? patch.lessons : undefined,
  };
  Object.keys(row).forEach(k => row[k] === undefined && delete row[k]);
  const { error } = await c.from('analyses').update(row).eq('id', id);
  if (error) return { ok: false, reason: error.message };
  return { ok: true };
}

export async function deleteAnalysis(id) {
  const c = client();
  if (!c) return { ok: false, reason: 'not-configured' };
  const { error } = await c.from('analyses').delete().eq('id', id);
  if (error) return { ok: false, reason: error.message };
  return { ok: true };
}

// Build a compact context block for the next LLM prompt.
// Includes prior ticker-specific calls and top global misses so the
// model can reference past decisions and avoid repeating errors.
export function formatMemoryForPrompt(priorTicker, globalMisses) {
  const lines = [];
  if (priorTicker?.length) {
    lines.push('PRIOR ANALYSES FOR THIS TICKER (most recent first):');
    priorTicker.forEach(a => {
      const when = new Date(a.created_at).toISOString().slice(0, 10);
      const outcome = a.outcome ? ` — outcome: ${a.outcome}${a.return_pct != null ? ` (${a.return_pct.toFixed(1)}%)` : ''}` : '';
      const price = a.price_at_analysis != null ? ` at ${a.currency || ''} ${a.price_at_analysis}` : '';
      const lessons = a.lessons ? ` | lessons: ${a.lessons}` : '';
      lines.push(`- ${when}: ${a.recommendation || '?'} (${a.horizon || '?'} horizon${price})${outcome}${lessons}`);
      if (a.reasoning?.assumptions?.length) {
        lines.push(`  assumed: ${a.reasoning.assumptions.slice(0, 3).join('; ')}`);
      }
    });
  }
  if (globalMisses?.length) {
    lines.push('');
    lines.push('RECENT WORST CALLS (across all tickers — learn from these):');
    globalMisses.forEach(m => {
      const when = new Date(m.created_at).toISOString().slice(0, 10);
      lines.push(`- ${when} ${m.ticker}: called ${m.recommendation}, return ${m.return_pct?.toFixed(1)}%${m.lessons ? ` — ${m.lessons}` : ''}`);
    });
  }
  if (!lines.length) return '';
  return `\n\n=== MEMORY FROM PAST ANALYSES ===\n${lines.join('\n')}\n=== END MEMORY ===\n\nExplicitly reference relevant past calls above and explain what you'll do differently. Do not repeat mistakes flagged in "worst calls".\n`;
}
