// ============================================================
// ANALYSIS JOURNAL — Supabase-backed structured learning loop
// Every recommendation (stock, portfolio, screen) is saved. Prior calls
// for the same ticker + structured global mistake patterns are injected
// into the next prompt so the model learns from previous errors.
//
// Setup: paste the Project URL + anon key into Settings, then run
// JOURNAL_SETUP_SQL once in Supabase's SQL editor. See PROJECT.md.
// Migration: existing users only need to run JOURNAL_MIGRATION_SQL —
// it adds nullable columns; old rows continue to work unchanged.
// ============================================================
import { createClient } from '@supabase/supabase-js';

// Enumerated mistake categories — keep in sync with UI dropdown + prompt guidance.
export const MISTAKE_CATEGORIES = [
  'stale_data',        // used out-of-date price / news / results
  'wrong_assumption',  // key assumption turned out false
  'valuation_error',   // over/under-paid — multiples were wrong for the regime
  'earnings_surprise', // Q result diverged sharply from expectation
  'macro_shift',       // rate / currency / policy shift invalidated thesis
  'thesis_drift',      // company pivoted, thesis no longer relevant
  'data_gap',          // key datapoint was "unavailable" but call was made anyway
  'concentration',     // portfolio-level: too heavy in one name/sector
  'other',
];

// Bump when the deep-dive prompt schema changes materially. Stored per row
// so we can later filter memory to prompt-versions matching current logic.
export const PROMPT_VERSION = 'v2-2026-07';

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
  lessons text,
  -- v2 additions (structured learning + audit trail)
  record_type text default 'stock_deepdive',
  mistake_category text,
  what_was_missed text,
  what_to_check text,
  market_regime text,
  model_version text,
  prompt_version text,
  grounded boolean,
  stated_confidence int,
  calibrated_confidence int,
  invalidators jsonb,
  recheck_triggers jsonb,
  prior_mistakes_considered jsonb,
  safety_gate jsonb
);
create index if not exists analyses_ticker_idx on analyses (ticker);
create index if not exists analyses_created_idx on analyses (created_at desc);
create index if not exists analyses_record_type_idx on analyses (record_type);
create index if not exists analyses_mistake_cat_idx on analyses (mistake_category);
alter table analyses disable row level security;`;

// For users upgrading from v1 — additive only.
export const JOURNAL_MIGRATION_SQL = `alter table analyses add column if not exists record_type text default 'stock_deepdive';
alter table analyses add column if not exists mistake_category text;
alter table analyses add column if not exists what_was_missed text;
alter table analyses add column if not exists what_to_check text;
alter table analyses add column if not exists market_regime text;
alter table analyses add column if not exists model_version text;
alter table analyses add column if not exists prompt_version text;
alter table analyses add column if not exists grounded boolean;
alter table analyses add column if not exists stated_confidence int;
alter table analyses add column if not exists calibrated_confidence int;
alter table analyses add column if not exists invalidators jsonb;
alter table analyses add column if not exists recheck_triggers jsonb;
alter table analyses add column if not exists prior_mistakes_considered jsonb;
alter table analyses add column if not exists safety_gate jsonb;
create index if not exists analyses_record_type_idx on analyses (record_type);
create index if not exists analyses_mistake_cat_idx on analyses (mistake_category);`;

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

function client() {
  const { url, key } = getConfig();
  if (!url || !key) return null;
  const cacheKey = `${url}|${key}`;
  if (_client && _clientKey === cacheKey) return _client;
  _client = createClient(url, key, { auth: { persistSession: false } });
  _clientKey = cacheKey;
  return _client;
}

export function journalReady() { return !!client(); }

export async function testConnection() {
  const c = client();
  if (!c) return { ok: false, reason: 'Not configured — add URL and anon key in Settings.' };
  const { count, error } = await c.from('analyses').select('*', { count: 'exact', head: true });
  if (error) return { ok: false, reason: error.message };
  return { ok: true, count: count ?? 0 };
}

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
    // v2 fields
    record_type: record.recordType || 'stock_deepdive',
    market_regime: record.marketRegime || null,
    model_version: record.modelVersion || null,
    prompt_version: record.promptVersion || PROMPT_VERSION,
    grounded: record.grounded ?? null,
    stated_confidence: record.statedConfidence != null ? parseInt(record.statedConfidence, 10) || null : null,
    calibrated_confidence: record.calibratedConfidence != null ? parseInt(record.calibratedConfidence, 10) || null : null,
    invalidators: record.invalidators || null,
    recheck_triggers: record.recheckTriggers || null,
    prior_mistakes_considered: record.priorMistakesConsidered || null,
    safety_gate: record.safetyGate || null,
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

export async function listRecentMisses(limit = 5) {
  const c = client();
  if (!c) return [];
  const { data, error } = await c
    .from('analyses')
    .select('*')
    .eq('outcome', 'MISS')
    .order('return_pct', { ascending: true })
    .limit(limit);
  if (error) { console.warn('journal listRecentMisses:', error.message); return []; }
  return data || [];
}

export async function listAll(limit = 100, recordType) {
  const c = client();
  if (!c) return [];
  let q = c.from('analyses').select('*').order('created_at', { ascending: false }).limit(limit);
  if (recordType) q = q.eq('record_type', recordType);
  const { data, error } = await q;
  if (error) { console.warn('journal listAll:', error.message); return []; }
  return data || [];
}

export async function updateReview(id, patch) {
  const c = client();
  if (!c) return { ok: false, reason: 'not-configured' };
  const row = {
    reviewed_at: new Date().toISOString(),
    price_at_review: patch.priceAtReview != null ? parsePrice(patch.priceAtReview) : undefined,
    outcome: patch.outcome || undefined,
    return_pct: patch.returnPct != null ? Number(patch.returnPct) : undefined,
    lessons: patch.lessons != null ? patch.lessons : undefined,
    mistake_category: patch.mistakeCategory !== undefined ? (patch.mistakeCategory || null) : undefined,
    what_was_missed: patch.whatWasMissed !== undefined ? (patch.whatWasMissed || null) : undefined,
    what_to_check: patch.whatToCheck !== undefined ? (patch.whatToCheck || null) : undefined,
    market_regime: patch.marketRegime !== undefined ? (patch.marketRegime || null) : undefined,
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

// Aggregate stats: hit rate per action, worst recurring mistake categories, count by outcome.
// Runs client-side over recent rows — fine for a personal single-user app.
export async function getMistakeStats(limit = 500) {
  const c = client();
  if (!c) return null;
  const { data, error } = await c
    .from('analyses')
    .select('recommendation,outcome,return_pct,mistake_category,record_type')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) return null;
  const rows = data || [];
  const byAction = {};   // { BUY: {hit, miss, pending, avgReturn} }
  const byMistake = {};  // { mistake_category: count }
  for (const r of rows) {
    const a = r.recommendation || 'UNKNOWN';
    if (!byAction[a]) byAction[a] = { hit: 0, miss: 0, pending: 0, returns: [] };
    if (r.outcome === 'HIT')  byAction[a].hit++;
    else if (r.outcome === 'MISS') byAction[a].miss++;
    else byAction[a].pending++;
    if (r.return_pct != null) byAction[a].returns.push(Number(r.return_pct));
    if (r.mistake_category) byMistake[r.mistake_category] = (byMistake[r.mistake_category] || 0) + 1;
  }
  const actionStats = Object.entries(byAction).map(([action, s]) => {
    const total = s.hit + s.miss;
    const avgReturn = s.returns.length ? s.returns.reduce((a, b) => a + b, 0) / s.returns.length : null;
    return {
      action,
      hit: s.hit,
      miss: s.miss,
      pending: s.pending,
      hitRate: total > 0 ? (s.hit / total) * 100 : null,
      avgReturn,
    };
  }).sort((a, b) => (b.hit + b.miss) - (a.hit + a.miss));
  const mistakeStats = Object.entries(byMistake)
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => b.count - a.count);
  return { actionStats, mistakeStats, totalRows: rows.length };
}

// Return recent MISS rows for a specific ticker — used by the safety gate
// to detect repeat-mistake risk (same thesis, same failure pattern).
export async function listMissesForTicker(ticker, limit = 5) {
  const c = client();
  if (!c || !ticker) return [];
  const { data, error } = await c
    .from('analyses')
    .select('*')
    .eq('ticker', ticker.toUpperCase())
    .eq('outcome', 'MISS')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) return [];
  return data || [];
}

// Build a rich context block. Now includes:
//  - Prior calls for this ticker (with outcome + structured mistake fields)
//  - Global mistake-pattern frequencies so the model knows what to watch for
//  - Explicit instruction to reference and avoid repeat patterns
export function formatMemoryForPrompt(priorTicker, globalMisses, mistakeStats) {
  const lines = [];
  if (priorTicker?.length) {
    lines.push('PRIOR ANALYSES FOR THIS TICKER (most recent first):');
    priorTicker.forEach(a => {
      const when = new Date(a.created_at).toISOString().slice(0, 10);
      const outcome = a.outcome ? ` — ${a.outcome}${a.return_pct != null ? ` (${a.return_pct.toFixed(1)}%)` : ''}` : '';
      const price = a.price_at_analysis != null ? ` at ${a.currency || ''} ${a.price_at_analysis}` : '';
      lines.push(`- ${when}: ${a.recommendation || '?'} (${a.horizon || '?'} horizon${price})${outcome}`);
      if (a.mistake_category)  lines.push(`  mistake: ${a.mistake_category}${a.what_was_missed ? ` — ${a.what_was_missed}` : ''}`);
      if (a.what_to_check)     lines.push(`  check-next-time: ${a.what_to_check}`);
      if (a.market_regime)     lines.push(`  regime-then: ${a.market_regime}`);
      if (a.lessons)           lines.push(`  free-form lessons: ${a.lessons}`);
      if (a.reasoning?.assumptions?.length) {
        lines.push(`  prior assumed: ${a.reasoning.assumptions.slice(0, 3).join('; ')}`);
      }
    });
  }
  if (globalMisses?.length) {
    lines.push('');
    lines.push('RECENT WORST CALLS ACROSS TICKERS (avoid these patterns):');
    globalMisses.forEach(m => {
      const when = new Date(m.created_at).toISOString().slice(0, 10);
      const cat = m.mistake_category ? ` [${m.mistake_category}]` : '';
      lines.push(`- ${when} ${m.ticker}: ${m.recommendation} → ${m.return_pct?.toFixed(1)}%${cat}${m.what_was_missed ? ` — ${m.what_was_missed}` : (m.lessons ? ` — ${m.lessons}` : '')}`);
    });
  }
  if (mistakeStats?.mistakeStats?.length) {
    lines.push('');
    lines.push('MISTAKE-CATEGORY FREQUENCY (higher = more repeated by this desk):');
    mistakeStats.mistakeStats.slice(0, 5).forEach(m => {
      lines.push(`- ${m.category}: ${m.count} occurrence(s)`);
    });
  }
  if (!lines.length) return '';
  return `\n\n=== MEMORY FROM PAST ANALYSES ===\n${lines.join('\n')}\n=== END MEMORY ===\n\nBefore recommending, check whether this thesis matches any pattern above. In your reasoning, populate priorMistakesConsidered with an array of {pattern, howAvoided} entries. If the current call closely resembles a prior MISS with no material change in setup, downgrade the action toward WATCH.\n`;
}
