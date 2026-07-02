import React, { useState, useEffect, useRef } from 'react';
import {
  TrendingUp, TrendingDown, Briefcase, Search, Filter,
  Settings, Download, RefreshCw, Plus, Trash2, AlertCircle,
  Copy, Check, ChevronRight, Zap, BarChart3, Building2,
  Globe, Newspaper, Target, X, Loader2, Clock
} from 'lucide-react';
import {
  SECTOR_TICKERS,
  getQuote,
  getHistory,
  getBatchQuotes,
  computeReturns,
  formatPrice,
  formatChangePct,
} from './market.js';
import {
  JOURNAL_SETUP_SQL,
  journalReady,
  saveAnalysis,
  listForTicker,
  listRecentMisses,
  listAll,
  updateReview,
  deleteAnalysis,
  formatMemoryForPrompt,
} from './journal.js';

// ============================================================
// DESIGN TOKENS — "Personal Research Desk"
// Warm forest-black base, aged brass accent, sage highlights.
// Not Bloomberg orange, not acid green. Yours.
// ============================================================
const C = {
  bg:       '#0E1512',   // deep forest-black, warm undertone
  surface:  '#171F1B',   // panel
  surface2: '#1F2A24',   // card
  border:   '#2A362F',   // hairline
  borderStrong: '#3A483F',
  text:     '#EDE7D8',   // warm paper
  textMute: '#8B9791',   // muted sage
  textDim:  '#5A6862',
  brass:    '#C7A96B',   // signature accent
  brassDim: '#8F7A4B',
  pos:      '#7FB86B',   // moss green — gains
  neg:      '#D06E5D',   // terracotta — losses
  info:     '#6B8CAE',   // steel blue — neutral
  warn:     '#D4B048',   // amber — alerts
};

const FONT_DISPLAY = "'Fraunces', 'Newsreader', Georgia, serif";
const FONT_BODY    = "'Inter', system-ui, -apple-system, sans-serif";
const FONT_MONO    = "'JetBrains Mono', 'SF Mono', Consolas, monospace";

// ============================================================
// LLM PROVIDERS — Gemini (grounded search) or Groq (raw speed)
// Gemini: free key at https://aistudio.google.com/app/apikey — supports google_search grounding.
// Groq:   free key at https://console.groq.com/keys — 5-10x faster generation, no built-in search.
// The active provider is chosen in Settings; grounded modules (daily brief, deep-dive) get worse
// results on Groq because it can't see today's news.
// ============================================================
// flash-lite first: ~2× faster, less prone to 503 during peak hours.
const GEMINI_MODELS = ['gemini-2.5-flash-lite', 'gemini-2.5-flash', 'gemini-2.0-flash'];
const GROQ_MODELS   = ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'];

function getApiKey() {
  try { return localStorage.getItem('geminiApiKey') || ''; }
  catch { return ''; }
}
function getGroqKey() {
  try { return localStorage.getItem('groqApiKey') || ''; }
  catch { return ''; }
}
function getProvider() {
  try { return localStorage.getItem('llmProvider') || 'gemini'; }
  catch { return 'gemini'; }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function callGeminiOnce(model, apiKey, body) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const txt = await res.text();
    const err = new Error(`Gemini ${res.status}: ${txt.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  const cand = data?.candidates?.[0];
  const parts = cand?.content?.parts || [];
  const text = parts.map(p => p.text).filter(Boolean).join('\n');
  if (!text) {
    const err = new Error('Gemini returned an empty response.');
    err.status = 502;
    throw err;
  }
  return text;
}

async function callGroqOnce(model, apiKey, body) {
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ ...body, model }),
  });
  if (!res.ok) {
    const txt = await res.text();
    const err = new Error(`Groq ${res.status}: ${txt.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content || '';
  if (!text) {
    const err = new Error('Groq returned an empty response.');
    err.status = 502;
    throw err;
  }
  return text;
}

async function callClaude(prompt, { maxTokens = 4000, useSearch = true } = {}) {
  const provider = getProvider();

  if (provider === 'groq') {
    const apiKey = getGroqKey();
    if (!apiKey) {
      throw new Error('No Groq API key. Click the gear icon (top right) and paste a key from console.groq.com/keys');
    }
    // Groq has no built-in web search — grounded prompts still work but see stale info.
    // Nudge the model into JSON since callers all expect JSON output.
    const body = {
      messages: [{ role: 'user', content: prompt }],
      max_tokens: maxTokens,
      temperature: 0.4,
      response_format: { type: 'json_object' },
    };
    let lastErr;
    for (const model of GROQ_MODELS) {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          return await callGroqOnce(model, apiKey, body);
        } catch (e) {
          lastErr = e;
          const retryable = e.status === 429 || e.status === 503 || e.status === 502 || e.status === 500;
          if (!retryable) throw e;
          await sleep(1000 * Math.pow(2, attempt));
        }
      }
    }
    throw new Error(`All Groq models failing after retries. Last error — ${lastErr?.message || 'unknown'}. Try again in a minute.`);
  }

  // Default: Gemini
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new Error('No Gemini API key. Click the gear icon (top right) and paste a key from aistudio.google.com/app/apikey');
  }

  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { maxOutputTokens: maxTokens, temperature: 0.4 },
  };
  if (useSearch) {
    body.tools = [{ google_search: {} }];
  }

  let lastErr;
  // Try each model. For each, retry up to 3 times on transient errors (429/503/502).
  for (const model of GEMINI_MODELS) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await callGeminiOnce(model, apiKey, body);
      } catch (e) {
        lastErr = e;
        const retryable = e.status === 429 || e.status === 503 || e.status === 502 || e.status === 500;
        if (!retryable) throw e;
        // exponential backoff: 1s, 2s, 4s
        await sleep(1000 * Math.pow(2, attempt));
      }
    }
    // this model kept failing; try the next fallback model
  }
  throw new Error(`All Gemini models overloaded after retries. Last error — ${lastErr?.message || 'unknown'}. Try again in a minute.`);
}

function extractJSON(text) {
  const cleaned = text.replace(/```json|```/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('No JSON in response');
  return JSON.parse(cleaned.slice(start, end + 1));
}

// ============================================================
// STORAGE HELPERS — browser localStorage
// ============================================================
async function storageGet(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}
async function storageSet(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
}

// ============================================================
// SHARED UI
// ============================================================
function Card({ children, style, ...props }) {
  return (
    <div style={{
      background: C.surface2,
      border: `1px solid ${C.border}`,
      borderRadius: 4,
      padding: 20,
      ...style
    }} {...props}>
      {children}
    </div>
  );
}

function Metric({ label, value, change, size = 'md' }) {
  const isPositive = change && (change.startsWith('+') || (parseFloat(change) > 0 && !change.startsWith('-')));
  const isNegative = change && change.startsWith('-');
  const color = isPositive ? C.pos : isNegative ? C.neg : C.textMute;
  const sizes = {
    sm: { value: 16, label: 10 },
    md: { value: 22, label: 11 },
    lg: { value: 28, label: 12 },
  };
  const s = sizes[size];
  return (
    <div>
      <div style={{ 
        fontFamily: FONT_MONO, 
        fontSize: 9, 
        color: C.textDim, 
        textTransform: 'uppercase', 
        letterSpacing: 1.5,
        marginBottom: 4
      }}>
        {label}
      </div>
      <div style={{ 
        fontFamily: FONT_MONO, 
        fontSize: s.value, 
        color: C.text, 
        fontWeight: 500,
        fontVariantNumeric: 'tabular-nums'
      }}>
        {value}
      </div>
      {change && (
        <div style={{ 
          fontFamily: FONT_MONO, 
          fontSize: 12, 
          color, 
          marginTop: 2,
          fontVariantNumeric: 'tabular-nums'
        }}>
          {change}
        </div>
      )}
    </div>
  );
}

function SectionTitle({ children, eyebrow }) {
  return (
    <div style={{ marginBottom: 16 }}>
      {eyebrow && (
        <div style={{ 
          fontFamily: FONT_MONO, 
          fontSize: 10, 
          color: C.brass, 
          textTransform: 'uppercase', 
          letterSpacing: 2,
          marginBottom: 6
        }}>
          {eyebrow}
        </div>
      )}
      <div style={{ 
        fontFamily: FONT_DISPLAY, 
        fontSize: 22, 
        color: C.text, 
        fontWeight: 500,
        letterSpacing: -0.3
      }}>
        {children}
      </div>
    </div>
  );
}

function Button({ children, onClick, disabled, variant = 'primary', size = 'md', style }) {
  const styles = {
    primary: {
      background: C.brass,
      color: C.bg,
      border: `1px solid ${C.brass}`,
    },
    secondary: {
      background: 'transparent',
      color: C.text,
      border: `1px solid ${C.border}`,
    },
    ghost: {
      background: 'transparent',
      color: C.textMute,
      border: 'none',
    }
  };
  const sizes = {
    sm: { padding: '6px 12px', fontSize: 12 },
    md: { padding: '10px 18px', fontSize: 13 },
    lg: { padding: '14px 24px', fontSize: 14 },
  };
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        ...styles[variant],
        ...sizes[size],
        fontFamily: FONT_BODY,
        fontWeight: 500,
        letterSpacing: 0.3,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        borderRadius: 3,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        transition: 'all 0.15s',
        ...style
      }}
    >
      {children}
    </button>
  );
}

function LoadingIndicator({ text }) {
  return (
    <div style={{ 
      display: 'flex', 
      flexDirection: 'column', 
      alignItems: 'center', 
      justifyContent: 'center', 
      padding: '60px 20px',
      gap: 16
    }}>
      <Loader2 size={28} color={C.brass} style={{ animation: 'spin 1s linear infinite' }} />
      <div style={{ fontFamily: FONT_MONO, fontSize: 11, color: C.textMute, letterSpacing: 1 }}>
        {text}
      </div>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

function ErrorBanner({ error, onDismiss }) {
  if (!error) return null;
  return (
    <div style={{
      background: 'rgba(208, 110, 93, 0.1)',
      border: `1px solid ${C.neg}`,
      borderRadius: 3,
      padding: '10px 14px',
      display: 'flex',
      alignItems: 'flex-start',
      gap: 10,
      marginBottom: 16,
      fontFamily: FONT_BODY,
      fontSize: 13,
      color: C.neg
    }}>
      <AlertCircle size={16} style={{ flexShrink: 0, marginTop: 1 }} />
      <div style={{ flex: 1 }}>{error}</div>
      {onDismiss && (
        <X size={16} onClick={onDismiss} style={{ cursor: 'pointer', opacity: 0.7 }} />
      )}
    </div>
  );
}

// ============================================================
// TAB 1: DAILY BRIEF
// ============================================================
function DailyBrief() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [timestamp, setTimestamp] = useState(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    (async () => {
      const cached = await storageGet('lastBrief');
      if (cached) {
        setData(cached.data);
        setTimestamp(cached.timestamp);
      }
    })();
  }, []);

  const generate = async () => {
    setLoading(true);
    setError(null);
    try {
      const today = new Date().toLocaleDateString('en-IN', {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
      });
      const prompt = `You are an institutional investment research analyst. Generate a comprehensive Indian markets daily brief for TODAY (${today}). 

Use web search extensively to get LIVE current data. Search for: Nifty Sensex today, FII DII activity today, US markets close, RBI repo rate, USD INR, crude oil, top news India markets today.

Return ONLY valid JSON, no preamble, no markdown fences. Schema:
{
  "date": "human readable date",
  "summary": "2-sentence market pulse summary",
  "indices": [
    {"name": "Nifty 50", "value": "24,000", "changePct": "+0.5%", "change": "+120"},
    {"name": "Sensex", "value": "78,500", "changePct": "+0.6%", "change": "+450"},
    {"name": "India VIX", "value": "13.2", "changePct": "-2.7%", "change": "-0.4"},
    {"name": "Bank Nifty", "value": "...", "changePct": "...", "change": "..."}
  ],
  "sectors": {
    "winners": [{"name": "Nifty FMCG", "changePct": "+1.5%"}],
    "losers": [{"name": "Nifty IT", "changePct": "-0.6%"}]
  },
  "flows": {
    "fii": "-1,140 Cr",
    "dii": "+3,159 Cr",
    "date": "Jul 01",
    "interpretation": "DII absorbing FII selling"
  },
  "global": [
    {"name": "Dow Jones", "value": "52,319", "changePct": "+0.26%"},
    {"name": "S&P 500", "value": "7,449", "changePct": "+0.79%"},
    {"name": "Nasdaq", "value": "26,213", "changePct": "+1.52%"}
  ],
  "macro": {
    "repoRate": "5.25%",
    "cpi": "3.94%",
    "usdInr": "94.68",
    "crude": "$73.24"
  },
  "news": [
    {"headline": "...", "impact": "positive|negative|neutral", "summary": "1-sentence why it matters"}
  ],
  "watchlist": ["3-5 specific things to track today"],
  "focusStocks": [
    {"ticker": "TICKER", "name": "Full Name", "change": "+2.5%", "reason": "brief catalyst"}
  ]
}

Include 3-5 news items, 3-5 watchlist items, 3-5 focus stocks. All numbers from live search. If a specific field is unavailable, use "unavailable" — do not fabricate.`;

      const text = await callClaude(prompt, { maxTokens: 3000 });
      const parsed = extractJSON(text);
      const ts = Date.now();
      setData(parsed);
      setTimestamp(ts);
      await storageSet('lastBrief', { data: parsed, timestamp: ts });
    } catch (e) {
      setError(e.message);
    }
    setLoading(false);
  };

  const copyMarkdown = () => {
    if (!data) return;
    const md = briefToMarkdown(data, timestamp);
    navigator.clipboard.writeText(md);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const download = () => {
    if (!data) return;
    const md = briefToMarkdown(data, timestamp);
    const blob = new Blob([md], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `brief_${new Date().toISOString().split('T')[0]}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20, flexWrap: 'wrap', gap: 12 }}>
        <div>
          <SectionTitle eyebrow="Module 01 — Morning Report">Daily Brief</SectionTitle>
          {timestamp && (
            <div style={{ fontFamily: FONT_MONO, fontSize: 11, color: C.textDim, marginTop: 4 }}>
              <Clock size={11} style={{ display: 'inline', marginRight: 4, verticalAlign: -1 }} />
              Generated {new Date(timestamp).toLocaleString('en-IN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: 'short' })}
            </div>
          )}
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {data && (
            <>
              <Button variant="secondary" size="sm" onClick={copyMarkdown}>
                {copied ? <><Check size={14} /> Copied</> : <><Copy size={14} /> Copy</>}
              </Button>
              <Button variant="secondary" size="sm" onClick={download}>
                <Download size={14} /> Export
              </Button>
            </>
          )}
          <Button onClick={generate} disabled={loading}>
            {loading ? <><Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> Fetching...</> : <><Zap size={14} /> Generate Fresh</>}
          </Button>
        </div>
      </div>

      <ErrorBanner error={error} onDismiss={() => setError(null)} />

      {loading && <LoadingIndicator text="Searching live markets, flows, macro data..." />}

      {!loading && !data && (
        <Card style={{ textAlign: 'center', padding: '60px 20px' }}>
          <div style={{ fontFamily: FONT_DISPLAY, fontSize: 18, color: C.textMute, marginBottom: 8 }}>
            No brief yet
          </div>
          <div style={{ fontFamily: FONT_BODY, fontSize: 13, color: C.textDim, marginBottom: 20 }}>
            Tap "Generate Fresh" — takes ~45-60 seconds with live search.
          </div>
        </Card>
      )}

      {!loading && data && <BriefContent data={data} />}
    </div>
  );
}

function BriefContent({ data }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Summary strip */}
      {data.summary && (
        <div style={{ 
          fontFamily: FONT_DISPLAY, 
          fontSize: 17, 
          lineHeight: 1.5, 
          color: C.text,
          fontStyle: 'italic',
          borderLeft: `2px solid ${C.brass}`,
          paddingLeft: 16,
          margin: '4px 0 8px'
        }}>
          {data.summary}
        </div>
      )}

      {/* Indices row */}
      {data.indices && (
        <Card>
          <div style={{ fontFamily: FONT_MONO, fontSize: 10, color: C.brass, letterSpacing: 2, marginBottom: 14 }}>
            INDIA MARKETS
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 20 }}>
            {data.indices.map((idx, i) => (
              <Metric key={i} label={idx.name} value={idx.value} change={idx.changePct} />
            ))}
          </div>
        </Card>
      )}

      {/* Sectors + Flows two-column on wide */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 16 }}>
        {data.sectors && (
          <Card>
            <div style={{ fontFamily: FONT_MONO, fontSize: 10, color: C.brass, letterSpacing: 2, marginBottom: 14 }}>
              SECTOR ROTATION
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
              <div>
                <div style={{ fontFamily: FONT_BODY, fontSize: 11, color: C.pos, marginBottom: 8, textTransform: 'uppercase', letterSpacing: 1 }}>
                  Winners
                </div>
                {data.sectors.winners?.map((s, i) => (
                  <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', fontSize: 13, fontFamily: FONT_BODY }}>
                    <span style={{ color: C.text }}>{s.name}</span>
                    <span style={{ color: C.pos, fontFamily: FONT_MONO }}>{s.changePct}</span>
                  </div>
                ))}
              </div>
              <div>
                <div style={{ fontFamily: FONT_BODY, fontSize: 11, color: C.neg, marginBottom: 8, textTransform: 'uppercase', letterSpacing: 1 }}>
                  Losers
                </div>
                {data.sectors.losers?.map((s, i) => (
                  <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', fontSize: 13, fontFamily: FONT_BODY }}>
                    <span style={{ color: C.text }}>{s.name}</span>
                    <span style={{ color: C.neg, fontFamily: FONT_MONO }}>{s.changePct}</span>
                  </div>
                ))}
              </div>
            </div>
          </Card>
        )}

        {data.flows && (
          <Card>
            <div style={{ fontFamily: FONT_MONO, fontSize: 10, color: C.brass, letterSpacing: 2, marginBottom: 14 }}>
              INSTITUTIONAL FLOWS · {data.flows.date}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, marginBottom: 12 }}>
              <Metric label="FII Cash" value={data.flows.fii} size="sm" />
              <Metric label="DII Cash" value={data.flows.dii} size="sm" />
            </div>
            {data.flows.interpretation && (
              <div style={{ fontFamily: FONT_BODY, fontSize: 12, color: C.textMute, fontStyle: 'italic', lineHeight: 1.5, paddingTop: 12, borderTop: `1px solid ${C.border}` }}>
                {data.flows.interpretation}
              </div>
            )}
          </Card>
        )}
      </div>

      {/* Global cues */}
      {data.global && (
        <Card>
          <div style={{ fontFamily: FONT_MONO, fontSize: 10, color: C.brass, letterSpacing: 2, marginBottom: 14 }}>
            GLOBAL CUES · OVERNIGHT
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 16 }}>
            {data.global.map((g, i) => (
              <Metric key={i} label={g.name} value={g.value} change={g.changePct} size="sm" />
            ))}
          </div>
        </Card>
      )}

      {/* Macro */}
      {data.macro && (
        <Card>
          <div style={{ fontFamily: FONT_MONO, fontSize: 10, color: C.brass, letterSpacing: 2, marginBottom: 14 }}>
            MACRO DASHBOARD
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 16 }}>
            <Metric label="Repo Rate" value={data.macro.repoRate} size="sm" />
            <Metric label="CPI" value={data.macro.cpi} size="sm" />
            <Metric label="USD/INR" value={data.macro.usdInr} size="sm" />
            <Metric label="Crude" value={data.macro.crude} size="sm" />
          </div>
        </Card>
      )}

      {/* News */}
      {data.news && data.news.length > 0 && (
        <Card>
          <div style={{ fontFamily: FONT_MONO, fontSize: 10, color: C.brass, letterSpacing: 2, marginBottom: 14 }}>
            NEWS DRIVING MARKETS
          </div>
          {data.news.map((n, i) => (
            <div key={i} style={{ 
              padding: '12px 0', 
              borderBottom: i < data.news.length - 1 ? `1px solid ${C.border}` : 'none' 
            }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                <div style={{
                  width: 3,
                  height: 3,
                  borderRadius: '50%',
                  background: n.impact === 'positive' ? C.pos : n.impact === 'negative' ? C.neg : C.info,
                  marginTop: 8,
                  flexShrink: 0
                }} />
                <div style={{ flex: 1 }}>
                  <div style={{ fontFamily: FONT_BODY, fontSize: 14, color: C.text, marginBottom: 4, fontWeight: 500 }}>
                    {n.headline}
                  </div>
                  <div style={{ fontFamily: FONT_BODY, fontSize: 12, color: C.textMute, lineHeight: 1.5 }}>
                    {n.summary}
                  </div>
                </div>
              </div>
            </div>
          ))}
        </Card>
      )}

      {/* Focus Stocks */}
      {data.focusStocks && data.focusStocks.length > 0 && (
        <Card>
          <div style={{ fontFamily: FONT_MONO, fontSize: 10, color: C.brass, letterSpacing: 2, marginBottom: 14 }}>
            STOCKS IN FOCUS
          </div>
          {data.focusStocks.map((s, i) => (
            <div key={i} style={{ 
              padding: '12px 0', 
              borderBottom: i < data.focusStocks.length - 1 ? `1px solid ${C.border}` : 'none',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'flex-start',
              gap: 12
            }}>
              <div style={{ flex: 1 }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', marginBottom: 4 }}>
                  <span style={{ fontFamily: FONT_MONO, fontSize: 13, color: C.text, fontWeight: 600 }}>
                    {s.ticker}
                  </span>
                  <span style={{ fontFamily: FONT_BODY, fontSize: 12, color: C.textMute }}>
                    {s.name}
                  </span>
                </div>
                <div style={{ fontFamily: FONT_BODY, fontSize: 12, color: C.textMute, lineHeight: 1.5 }}>
                  {s.reason}
                </div>
              </div>
              <div style={{ 
                fontFamily: FONT_MONO, 
                fontSize: 13, 
                color: s.change?.startsWith('-') ? C.neg : C.pos,
                fontVariantNumeric: 'tabular-nums'
              }}>
                {s.change}
              </div>
            </div>
          ))}
        </Card>
      )}

      {/* Watchlist */}
      {data.watchlist && data.watchlist.length > 0 && (
        <Card style={{ borderColor: C.brassDim }}>
          <div style={{ fontFamily: FONT_MONO, fontSize: 10, color: C.brass, letterSpacing: 2, marginBottom: 14 }}>
            WATCH TODAY
          </div>
          {data.watchlist.map((w, i) => (
            <div key={i} style={{ 
              display: 'flex', 
              alignItems: 'flex-start', 
              gap: 10, 
              padding: '8px 0',
              fontFamily: FONT_BODY,
              fontSize: 13,
              color: C.text,
              lineHeight: 1.5
            }}>
              <span style={{ fontFamily: FONT_MONO, color: C.brass, fontSize: 11, marginTop: 3 }}>
                {String(i + 1).padStart(2, '0')}
              </span>
              <span>{w}</span>
            </div>
          ))}
        </Card>
      )}
    </div>
  );
}

function briefToMarkdown(data, timestamp) {
  let md = `# Daily Brief — ${data.date || new Date().toDateString()}\n`;
  md += `_Generated: ${new Date(timestamp).toLocaleString('en-IN')}_\n\n`;
  if (data.summary) md += `> ${data.summary}\n\n`;
  
  if (data.indices) {
    md += `## India Markets\n\n| Index | Value | Change |\n|---|---|---|\n`;
    data.indices.forEach(i => md += `| ${i.name} | ${i.value} | ${i.changePct} |\n`);
    md += `\n`;
  }
  
  if (data.sectors) {
    md += `## Sector Rotation\n\n**Winners:** ${data.sectors.winners?.map(s => `${s.name} (${s.changePct})`).join(', ')}\n\n`;
    md += `**Losers:** ${data.sectors.losers?.map(s => `${s.name} (${s.changePct})`).join(', ')}\n\n`;
  }
  
  if (data.flows) {
    md += `## FII/DII Flows (${data.flows.date})\n\n`;
    md += `- FII Cash: ${data.flows.fii}\n- DII Cash: ${data.flows.dii}\n`;
    if (data.flows.interpretation) md += `\n_${data.flows.interpretation}_\n\n`;
  }
  
  if (data.global) {
    md += `## Global Cues\n\n`;
    data.global.forEach(g => md += `- **${g.name}**: ${g.value} (${g.changePct})\n`);
    md += `\n`;
  }
  
  if (data.macro) {
    md += `## Macro\n\n- Repo Rate: ${data.macro.repoRate}\n- CPI: ${data.macro.cpi}\n- USD/INR: ${data.macro.usdInr}\n- Crude: ${data.macro.crude}\n\n`;
  }
  
  if (data.news) {
    md += `## News\n\n`;
    data.news.forEach(n => md += `- **${n.headline}** — ${n.summary}\n`);
    md += `\n`;
  }
  
  if (data.focusStocks) {
    md += `## Stocks in Focus\n\n`;
    data.focusStocks.forEach(s => md += `- **${s.ticker}** (${s.change}) — ${s.reason}\n`);
    md += `\n`;
  }
  
  if (data.watchlist) {
    md += `## Watch Today\n\n`;
    data.watchlist.forEach((w, i) => md += `${i + 1}. ${w}\n`);
  }
  
  return md;
}

// ============================================================
// TAB 2: STOCK DEEP-DIVE
// ============================================================
const PICK_CATEGORIES = [
  { id: 'largecap', label: 'Large Cap', prompt: 'Nifty 50 large-cap Indian stocks looking attractive right now' },
  { id: 'midcap',   label: 'Mid Cap',   prompt: 'Nifty Midcap 150 stocks showing bullish setup today' },
  { id: 'momentum', label: 'Momentum',  prompt: 'Indian stocks with strong price/volume momentum in the last week' },
  { id: 'value',    label: 'Value',     prompt: 'Indian stocks trading below intrinsic value, low P/E, strong balance sheet' },
  { id: 'it',       label: 'IT',        prompt: 'Nifty IT sector leaders with bullish setup' },
  { id: 'bank',     label: 'Bank',      prompt: 'Bank Nifty component stocks best positioned today' },
  { id: 'auto',     label: 'Auto',      prompt: 'Nifty Auto sector stocks with strong outlook' },
  { id: 'pharma',   label: 'Pharma',    prompt: 'Indian pharma sector stocks with strong recent results' },
];

function reasonFor(category, changePct) {
  const pct = Number(changePct);
  if (!Number.isFinite(pct)) return `${categoryLabel(category)} · price loading`;
  const strong = Math.abs(pct) > 2;
  const dir = pct >= 0 ? 'up' : 'down';
  if (category === 'value')      return pct < 0 ? `Underperformer — potential mean-reversion setup` : `Recovering from prior weakness`;
  if (category === 'momentum')   return strong ? `Strong ${dir}side momentum today` : `Moderate ${dir}side move today`;
  if (category === 'largecap')   return `Nifty 50 member · ${dir} ${Math.abs(pct).toFixed(1)}% today`;
  if (category === 'midcap')     return `Nifty Midcap 150 · ${dir} ${Math.abs(pct).toFixed(1)}% today`;
  return `${categoryLabel(category)} sector · ${dir} ${Math.abs(pct).toFixed(1)}% today`;
}
function categoryLabel(id) {
  const c = (typeof PICK_CATEGORIES !== 'undefined' ? PICK_CATEGORIES : []).find(x => x.id === id);
  return c ? c.label : id;
}

function TodaysPicks({ onPick }) {
  const [category, setCategory] = useState('largecap');
  const [picks, setPicks] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [dateLabel, setDateLabel] = useState('');

  const today = new Date().toISOString().slice(0, 10);
  const cacheKey = `picks_${category}_${today}`;

  useEffect(() => {
    (async () => {
      const cached = await storageGet(cacheKey);
      if (cached) {
        setPicks(cached.picks);
        setDateLabel(cached.dateLabel || '');
      } else {
        setPicks(null);
        setDateLabel('');
      }
      setError(null);
    })();
  }, [category, cacheKey]);

  const fetchPicks = async () => {
    setLoading(true);
    setError(null);
    try {
      const todayLong = new Date().toLocaleDateString('en-IN', { weekday: 'long', day: '2-digit', month: 'short', year: 'numeric' });
      const universe = SECTOR_TICKERS[category] || SECTOR_TICKERS.largecap;
      // Fetch real quotes in parallel — ~1s total
      const quotes = await getBatchQuotes(universe.map(u => u.ticker));
      const enriched = quotes
        .filter(q => !q.failed && q.price != null)
        .map((q, i) => {
          const seed = universe.find(u => u.ticker === q.ticker) || {};
          return {
            ticker: q.ticker,
            name: seed.name || q.name,
            priceNum: q.price,
            price: formatPrice(q.price, q.currency),
            change: formatChangePct(q.changePct),
            changePctNum: q.changePct,
            reason: reasonFor(category, q.changePct),
          };
        });

      // Sort by category logic
      if (category === 'value') {
        // "Value" — proxy: worst 1-year performers among large caps (mean reversion candidates)
        enriched.sort((a, b) => (a.changePctNum ?? 0) - (b.changePctNum ?? 0));
      } else {
        // All others — top day movers
        enriched.sort((a, b) => (b.changePctNum ?? -999) - (a.changePctNum ?? -999));
      }
      const top6 = enriched.slice(0, 6);
      if (top6.length === 0) throw new Error('No live quotes available. Check dev server proxy or network.');

      const next = { picks: top6, dateLabel: todayLong };
      setPicks(next.picks);
      setDateLabel(next.dateLabel);
      await storageSet(cacheKey, next);
    } catch (e) {
      setError(e.message);
    }
    setLoading(false);
  };

  return (
    <Card style={{ marginBottom: 20 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 14, flexWrap: 'wrap', gap: 12 }}>
        <div>
          <div style={{ fontFamily: FONT_MONO, fontSize: 10, color: C.brass, letterSpacing: 2 }}>
            TODAY'S PICKS
          </div>
          <div style={{ fontFamily: FONT_MONO, fontSize: 9, color: C.textDim, letterSpacing: 1, marginTop: 4 }}>
            {dateLabel ? `Cached · ${dateLabel}` : 'Pick a category and fetch live suggestions'}
          </div>
        </div>
        <Button onClick={fetchPicks} disabled={loading}>
          {loading
            ? <><Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> Fetching</>
            : <><RefreshCw size={13} /> {picks ? 'Refresh' : 'Fetch Picks'}</>}
        </Button>
      </div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 16, flexWrap: 'wrap' }}>
        {PICK_CATEGORIES.map(c => {
          const active = category === c.id;
          return (
            <button
              key={c.id}
              onClick={() => setCategory(c.id)}
              style={{
                padding: '6px 12px',
                background: active ? C.brass : 'transparent',
                color: active ? C.bg : C.textMute,
                border: `1px solid ${active ? C.brass : C.border}`,
                borderRadius: 3,
                fontFamily: FONT_MONO,
                fontSize: 11,
                letterSpacing: 1,
                cursor: 'pointer',
                fontWeight: 500,
              }}
            >
              {c.label}
            </button>
          );
        })}
      </div>
      <ErrorBanner error={error} onDismiss={() => setError(null)} />
      {loading && !picks && (
        <div style={{ padding: 30, textAlign: 'center', fontFamily: FONT_MONO, fontSize: 11, color: C.textDim, letterSpacing: 1 }}>
          Fetching live picks — 15–30 sec...
        </div>
      )}
      {picks && picks.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))', gap: 10 }}>
          {picks.map((p, i) => {
            const isNeg = String(p.change || '').trim().startsWith('-');
            return (
              <button
                key={i}
                onClick={() => onPick(p.ticker)}
                style={{
                  textAlign: 'left',
                  background: C.bg,
                  border: `1px solid ${C.border}`,
                  borderRadius: 4,
                  padding: 14,
                  cursor: 'pointer',
                  fontFamily: FONT_BODY,
                  color: C.text,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 6,
                  transition: 'border-color 0.15s',
                }}
                onMouseEnter={e => { e.currentTarget.style.borderColor = C.brass; }}
                onMouseLeave={e => { e.currentTarget.style.borderColor = C.border; }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
                  <div style={{ fontFamily: FONT_MONO, fontSize: 12, color: C.brass, letterSpacing: 1, fontWeight: 600 }}>
                    {p.ticker}
                  </div>
                  <div style={{ fontFamily: FONT_MONO, fontSize: 11, color: isNeg ? C.neg : C.pos, fontVariantNumeric: 'tabular-nums' }}>
                    {p.change}
                  </div>
                </div>
                <div style={{ fontSize: 13, color: C.text, fontWeight: 500 }}>{p.name}</div>
                <div style={{ fontFamily: FONT_MONO, fontSize: 12, color: C.textMute, fontVariantNumeric: 'tabular-nums' }}>
                  {p.price}
                </div>
                <div style={{ fontSize: 11, color: C.textMute, lineHeight: 1.4, marginTop: 2 }}>
                  {p.reason}
                </div>
              </button>
            );
          })}
        </div>
      )}
    </Card>
  );
}

function StockDeepDive() {
  const [ticker, setTicker] = useState('');
  const [horizon, setHorizon] = useState('3Y');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [journalNote, setJournalNote] = useState(null); // "loaded 3 prior calls" / "saved"

  const analyze = async (overrideTicker) => {
    const t = (overrideTicker || ticker).trim();
    if (!t) {
      setError('Enter a ticker or company name');
      return;
    }
    if (overrideTicker) setTicker(overrideTicker);
    setLoading(true);
    setError(null);
    setData(null);
    setJournalNote(null);

    // Phase 1 — fetch market data + past-analysis memory in parallel. Fast (~1s).
    let market = null;
    let memoryBlock = '';
    const priorPromise = journalReady() ? Promise.all([
      listForTicker(t.toUpperCase(), 5),
      listRecentMisses(5),
    ]).catch(() => [[], []]) : Promise.resolve([[], []]);

    try {
      const [quote, history] = await Promise.all([
        getQuote(t),
        getHistory(t, '5y', '1mo'),
      ]);
      const returns = computeReturns(history);
      const priceHistory = history.slice(-24).map(p => Number(p.close.toFixed(2)));
      market = { quote, history, returns, priceHistory };

      // Progressive render — show the chart + returns immediately while the LLM works.
      setData({
        ticker: t.toUpperCase(),
        companyName: quote.name,
        currentPrice: formatPrice(quote.price, quote.currency),
        dayChange: formatChangePct(quote.changePct),
        horizon,
        returns,
        priceHistory,
      });
    } catch (e) {
      console.warn('Yahoo market data unavailable:', e.message);
    }

    // Await the journal lookup (it ran in parallel with Yahoo).
    const [priorTicker, globalMisses] = await priorPromise;
    memoryBlock = formatMemoryForPrompt(priorTicker, globalMisses);
    if (priorTicker.length || globalMisses.length) {
      setJournalNote(`Loaded ${priorTicker.length} prior ${priorTicker.length === 1 ? 'call' : 'calls'} for ${t.toUpperCase()}${globalMisses.length ? ` + ${globalMisses.length} global misses` : ''} as context.`);
    }

    // Phase 2 — LLM analysis (bull/bear/recommendation). Slower (~15s).
    try {
      const ctxLines = market ? [
        `Live market data (verified, do NOT re-search prices):`,
        `- Company: ${market.quote.name}`,
        `- Current price: ${market.quote.currency || 'INR'} ${market.quote.price?.toFixed(2)}`,
        `- Day change: ${market.quote.changePct?.toFixed(2)}%`,
        `- 1M: ${market.returns?.['1M'] || 'n/a'}, 1Y: ${market.returns?.['1Y'] || 'n/a'}, 5Y: ${market.returns?.['5Y'] || 'n/a'}`,
      ].join('\n') : '';

      const prompt = `You are an equity analyst. ${horizon} outlook for ${t.toUpperCase()}.

${ctxLines}
${memoryBlock}
Use web search for: recent quarterly results, analyst consensus, promoter/FII holding, upcoming catalysts, peer valuations. Do NOT re-fetch prices — use the live numbers above.

Return ONLY valid JSON, no fences:
{
  "sector": "sector name",
  "marketCap": "e.g. Rs 5.2L Cr",
  "recommendation": "BUY|HOLD|WATCH|AVOID",
  "confidence": "0-100",
  "risk": "Low|Medium|High",
  "fairValue": "target price with currency",
  "upside": "percent upside",
  "expectedCAGR": "annualized return expectation",
  "summary": "3-sentence investment thesis",
  "fundamentals": {"revenueGrowth":"","profitGrowth":"","roe":"","roce":"","debtToEquity":"","pe":"","pb":"","dividendYield":"","promoterHolding":"","fiiHolding":""},
  "bullCase": ["3 drivers"],
  "bearCase": ["3 risks"],
  "catalysts": ["2-3 upcoming events"],
  "peers": [{"name":"","pe":"","roe":""}],
  "entryStrategy": "how to build a position",
  "buyRange": "ideal accumulation range",
  "scores": {"fundamental":"0-10","technical":"0-10","sentiment":"0-10","overall":"0-10"},
  "reasoning": {
    "considered": ["what data / signals I evaluated"],
    "couldntVerify": ["what I could not confirm"],
    "assumptions": ["explicit assumptions made"],
    "changesFromPrior": "if past calls exist, what changed and why (or 'no change')"
  }
}

Be specific. Use "unavailable" if a datapoint can't be verified. Never fabricate. Do NOT include priceHistory or returns fields — those are already sourced from live data. If prior calls are in memory above, reference them explicitly in reasoning.changesFromPrior.`;

      const text = await callClaude(prompt, { maxTokens: 2800 });
      const parsed = extractJSON(text);

      // Merge live market data on top so the LLM can't override it
      const merged = { ...parsed, ticker: t.toUpperCase(), horizon };
      if (market) {
        merged.companyName  = market.quote.name || parsed.companyName;
        merged.currentPrice = formatPrice(market.quote.price, market.quote.currency);
        merged.dayChange    = formatChangePct(market.quote.changePct);
        merged.priceHistory = market.priceHistory;
        merged.returns      = market.returns;
      }
      setData(merged);

      // Persist to journal (fire-and-forget — never blocks UX)
      if (journalReady()) {
        saveAnalysis({
          ticker: t.toUpperCase(),
          companyName: merged.companyName,
          provider: getProvider(),
          horizon,
          priceAtAnalysis: market?.quote?.price,
          currency: market?.quote?.currency || 'INR',
          recommendation: merged.recommendation,
          confidence: merged.confidence,
          risk: merged.risk,
          fairValue: merged.fairValue,
          buyRange: merged.buyRange,
          summary: merged.summary,
          reasoning: merged.reasoning,
          bullCase: merged.bullCase,
          bearCase: merged.bearCase,
          fullData: parsed,
        }).then(res => {
          if (res.ok) setJournalNote('Saved to journal.');
          else console.warn('Journal save failed:', res.reason);
        });
      }
    } catch (e) {
      if (market) {
        setError(`Analysis unavailable: ${e.message}. Chart & returns are still live above.`);
      } else {
        setError(e.message);
      }
    }
    setLoading(false);
  };

  return (
    <div>
      <SectionTitle eyebrow="Module 02 — Equity Research">Stock Deep-Dive</SectionTitle>

      <TodaysPicks onPick={(t) => analyze(t)} />

      <Card style={{ marginBottom: 20 }}>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div style={{ flex: '1 1 200px' }}>
            <div style={{ fontFamily: FONT_MONO, fontSize: 10, color: C.textDim, marginBottom: 6, letterSpacing: 1.5 }}>
              TICKER OR NAME
            </div>
            <input
              value={ticker}
              onChange={e => setTicker(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && analyze()}
              placeholder="e.g. HDFCBANK, TCS, Zomato"
              style={{
                width: '100%',
                background: C.bg,
                border: `1px solid ${C.border}`,
                borderRadius: 3,
                padding: '10px 12px',
                fontFamily: FONT_MONO,
                fontSize: 14,
                color: C.text,
                outline: 'none'
              }}
            />
          </div>
          <div>
            <div style={{ fontFamily: FONT_MONO, fontSize: 10, color: C.textDim, marginBottom: 6, letterSpacing: 1.5 }}>
              HORIZON
            </div>
            <div style={{ display: 'flex', gap: 4 }}>
              {['6M', '1Y', '3Y', '5Y', '10Y'].map(h => (
                <button
                  key={h}
                  onClick={() => setHorizon(h)}
                  style={{
                    padding: '10px 12px',
                    background: horizon === h ? C.brass : 'transparent',
                    color: horizon === h ? C.bg : C.textMute,
                    border: `1px solid ${horizon === h ? C.brass : C.border}`,
                    borderRadius: 3,
                    fontFamily: FONT_MONO,
                    fontSize: 12,
                    cursor: 'pointer',
                    fontWeight: 500
                  }}
                >
                  {h}
                </button>
              ))}
            </div>
          </div>
          <Button onClick={() => analyze()} disabled={loading}>
            {loading ? <><Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> Analyzing</> : <><Search size={14} /> Analyze</>}
          </Button>
        </div>
      </Card>

      <ErrorBanner error={error} onDismiss={() => setError(null)} />

      {journalNote && (
        <div style={{
          padding: '10px 14px',
          border: `1px solid ${C.border}`,
          borderRadius: 4,
          background: C.surface2,
          fontFamily: FONT_MONO,
          fontSize: 11,
          color: C.textMute,
          marginBottom: 12,
        }}>
          <span style={{ color: C.brass, letterSpacing: 1.5, marginRight: 8 }}>JOURNAL ·</span>
          {journalNote}
        </div>
      )}

      {loading && !data && <LoadingIndicator text="Fetching live price + chart..." />}

      {data && <StockAnalysisContent data={data} loading={loading} />}
    </div>
  );
}

// Plain-English label for action codes surfaced in Portfolio + Screening.
const PLAIN_ACTION = {
  BUY:      'Buy some',
  ADD:      'Buy more',
  HOLD:     'Keep it',
  WATCH:    'Wait & watch',
  REDUCE:   'Trim it',
  EXIT:     'Sell it',
  AVOID:    'Skip it',
  RESEARCH: 'Look closer',
};
function plainAction(a) { return PLAIN_ACTION[a] || a; }

function laymanVerdict(rec, risk, confidence) {
  // Turn BUY/HOLD/WATCH/AVOID into a sentence a non-expert can act on.
  const conf = parseInt(confidence, 10);
  const riskLower = String(risk || '').toLowerCase();
  const base = {
    BUY:    { headline: 'Yes — consider buying',        body: 'This looks like a reasonable time to start a position. Buy in tranches rather than all at once.' },
    HOLD:   { headline: 'Hold if you own it',           body: 'Already invested? Keep it. If you don\'t own it yet, wait — today\'s price isn\'t a compelling entry.' },
    WATCH:  { headline: 'Wait — don\'t buy today',      body: 'Interesting stock, but not the right moment. Watch for a pullback or a fresh catalyst before entering.' },
    AVOID:  { headline: 'Skip this one',                body: 'Better opportunities elsewhere. The risk-reward isn\'t attractive at current levels.' },
  }[rec];
  if (!base) return { headline: 'Verdict pending', body: 'Analysis is still forming — check back in a moment.' };

  const suffix = [];
  if (rec === 'BUY' && riskLower === 'high') suffix.push('This is a higher-risk name — keep the position size small.');
  if (rec === 'BUY' && riskLower === 'low')  suffix.push('Relatively lower-risk pick within its category.');
  if (!Number.isNaN(conf) && conf < 50)      suffix.push('Confidence is low — the picture is unclear, so wait for more evidence before committing capital.');
  if (!Number.isNaN(conf) && conf >= 80)     suffix.push('The signal is strong.');

  return { headline: base.headline, body: `${base.body}${suffix.length ? ' ' + suffix.join(' ') : ''}` };
}

function StockAnalysisContent({ data, loading }) {
  const recColors = {
    'BUY': C.pos, 'HOLD': C.info, 'WATCH': C.warn, 'AVOID': C.neg
  };
  const recColor = recColors[data.recommendation] || C.textMute;
  const verdict = data.recommendation ? laymanVerdict(data.recommendation, data.risk, data.confidence) : null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Header card */}
      <Card>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 20, flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontFamily: FONT_MONO, fontSize: 11, color: C.brass, letterSpacing: 1.5, marginBottom: 4 }}>
              {data.ticker} · {data.sector}
            </div>
            <div style={{ fontFamily: FONT_DISPLAY, fontSize: 24, color: C.text, fontWeight: 500 }}>
              {data.companyName}
            </div>
          </div>
          {data.recommendation ? (
            <div style={{
              padding: '8px 18px',
              border: `1px solid ${recColor}`,
              borderRadius: 3,
              fontFamily: FONT_MONO,
              fontSize: 13,
              color: recColor,
              letterSpacing: 2,
              fontWeight: 600
            }}>
              {data.recommendation}
            </div>
          ) : loading ? (
            <div style={{
              padding: '8px 18px',
              border: `1px dashed ${C.borderStrong}`,
              borderRadius: 3,
              fontFamily: FONT_MONO,
              fontSize: 11,
              color: C.textMute,
              letterSpacing: 2,
              display: 'flex', alignItems: 'center', gap: 8,
            }}>
              <Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} />
              ANALYZING
            </div>
          ) : null}
        </div>
        {data.summary ? (
          <div style={{
            fontFamily: FONT_DISPLAY,
            fontSize: 15,
            color: C.textMute,
            lineHeight: 1.6,
            marginTop: 16,
            fontStyle: 'italic'
          }}>
            {data.summary}
          </div>
        ) : loading ? (
          <div style={{
            fontFamily: FONT_MONO,
            fontSize: 11,
            color: C.textDim,
            lineHeight: 1.6,
            marginTop: 16,
            letterSpacing: 1,
          }}>
            Live price and chart loaded. Fetching thesis, fundamentals, and peer comparison…
          </div>
        ) : null}
        {data.currentPrice && (
          <div style={{ marginTop: 14, display: 'flex', gap: 18, flexWrap: 'wrap', alignItems: 'baseline' }}>
            <div style={{ fontFamily: FONT_MONO, fontSize: 22, color: C.text, fontVariantNumeric: 'tabular-nums', fontWeight: 500 }}>
              {data.currentPrice}
            </div>
            {data.dayChange && (
              <div style={{
                fontFamily: FONT_MONO,
                fontSize: 13,
                color: String(data.dayChange).trim().startsWith('-') ? C.neg : C.pos,
                fontVariantNumeric: 'tabular-nums',
              }}>
                {data.dayChange} today
              </div>
            )}
          </div>
        )}
      </Card>

      {/* Plain-English verdict — what a non-expert should actually do */}
      {verdict && (
        <Card style={{ borderColor: recColor, borderWidth: 1 }}>
          <div style={{ fontFamily: FONT_MONO, fontSize: 10, color: C.brass, letterSpacing: 2, marginBottom: 10 }}>
            WHAT TO DO
          </div>
          <div style={{
            fontFamily: FONT_DISPLAY,
            fontSize: 22,
            color: recColor,
            fontWeight: 500,
            marginBottom: 10,
            lineHeight: 1.3,
          }}>
            {verdict.headline}
          </div>
          <div style={{
            fontFamily: FONT_BODY,
            fontSize: 14,
            color: C.text,
            lineHeight: 1.6,
          }}>
            {verdict.body}
          </div>
          {(data.buyRange || data.fairValue || data.upside) && (
            <div style={{
              marginTop: 14,
              paddingTop: 14,
              borderTop: `1px solid ${C.border}`,
              display: 'flex',
              gap: 20,
              flexWrap: 'wrap',
              fontFamily: FONT_MONO,
              fontSize: 12,
              color: C.textMute,
            }}>
              {data.buyRange && data.buyRange !== 'unavailable' && (
                <div><span style={{ color: C.textDim }}>Ideal buy price: </span><span style={{ color: C.text }}>{data.buyRange}</span></div>
              )}
              {data.fairValue && data.fairValue !== 'unavailable' && (
                <div><span style={{ color: C.textDim }}>Fair value: </span><span style={{ color: C.text }}>{data.fairValue}</span></div>
              )}
              {data.upside && data.upside !== 'unavailable' && (
                <div><span style={{ color: C.textDim }}>Upside: </span><span style={{ color: C.text }}>{data.upside}</span></div>
              )}
            </div>
          )}
        </Card>
      )}

      {/* Key metrics grid */}
      <Card>
        <div style={{ fontFamily: FONT_MONO, fontSize: 10, color: C.brass, letterSpacing: 2, marginBottom: 14 }}>
          THE NUMBERS
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 20 }}>
          <Metric label="Current Price" value={data.currentPrice} size="sm" />
          <Metric label="Fair Value" value={data.fairValue} size="sm" />
          <Metric label="Upside" value={data.upside} size="sm" />
          <Metric label="Expected CAGR" value={data.expectedCAGR} size="sm" />
          <Metric label="Confidence" value={`${data.confidence}%`} size="sm" />
          <Metric label="Risk" value={data.risk} size="sm" />
        </div>
      </Card>

      {/* Performance — price chart + returns */}
      {(data.priceHistory || data.returns) && (
        <Card>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14, flexWrap: 'wrap', gap: 8 }}>
            <div style={{ fontFamily: FONT_MONO, fontSize: 10, color: C.brass, letterSpacing: 2 }}>
              PERFORMANCE
            </div>
            <div style={{ fontFamily: FONT_MONO, fontSize: 9, color: C.textDim, letterSpacing: 1 }}>
              LAST 12 MONTHS
            </div>
          </div>
          {data.priceHistory && Array.isArray(data.priceHistory) && (
            <div style={{ marginBottom: data.returns ? 18 : 0 }}>
              <Sparkline values={data.priceHistory} height={80} />
            </div>
          )}
          {data.returns && (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <ReturnChip label="1M" value={data.returns['1M']} />
              <ReturnChip label="3M" value={data.returns['3M']} />
              <ReturnChip label="6M" value={data.returns['6M']} />
              <ReturnChip label="1Y" value={data.returns['1Y']} />
              <ReturnChip label="3Y" value={data.returns['3Y']} />
              <ReturnChip label="5Y" value={data.returns['5Y']} />
            </div>
          )}
        </Card>
      )}

      {/* Fundamentals */}
      {data.fundamentals && (
        <Card>
          <div style={{ fontFamily: FONT_MONO, fontSize: 10, color: C.brass, letterSpacing: 2, marginBottom: 14 }}>
            FUNDAMENTALS
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))', gap: 16 }}>
            <Metric label="Revenue Growth" value={data.fundamentals.revenueGrowth} size="sm" />
            <Metric label="Profit Growth" value={data.fundamentals.profitGrowth} size="sm" />
            <Metric label="ROE" value={data.fundamentals.roe} size="sm" />
            <Metric label="ROCE" value={data.fundamentals.roce} size="sm" />
            <Metric label="D/E" value={data.fundamentals.debtToEquity} size="sm" />
            <Metric label="P/E" value={data.fundamentals.pe} size="sm" />
            <Metric label="P/B" value={data.fundamentals.pb} size="sm" />
            <Metric label="Div Yield" value={data.fundamentals.dividendYield} size="sm" />
            <Metric label="Promoter %" value={data.fundamentals.promoterHolding} size="sm" />
            <Metric label="FII %" value={data.fundamentals.fiiHolding} size="sm" />
          </div>
        </Card>
      )}

      {/* Bull / Bear */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 16 }}>
        <Card style={{ borderColor: C.pos, borderLeftWidth: 2 }}>
          <div style={{ fontFamily: FONT_MONO, fontSize: 10, color: C.pos, letterSpacing: 2, marginBottom: 14 }}>
            BULL CASE
          </div>
          {data.bullCase?.map((b, i) => (
            <div key={i} style={{ 
              padding: '8px 0', 
              fontFamily: FONT_BODY, 
              fontSize: 13, 
              color: C.text, 
              lineHeight: 1.5,
              display: 'flex',
              gap: 10,
              alignItems: 'flex-start'
            }}>
              <span style={{ color: C.pos, marginTop: 2 }}>▲</span>
              <span>{b}</span>
            </div>
          ))}
        </Card>
        <Card style={{ borderColor: C.neg, borderLeftWidth: 2 }}>
          <div style={{ fontFamily: FONT_MONO, fontSize: 10, color: C.neg, letterSpacing: 2, marginBottom: 14 }}>
            BEAR CASE
          </div>
          {data.bearCase?.map((b, i) => (
            <div key={i} style={{ 
              padding: '8px 0', 
              fontFamily: FONT_BODY, 
              fontSize: 13, 
              color: C.text, 
              lineHeight: 1.5,
              display: 'flex',
              gap: 10,
              alignItems: 'flex-start'
            }}>
              <span style={{ color: C.neg, marginTop: 2 }}>▼</span>
              <span>{b}</span>
            </div>
          ))}
        </Card>
      </div>

      {/* Entry strategy */}
      {data.entryStrategy && (
        <Card>
          <div style={{ fontFamily: FONT_MONO, fontSize: 10, color: C.brass, letterSpacing: 2, marginBottom: 14 }}>
            ENTRY STRATEGY
          </div>
          <div style={{ fontFamily: FONT_BODY, fontSize: 14, color: C.text, lineHeight: 1.6, marginBottom: 8 }}>
            {data.entryStrategy}
          </div>
          {data.buyRange && (
            <div style={{ fontFamily: FONT_MONO, fontSize: 12, color: C.brass, marginTop: 8 }}>
              Buy range: {data.buyRange}
            </div>
          )}
        </Card>
      )}

      {/* Catalysts */}
      {data.catalysts && data.catalysts.length > 0 && (
        <Card>
          <div style={{ fontFamily: FONT_MONO, fontSize: 10, color: C.brass, letterSpacing: 2, marginBottom: 14 }}>
            CATALYSTS
          </div>
          {data.catalysts.map((c, i) => (
            <div key={i} style={{ 
              padding: '8px 0', 
              fontFamily: FONT_BODY, 
              fontSize: 13, 
              color: C.text,
              display: 'flex',
              gap: 10,
              alignItems: 'flex-start',
              borderBottom: i < data.catalysts.length - 1 ? `1px solid ${C.border}` : 'none'
            }}>
              <ChevronRight size={14} color={C.brass} style={{ marginTop: 3, flexShrink: 0 }} />
              <span>{c}</span>
            </div>
          ))}
        </Card>
      )}

      {/* Peers */}
      {data.peers && data.peers.length > 0 && (
        <Card>
          <div style={{ fontFamily: FONT_MONO, fontSize: 10, color: C.brass, letterSpacing: 2, marginBottom: 14 }}>
            PEER COMPARISON
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: FONT_MONO, fontSize: 12 }}>
            <thead>
              <tr style={{ borderBottom: `1px solid ${C.border}` }}>
                <th style={{ textAlign: 'left', padding: '8px 0', color: C.textDim, fontWeight: 400, fontSize: 10, letterSpacing: 1 }}>NAME</th>
                <th style={{ textAlign: 'right', padding: '8px 0', color: C.textDim, fontWeight: 400, fontSize: 10, letterSpacing: 1 }}>P/E</th>
                <th style={{ textAlign: 'right', padding: '8px 0', color: C.textDim, fontWeight: 400, fontSize: 10, letterSpacing: 1 }}>ROE</th>
              </tr>
            </thead>
            <tbody>
              {data.peers.map((p, i) => (
                <tr key={i} style={{ borderBottom: `1px solid ${C.border}` }}>
                  <td style={{ padding: '10px 0', color: C.text }}>{p.name}</td>
                  <td style={{ padding: '10px 0', textAlign: 'right', color: C.textMute }}>{p.pe}</td>
                  <td style={{ padding: '10px 0', textAlign: 'right', color: C.textMute }}>{p.roe}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {/* Scores */}
      {data.scores && (
        <Card>
          <div style={{ fontFamily: FONT_MONO, fontSize: 10, color: C.brass, letterSpacing: 2, marginBottom: 14 }}>
            SCORECARD
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(100px, 1fr))', gap: 16 }}>
            <ScoreBar label="Fundamental" score={data.scores.fundamental} />
            <ScoreBar label="Technical" score={data.scores.technical} />
            <ScoreBar label="Sentiment" score={data.scores.sentiment} />
            <ScoreBar label="Overall" score={data.scores.overall} highlight />
          </div>
        </Card>
      )}

      {/* Reasoning trace — what the model considered, couldn't verify, assumed */}
      {data.reasoning && (data.reasoning.considered || data.reasoning.couldntVerify || data.reasoning.assumptions || data.reasoning.changesFromPrior) && (
        <Card>
          <div style={{ fontFamily: FONT_MONO, fontSize: 10, color: C.brass, letterSpacing: 2, marginBottom: 14 }}>
            REASONING TRACE
          </div>
          <div style={{ display: 'grid', gap: 14 }}>
            {data.reasoning.changesFromPrior && data.reasoning.changesFromPrior !== 'no change' && (
              <div>
                <div style={{ fontFamily: FONT_MONO, fontSize: 9, color: C.warn, letterSpacing: 1.5, marginBottom: 4 }}>
                  CHANGES FROM PRIOR CALLS
                </div>
                <div style={{ fontFamily: FONT_BODY, fontSize: 13, color: C.text, lineHeight: 1.5 }}>
                  {data.reasoning.changesFromPrior}
                </div>
              </div>
            )}
            {Array.isArray(data.reasoning.considered) && data.reasoning.considered.length > 0 && (
              <div>
                <div style={{ fontFamily: FONT_MONO, fontSize: 9, color: C.info, letterSpacing: 1.5, marginBottom: 4 }}>
                  WHAT I CONSIDERED
                </div>
                {data.reasoning.considered.map((x, i) => (
                  <div key={i} style={{ fontFamily: FONT_BODY, fontSize: 12, color: C.textMute, lineHeight: 1.5, marginBottom: 2 }}>· {x}</div>
                ))}
              </div>
            )}
            {Array.isArray(data.reasoning.couldntVerify) && data.reasoning.couldntVerify.length > 0 && (
              <div>
                <div style={{ fontFamily: FONT_MONO, fontSize: 9, color: C.neg, letterSpacing: 1.5, marginBottom: 4 }}>
                  COULDN'T VERIFY
                </div>
                {data.reasoning.couldntVerify.map((x, i) => (
                  <div key={i} style={{ fontFamily: FONT_BODY, fontSize: 12, color: C.textMute, lineHeight: 1.5, marginBottom: 2 }}>· {x}</div>
                ))}
              </div>
            )}
            {Array.isArray(data.reasoning.assumptions) && data.reasoning.assumptions.length > 0 && (
              <div>
                <div style={{ fontFamily: FONT_MONO, fontSize: 9, color: C.brass, letterSpacing: 1.5, marginBottom: 4 }}>
                  ASSUMPTIONS
                </div>
                {data.reasoning.assumptions.map((x, i) => (
                  <div key={i} style={{ fontFamily: FONT_BODY, fontSize: 12, color: C.textMute, lineHeight: 1.5, marginBottom: 2 }}>· {x}</div>
                ))}
              </div>
            )}
          </div>
        </Card>
      )}

      <div style={{
        padding: 12,
        background: 'rgba(212, 176, 72, 0.06)',
        border: `1px solid ${C.brassDim}`,
        borderRadius: 3,
        fontFamily: FONT_BODY,
        fontSize: 11,
        color: C.textMute,
        lineHeight: 1.5
      }}>
        Research output for informational purposes. Not personalized advice from a SEBI-registered Investment Adviser. Verify data with primary sources before allocating capital.
      </div>
    </div>
  );
}

function Sparkline({ values, height = 60 }) {
  const nums = (values || []).map(v => Number(v)).filter(v => Number.isFinite(v));
  if (nums.length < 2) {
    return (
      <div style={{
        height, display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontFamily: FONT_MONO, fontSize: 10, color: C.textDim, letterSpacing: 1,
      }}>
        chart unavailable
      </div>
    );
  }
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  const range = max - min || 1;
  const w = 400;
  const h = height;
  const step = w / (nums.length - 1);
  const points = nums.map((v, i) => {
    const x = i * step;
    const y = h - ((v - min) / range) * (h - 8) - 4;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const path = 'M ' + points.join(' L ');
  const areaPath = `${path} L ${w},${h} L 0,${h} Z`;
  const last = nums[nums.length - 1];
  const first = nums[0];
  const positive = last >= first;
  const stroke = positive ? C.pos : C.neg;
  const fill = positive ? 'rgba(127, 184, 107, 0.12)' : 'rgba(208, 110, 93, 0.12)';
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ width: '100%', height, display: 'block' }}>
      <path d={areaPath} fill={fill} stroke="none" />
      <path d={path} fill="none" stroke={stroke} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={(nums.length - 1) * step} cy={h - ((last - min) / range) * (h - 8) - 4} r={3} fill={stroke} />
    </svg>
  );
}

function ReturnChip({ label, value }) {
  const raw = String(value || '');
  const num = parseFloat(raw);
  const isNeg = raw.trim().startsWith('-') || num < 0;
  const isUnavail = /unavail/i.test(raw) || !raw;
  const color = isUnavail ? C.textDim : isNeg ? C.neg : C.pos;
  return (
    <div style={{
      padding: '10px 12px',
      background: C.bg,
      border: `1px solid ${C.border}`,
      borderRadius: 3,
      minWidth: 78,
    }}>
      <div style={{ fontFamily: FONT_MONO, fontSize: 9, color: C.textDim, letterSpacing: 1.5, marginBottom: 4 }}>
        {label}
      </div>
      <div style={{ fontFamily: FONT_MONO, fontSize: 13, color, fontVariantNumeric: 'tabular-nums', fontWeight: 500 }}>
        {isUnavail ? '—' : raw}
      </div>
    </div>
  );
}

function ScoreBar({ label, score, highlight }) {
  const n = parseFloat(score) || 0;
  const pct = Math.min(100, Math.max(0, (n / 10) * 100));
  const color = highlight ? C.brass : n >= 7 ? C.pos : n >= 5 ? C.warn : C.neg;
  return (
    <div>
      <div style={{ fontFamily: FONT_MONO, fontSize: 9, color: C.textDim, letterSpacing: 1.5, marginBottom: 4 }}>
        {label.toUpperCase()}
      </div>
      <div style={{ fontFamily: FONT_MONO, fontSize: 20, color: C.text, marginBottom: 6, fontVariantNumeric: 'tabular-nums' }}>
        {score}<span style={{ color: C.textDim, fontSize: 12 }}>/10</span>
      </div>
      <div style={{ height: 3, background: C.border, borderRadius: 1, overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', background: color, transition: 'width 0.5s' }} />
      </div>
    </div>
  );
}

// ============================================================
// TAB 3: PORTFOLIO
// ============================================================
function PortfolioTab() {
  const [holdings, setHoldings] = useState({ stocks: [], funds: [], cash: 0, meta: { risk: 'moderate', horizon: '10' } });
  const [analysis, setAnalysis] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [showAddStock, setShowAddStock] = useState(false);
  const [showAddFund, setShowAddFund] = useState(false);

  useEffect(() => {
    (async () => {
      const stored = await storageGet('portfolio');
      if (stored) setHoldings(stored);
    })();
  }, []);

  const save = async (next) => {
    setHoldings(next);
    await storageSet('portfolio', next);
  };

  const addStock = async (stock) => {
    const next = { ...holdings, stocks: [...holdings.stocks, { ...stock, id: Date.now().toString() }] };
    await save(next);
    setShowAddStock(false);
  };
  const removeStock = async (id) => {
    const next = { ...holdings, stocks: holdings.stocks.filter(s => s.id !== id) };
    await save(next);
  };
  const addFund = async (fund) => {
    const next = { ...holdings, funds: [...holdings.funds, { ...fund, id: Date.now().toString() }] };
    await save(next);
    setShowAddFund(false);
  };
  const removeFund = async (id) => {
    const next = { ...holdings, funds: holdings.funds.filter(f => f.id !== id) };
    await save(next);
  };

  const analyze = async () => {
    if (holdings.stocks.length === 0 && holdings.funds.length === 0) {
      setError('Add at least one holding to analyze');
      return;
    }
    setLoading(true);
    setError(null);
    setAnalysis(null);

    try {
      const holdingsText = `
STOCKS:
${holdings.stocks.map(s => `- ${s.ticker} (${s.name || ''}): ${s.qty} shares @ avg ₹${s.avgCost}`).join('\n')}

MUTUAL FUNDS:
${holdings.funds.map(f => `- ${f.name}: ${f.sipAmount ? `SIP ₹${f.sipAmount}/mo` : ''} ${f.currentValue ? `current value ₹${f.currentValue}` : ''}`).join('\n')}

Cash: ₹${holdings.cash || 0}
Risk profile: ${holdings.meta.risk}
Horizon: ${holdings.meta.horizon} years
`;

      const prompt = `You are a portfolio manager reviewing this Indian investor's portfolio:

${holdingsText}

Use web search to get current prices, sector classifications, and recent performance for these holdings.

Return ONLY valid JSON. Schema:
{
  "summary": "2-3 sentence assessment",
  "totalValue": "estimated current portfolio value",
  "diversification": {
    "score": "0-10",
    "assessment": "one sentence"
  },
  "sectorConcentration": [
    {"sector": "Banking", "percent": "25%", "assessment": "overweight|neutral|underweight"}
  ],
  "assetAllocation": {
    "equity": "60%",
    "debt": "20%",
    "cash": "10%",
    "other": "10%"
  },
  "riskMetrics": {
    "estimatedBeta": "...",
    "concentrationRisk": "Low|Medium|High",
    "geographicRisk": "..."
  },
  "strengths": ["what's working"],
  "concerns": ["specific issues to fix"],
  "rebalancing": [
    {"action": "REDUCE|ADD|EXIT|HOLD", "holding": "name", "reason": "why", "targetAllocation": "..."}
  ],
  "gaps": ["missing exposures — e.g. no international, no small cap"],
  "taxOptimization": ["specific tax-loss harvesting or LTCG suggestions"]
}

Be specific. Reference the actual holdings by name. If a holding is red-flagged (poor governance, weak fundamentals, overvalued), say so.`;

      const text = await callClaude(prompt, { maxTokens: 3000 });
      const parsed = extractJSON(text);
      setAnalysis(parsed);
    } catch (e) {
      setError(e.message);
    }
    setLoading(false);
  };

  return (
    <div>
      <SectionTitle eyebrow="Module 03 — Portfolio Management">Your Portfolio</SectionTitle>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 16, marginBottom: 20 }}>
        {/* Stocks */}
        <Card>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
            <div style={{ fontFamily: FONT_MONO, fontSize: 10, color: C.brass, letterSpacing: 2 }}>
              STOCKS · {holdings.stocks.length}
            </div>
            <Button variant="ghost" size="sm" onClick={() => setShowAddStock(true)}>
              <Plus size={14} /> Add
            </Button>
          </div>
          {holdings.stocks.length === 0 ? (
            <div style={{ fontFamily: FONT_BODY, fontSize: 12, color: C.textDim, padding: '20px 0', textAlign: 'center' }}>
              No stocks added yet
            </div>
          ) : (
            holdings.stocks.map(s => (
              <div key={s.id} style={{ 
                display: 'flex', 
                justifyContent: 'space-between', 
                alignItems: 'center',
                padding: '10px 0',
                borderBottom: `1px solid ${C.border}`,
                fontFamily: FONT_BODY
              }}>
                <div>
                  <div style={{ fontSize: 13, color: C.text, fontFamily: FONT_MONO }}>{s.ticker}</div>
                  <div style={{ fontSize: 11, color: C.textMute, fontFamily: FONT_MONO, marginTop: 2 }}>
                    {s.qty} × ₹{s.avgCost} = ₹{(s.qty * s.avgCost).toLocaleString('en-IN')}
                  </div>
                </div>
                <Trash2 size={14} color={C.textDim} style={{ cursor: 'pointer' }} onClick={() => removeStock(s.id)} />
              </div>
            ))
          )}
        </Card>

        {/* Funds */}
        <Card>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
            <div style={{ fontFamily: FONT_MONO, fontSize: 10, color: C.brass, letterSpacing: 2 }}>
              MUTUAL FUNDS · {holdings.funds.length}
            </div>
            <Button variant="ghost" size="sm" onClick={() => setShowAddFund(true)}>
              <Plus size={14} /> Add
            </Button>
          </div>
          {holdings.funds.length === 0 ? (
            <div style={{ fontFamily: FONT_BODY, fontSize: 12, color: C.textDim, padding: '20px 0', textAlign: 'center' }}>
              No funds added yet
            </div>
          ) : (
            holdings.funds.map(f => (
              <div key={f.id} style={{ 
                display: 'flex', 
                justifyContent: 'space-between', 
                alignItems: 'center',
                padding: '10px 0',
                borderBottom: `1px solid ${C.border}`,
                fontFamily: FONT_BODY
              }}>
                <div>
                  <div style={{ fontSize: 13, color: C.text }}>{f.name}</div>
                  <div style={{ fontSize: 11, color: C.textMute, fontFamily: FONT_MONO, marginTop: 2 }}>
                    {f.sipAmount ? `SIP ₹${f.sipAmount}/mo` : ''} {f.currentValue ? `· ₹${Number(f.currentValue).toLocaleString('en-IN')}` : ''}
                  </div>
                </div>
                <Trash2 size={14} color={C.textDim} style={{ cursor: 'pointer' }} onClick={() => removeFund(f.id)} />
              </div>
            ))
          )}
        </Card>
      </div>

      {/* Meta + Cash */}
      <Card style={{ marginBottom: 20 }}>
        <div style={{ fontFamily: FONT_MONO, fontSize: 10, color: C.brass, letterSpacing: 2, marginBottom: 14 }}>
          CONTEXT
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 16 }}>
          <div>
            <div style={{ fontFamily: FONT_MONO, fontSize: 9, color: C.textDim, letterSpacing: 1.5, marginBottom: 6 }}>
              CASH (₹)
            </div>
            <input
              type="number"
              value={holdings.cash || ''}
              onChange={e => save({ ...holdings, cash: parseFloat(e.target.value) || 0 })}
              style={{
                width: '100%', background: C.bg, border: `1px solid ${C.border}`,
                borderRadius: 3, padding: '8px 10px', color: C.text, fontFamily: FONT_MONO, fontSize: 13, outline: 'none'
              }}
            />
          </div>
          <div>
            <div style={{ fontFamily: FONT_MONO, fontSize: 9, color: C.textDim, letterSpacing: 1.5, marginBottom: 6 }}>
              RISK
            </div>
            <select
              value={holdings.meta.risk}
              onChange={e => save({ ...holdings, meta: { ...holdings.meta, risk: e.target.value } })}
              style={{
                width: '100%', background: C.bg, border: `1px solid ${C.border}`,
                borderRadius: 3, padding: '8px 10px', color: C.text, fontFamily: FONT_BODY, fontSize: 13, outline: 'none'
              }}
            >
              <option value="conservative">Conservative</option>
              <option value="moderate">Moderate</option>
              <option value="aggressive">Aggressive</option>
            </select>
          </div>
          <div>
            <div style={{ fontFamily: FONT_MONO, fontSize: 9, color: C.textDim, letterSpacing: 1.5, marginBottom: 6 }}>
              HORIZON (YRS)
            </div>
            <input
              type="number"
              value={holdings.meta.horizon}
              onChange={e => save({ ...holdings, meta: { ...holdings.meta, horizon: e.target.value } })}
              style={{
                width: '100%', background: C.bg, border: `1px solid ${C.border}`,
                borderRadius: 3, padding: '8px 10px', color: C.text, fontFamily: FONT_MONO, fontSize: 13, outline: 'none'
              }}
            />
          </div>
        </div>
      </Card>

      <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 20 }}>
        <Button onClick={analyze} disabled={loading} size="lg">
          {loading ? <><Loader2 size={16} style={{ animation: 'spin 1s linear infinite' }} /> Analyzing portfolio</> : <><BarChart3 size={16} /> Analyze My Portfolio</>}
        </Button>
      </div>

      <ErrorBanner error={error} onDismiss={() => setError(null)} />

      {loading && <LoadingIndicator text="Running diversification, sector, risk analysis..." />}

      {!loading && analysis && <PortfolioAnalysisContent data={analysis} />}

      {showAddStock && <AddStockModal onAdd={addStock} onClose={() => setShowAddStock(false)} />}
      {showAddFund && <AddFundModal onAdd={addFund} onClose={() => setShowAddFund(false)} />}
    </div>
  );
}

function PortfolioAnalysisContent({ data }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Card>
        <div style={{ fontFamily: FONT_DISPLAY, fontSize: 15, color: C.text, lineHeight: 1.6, fontStyle: 'italic' }}>
          {data.summary}
        </div>
      </Card>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 16 }}>
        {data.totalValue && (
          <Card>
            <Metric label="Portfolio Value" value={data.totalValue} size="md" />
          </Card>
        )}
        {data.diversification && (
          <Card>
            <Metric label="Diversification" value={`${data.diversification.score}/10`} size="md" />
            <div style={{ fontFamily: FONT_BODY, fontSize: 12, color: C.textMute, marginTop: 8, lineHeight: 1.5 }}>
              {data.diversification.assessment}
            </div>
          </Card>
        )}
      </div>

      {data.sectorConcentration && (
        <Card>
          <div style={{ fontFamily: FONT_MONO, fontSize: 10, color: C.brass, letterSpacing: 2, marginBottom: 14 }}>
            SECTOR ALLOCATION
          </div>
          {data.sectorConcentration.map((s, i) => {
            const pct = parseFloat(s.percent) || 0;
            const color = s.assessment === 'overweight' ? C.warn : s.assessment === 'underweight' ? C.info : C.pos;
            return (
              <div key={i} style={{ marginBottom: 12 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                  <span style={{ fontFamily: FONT_BODY, fontSize: 13, color: C.text }}>{s.sector}</span>
                  <span style={{ fontFamily: FONT_MONO, fontSize: 12, color }}>{s.percent}</span>
                </div>
                <div style={{ height: 4, background: C.border, borderRadius: 2, overflow: 'hidden' }}>
                  <div style={{ width: `${pct}%`, height: '100%', background: color }} />
                </div>
              </div>
            );
          })}
        </Card>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 16 }}>
        {data.strengths && (
          <Card style={{ borderColor: C.pos, borderLeftWidth: 2 }}>
            <div style={{ fontFamily: FONT_MONO, fontSize: 10, color: C.pos, letterSpacing: 2, marginBottom: 14 }}>
              STRENGTHS
            </div>
            {data.strengths.map((s, i) => (
              <div key={i} style={{ padding: '6px 0', fontFamily: FONT_BODY, fontSize: 13, color: C.text, lineHeight: 1.5, display: 'flex', gap: 10 }}>
                <span style={{ color: C.pos }}>+</span>{s}
              </div>
            ))}
          </Card>
        )}
        {data.concerns && (
          <Card style={{ borderColor: C.neg, borderLeftWidth: 2 }}>
            <div style={{ fontFamily: FONT_MONO, fontSize: 10, color: C.neg, letterSpacing: 2, marginBottom: 14 }}>
              CONCERNS
            </div>
            {data.concerns.map((c, i) => (
              <div key={i} style={{ padding: '6px 0', fontFamily: FONT_BODY, fontSize: 13, color: C.text, lineHeight: 1.5, display: 'flex', gap: 10 }}>
                <span style={{ color: C.neg }}>!</span>{c}
              </div>
            ))}
          </Card>
        )}
      </div>

      {data.rebalancing && data.rebalancing.length > 0 && (
        <Card>
          <div style={{ fontFamily: FONT_MONO, fontSize: 10, color: C.brass, letterSpacing: 2, marginBottom: 14 }}>
            REBALANCING RECOMMENDATIONS
          </div>
          {data.rebalancing.map((r, i) => {
            const actionColors = { REDUCE: C.warn, ADD: C.pos, EXIT: C.neg, HOLD: C.info };
            const color = actionColors[r.action] || C.textMute;
            return (
              <div key={i} style={{ 
                padding: '12px 0', 
                borderBottom: i < data.rebalancing.length - 1 ? `1px solid ${C.border}` : 'none'
              }}>
                <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
                  <span style={{
                    padding: '2px 8px',
                    border: `1px solid ${color}`,
                    color,
                    fontFamily: FONT_MONO,
                    fontSize: 10,
                    letterSpacing: 1,
                    borderRadius: 2,
                    flexShrink: 0,
                    whiteSpace: 'nowrap'
                  }}>
                    {r.action} · {plainAction(r.action)}
                  </span>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontFamily: FONT_BODY, fontSize: 13, color: C.text, fontWeight: 500, marginBottom: 4 }}>
                      {r.holding} {r.targetAllocation && <span style={{ color: C.textMute, fontFamily: FONT_MONO, fontSize: 11, marginLeft: 8 }}>→ {r.targetAllocation}</span>}
                    </div>
                    <div style={{ fontFamily: FONT_BODY, fontSize: 12, color: C.textMute, lineHeight: 1.5 }}>
                      {r.reason}
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </Card>
      )}

      {data.gaps && (
        <Card>
          <div style={{ fontFamily: FONT_MONO, fontSize: 10, color: C.brass, letterSpacing: 2, marginBottom: 14 }}>
            MISSING EXPOSURES
          </div>
          {data.gaps.map((g, i) => (
            <div key={i} style={{ padding: '6px 0', fontFamily: FONT_BODY, fontSize: 13, color: C.text, lineHeight: 1.5, display: 'flex', gap: 10 }}>
              <ChevronRight size={14} color={C.brass} style={{ marginTop: 3 }} />{g}
            </div>
          ))}
        </Card>
      )}

      {data.taxOptimization && (
        <Card>
          <div style={{ fontFamily: FONT_MONO, fontSize: 10, color: C.brass, letterSpacing: 2, marginBottom: 14 }}>
            TAX NOTES
          </div>
          {data.taxOptimization.map((t, i) => (
            <div key={i} style={{ padding: '6px 0', fontFamily: FONT_BODY, fontSize: 13, color: C.text, lineHeight: 1.5 }}>
              {t}
            </div>
          ))}
        </Card>
      )}
    </div>
  );
}

function AddStockModal({ onAdd, onClose }) {
  const [ticker, setTicker] = useState('');
  const [name, setName] = useState('');
  const [qty, setQty] = useState('');
  const [avgCost, setAvgCost] = useState('');

  return (
    <Modal onClose={onClose} title="Add Stock">
      <ModalInput label="Ticker (e.g. HDFCBANK)" value={ticker} onChange={setTicker} mono />
      <ModalInput label="Company Name (optional)" value={name} onChange={setName} />
      <ModalInput label="Quantity" value={qty} onChange={setQty} type="number" mono />
      <ModalInput label="Avg Cost (₹ per share)" value={avgCost} onChange={setAvgCost} type="number" mono />
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 20 }}>
        <Button variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
        <Button size="sm" onClick={() => {
          if (!ticker || !qty || !avgCost) return;
          onAdd({ ticker: ticker.toUpperCase(), name, qty: parseFloat(qty), avgCost: parseFloat(avgCost) });
        }}>Add</Button>
      </div>
    </Modal>
  );
}

function AddFundModal({ onAdd, onClose }) {
  const [name, setName] = useState('');
  const [sipAmount, setSipAmount] = useState('');
  const [currentValue, setCurrentValue] = useState('');

  return (
    <Modal onClose={onClose} title="Add Mutual Fund">
      <ModalInput label="Fund Name (e.g. Parag Parikh Flexi Cap)" value={name} onChange={setName} />
      <ModalInput label="SIP Amount ₹/month (optional)" value={sipAmount} onChange={setSipAmount} type="number" mono />
      <ModalInput label="Current Value ₹ (optional)" value={currentValue} onChange={setCurrentValue} type="number" mono />
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 20 }}>
        <Button variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
        <Button size="sm" onClick={() => {
          if (!name) return;
          onAdd({ name, sipAmount: sipAmount ? parseFloat(sipAmount) : null, currentValue: currentValue ? parseFloat(currentValue) : null });
        }}>Add</Button>
      </div>
    </Modal>
  );
}

function Modal({ children, onClose, title }) {
  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 100,
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20
    }} onClick={onClose}>
      <div style={{
        background: C.surface, border: `1px solid ${C.borderStrong}`, borderRadius: 4,
        padding: 24, maxWidth: 440, width: '100%'
      }} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
          <div style={{ fontFamily: FONT_DISPLAY, fontSize: 18, color: C.text }}>{title}</div>
          <X size={18} color={C.textMute} style={{ cursor: 'pointer' }} onClick={onClose} />
        </div>
        {children}
      </div>
    </div>
  );
}

function ModalInput({ label, value, onChange, type = 'text', mono }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ fontFamily: FONT_MONO, fontSize: 10, color: C.textDim, letterSpacing: 1.5, marginBottom: 6 }}>
        {label.toUpperCase()}
      </div>
      <input
        type={type}
        value={value}
        onChange={e => onChange(e.target.value)}
        style={{
          width: '100%',
          background: C.bg,
          border: `1px solid ${C.border}`,
          borderRadius: 3,
          padding: '10px 12px',
          fontFamily: mono ? FONT_MONO : FONT_BODY,
          fontSize: 14,
          color: C.text,
          outline: 'none',
          boxSizing: 'border-box'
        }}
      />
    </div>
  );
}

// ============================================================
// TAB 4: THEMATIC SCREEN
// ============================================================
function ThematicScreen() {
  const [filter, setFilter] = useState('');
  const [results, setResults] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const presets = [
    { label: 'Quality Compounders', filter: 'Indian large + midcap stocks with ROCE >20%, ROE >18%, D/E <0.5, revenue growth >12% CAGR over 5 years, promoter holding >45%' },
    { label: 'Undervalued Blue Chips', filter: 'Nifty 100 stocks trading below 5-year median PE, with stable earnings, dividend yield >2%, no governance issues' },
    { label: 'High Dividend Yield', filter: 'Indian stocks with dividend yield >4%, consistent payout for 5+ years, PSU or private, low debt' },
    { label: 'Small Cap Turnarounds', filter: 'Indian smallcaps showing FCF inflection in last 4 quarters, debt reduction, margin expansion, promoter buying' },
    { label: 'AI / Data Centre Play', filter: 'Indian listed beneficiaries of AI capex + data centre buildout — power, cooling, real estate, cabling, semiconductors' },
    { label: 'Defence & Railways', filter: 'Indian defence and railway capex beneficiaries with strong order book, >20% ROE, growing revenue visibility' },
  ];

  const run = async (filterText) => {
    const q = filterText || filter;
    if (!q.trim()) {
      setError('Enter or pick a filter');
      return;
    }
    setLoading(true);
    setError(null);
    setResults(null);
    setFilter(q);

    try {
      const prompt = `You are an equity screening analyst for Indian markets. Screen for stocks matching:

${q}

Use web search to verify each candidate against current data (Screener.in, Tijori, MoneyControl, latest results).

Return ONLY valid JSON. Schema:
{
  "filterDescription": "restate the filter clearly",
  "methodology": "1-2 sentences on how you screened",
  "topPicks": [
    {
      "ticker": "...",
      "name": "...",
      "sector": "...",
      "marketCap": "...",
      "currentPrice": "...",
      "keyMetrics": {"roe": "...", "roce": "...", "de": "...", "pe": "..."},
      "whyItFits": "1-2 sentence rationale",
      "risks": "1 line",
      "suggestedAction": "BUY|WATCH|RESEARCH"
    }
  ],
  "honorableMentions": [{"ticker": "...", "name": "...", "note": "why nearly made cut"}],
  "avoidList": [{"ticker": "...", "name": "...", "reason": "why to avoid despite superficial fit"}]
}

Return 5-8 top picks. Real, verifiable Indian stocks only. If a specific metric can't be verified, use "unavailable". Don't fabricate.`;

      const text = await callClaude(prompt, { maxTokens: 3000 });
      const parsed = extractJSON(text);
      setResults(parsed);
    } catch (e) {
      setError(e.message);
    }
    setLoading(false);
  };

  return (
    <div>
      <SectionTitle eyebrow="Module 04 — Screening">Thematic Screen</SectionTitle>

      <Card style={{ marginBottom: 20 }}>
        <div style={{ fontFamily: FONT_MONO, fontSize: 10, color: C.brass, letterSpacing: 2, marginBottom: 14 }}>
          QUICK PRESETS
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 8 }}>
          {presets.map((p, i) => (
            <button
              key={i}
              onClick={() => run(p.filter)}
              disabled={loading}
              style={{
                textAlign: 'left',
                background: 'transparent',
                border: `1px solid ${C.border}`,
                borderRadius: 3,
                padding: '12px 14px',
                cursor: loading ? 'not-allowed' : 'pointer',
                fontFamily: FONT_BODY,
                fontSize: 13,
                color: C.text,
                transition: 'all 0.15s'
              }}
              onMouseEnter={e => { e.currentTarget.style.borderColor = C.brass; e.currentTarget.style.color = C.brass; }}
              onMouseLeave={e => { e.currentTarget.style.borderColor = C.border; e.currentTarget.style.color = C.text; }}
            >
              {p.label}
            </button>
          ))}
        </div>
      </Card>

      <Card style={{ marginBottom: 20 }}>
        <div style={{ fontFamily: FONT_MONO, fontSize: 10, color: C.brass, letterSpacing: 2, marginBottom: 14 }}>
          CUSTOM FILTER
        </div>
        <textarea
          value={filter}
          onChange={e => setFilter(e.target.value)}
          placeholder='e.g. "Indian midcap chemicals with ROCE >25%, growing exports, less than 30% China dependency"'
          rows={3}
          style={{
            width: '100%', background: C.bg, border: `1px solid ${C.border}`, borderRadius: 3,
            padding: 12, fontFamily: FONT_BODY, fontSize: 13, color: C.text, outline: 'none',
            resize: 'vertical', boxSizing: 'border-box'
          }}
        />
        <div style={{ marginTop: 12, display: 'flex', justifyContent: 'flex-end' }}>
          <Button onClick={() => run()} disabled={loading}>
            {loading ? <><Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> Screening</> : <><Filter size={14} /> Run Screen</>}
          </Button>
        </div>
      </Card>

      <ErrorBanner error={error} onDismiss={() => setError(null)} />

      {loading && <LoadingIndicator text="Filtering universe, verifying metrics..." />}

      {!loading && results && <ScreenResults data={results} />}
    </div>
  );
}

function ScreenResults({ data }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Card>
        <div style={{ fontFamily: FONT_MONO, fontSize: 10, color: C.brass, letterSpacing: 2, marginBottom: 8 }}>
          SCREEN
        </div>
        <div style={{ fontFamily: FONT_BODY, fontSize: 14, color: C.text, marginBottom: 12, lineHeight: 1.5 }}>
          {data.filterDescription}
        </div>
        {data.methodology && (
          <div style={{ fontFamily: FONT_BODY, fontSize: 12, color: C.textMute, fontStyle: 'italic', lineHeight: 1.5 }}>
            {data.methodology}
          </div>
        )}
      </Card>

      {data.topPicks?.map((p, i) => (
        <Card key={i}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
            <div>
              <div style={{ fontFamily: FONT_MONO, fontSize: 10, color: C.brass, letterSpacing: 1.5, marginBottom: 2 }}>
                {String(i + 1).padStart(2, '0')} · {p.sector}
              </div>
              <div style={{ display: 'flex', gap: 10, alignItems: 'baseline' }}>
                <div style={{ fontFamily: FONT_MONO, fontSize: 16, color: C.text, fontWeight: 600 }}>
                  {p.ticker}
                </div>
                <div style={{ fontFamily: FONT_DISPLAY, fontSize: 16, color: C.textMute }}>
                  {p.name}
                </div>
              </div>
            </div>
            {p.suggestedAction && (
              <span style={{
                padding: '4px 10px',
                border: `1px solid ${p.suggestedAction === 'BUY' ? C.pos : p.suggestedAction === 'WATCH' ? C.warn : C.info}`,
                color: p.suggestedAction === 'BUY' ? C.pos : p.suggestedAction === 'WATCH' ? C.warn : C.info,
                fontFamily: FONT_MONO,
                fontSize: 11,
                letterSpacing: 1.5,
                borderRadius: 2,
                whiteSpace: 'nowrap'
              }}>
                {p.suggestedAction} · {plainAction(p.suggestedAction)}
              </span>
            )}
          </div>

          {p.keyMetrics && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(70px, 1fr))', gap: 12, marginBottom: 14, paddingBottom: 14, borderBottom: `1px solid ${C.border}` }}>
              <Metric label="Price" value={p.currentPrice} size="sm" />
              <Metric label="M.Cap" value={p.marketCap} size="sm" />
              <Metric label="P/E" value={p.keyMetrics.pe} size="sm" />
              <Metric label="ROE" value={p.keyMetrics.roe} size="sm" />
              <Metric label="ROCE" value={p.keyMetrics.roce} size="sm" />
              <Metric label="D/E" value={p.keyMetrics.de} size="sm" />
            </div>
          )}

          <div style={{ fontFamily: FONT_BODY, fontSize: 13, color: C.text, lineHeight: 1.5, marginBottom: 8 }}>
            <span style={{ color: C.pos, fontFamily: FONT_MONO, fontSize: 10, letterSpacing: 1.5, marginRight: 8 }}>WHY</span>
            {p.whyItFits}
          </div>
          {p.risks && (
            <div style={{ fontFamily: FONT_BODY, fontSize: 13, color: C.textMute, lineHeight: 1.5 }}>
              <span style={{ color: C.neg, fontFamily: FONT_MONO, fontSize: 10, letterSpacing: 1.5, marginRight: 8 }}>RISK</span>
              {p.risks}
            </div>
          )}
        </Card>
      ))}

      {data.honorableMentions && data.honorableMentions.length > 0 && (
        <Card>
          <div style={{ fontFamily: FONT_MONO, fontSize: 10, color: C.brass, letterSpacing: 2, marginBottom: 14 }}>
            HONORABLE MENTIONS
          </div>
          {data.honorableMentions.map((h, i) => (
            <div key={i} style={{ padding: '8px 0', fontFamily: FONT_BODY, fontSize: 13, color: C.text, lineHeight: 1.5 }}>
              <span style={{ fontFamily: FONT_MONO, color: C.brass, marginRight: 8 }}>{h.ticker}</span>
              {h.name} · <span style={{ color: C.textMute }}>{h.note}</span>
            </div>
          ))}
        </Card>
      )}

      {data.avoidList && data.avoidList.length > 0 && (
        <Card style={{ borderColor: C.neg, borderLeftWidth: 2 }}>
          <div style={{ fontFamily: FONT_MONO, fontSize: 10, color: C.neg, letterSpacing: 2, marginBottom: 14 }}>
            AVOID (LOOKS RIGHT, ISN'T)
          </div>
          {data.avoidList.map((a, i) => (
            <div key={i} style={{ padding: '8px 0', fontFamily: FONT_BODY, fontSize: 13, color: C.text, lineHeight: 1.5 }}>
              <span style={{ fontFamily: FONT_MONO, color: C.neg, marginRight: 8 }}>{a.ticker}</span>
              {a.name} · <span style={{ color: C.textMute }}>{a.reason}</span>
            </div>
          ))}
        </Card>
      )}
    </div>
  );
}

// ============================================================
// SETTINGS MODAL — Gemini API key entry
// ============================================================
// ============================================================
// JOURNAL — Review past analyses, mark hits/misses, capture lessons.
// Every deep-dive is auto-logged. This tab is where the learning loop closes:
// pull current prices, compute return vs entry, note what went wrong.
// ============================================================
function JournalTab() {
  const [rows, setRows] = useState([]);
  const [quotes, setQuotes] = useState({}); // ticker → { price, currency }
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [editing, setEditing] = useState(null); // id being edited
  const [draftLessons, setDraftLessons] = useState('');
  const [draftOutcome, setDraftOutcome] = useState('PENDING');

  const configured = journalReady();

  const load = async () => {
    if (!configured) return;
    setLoading(true); setError(null);
    try {
      const list = await listAll(100);
      setRows(list);
      // Fetch live quotes for distinct tickers in parallel
      const tickers = Array.from(new Set(list.map(r => r.ticker))).slice(0, 40);
      if (tickers.length) {
        const results = await getBatchQuotes(tickers);
        const map = {};
        results.forEach(q => { if (!q.failed) map[q.ticker.toUpperCase()] = q; });
        setQuotes(map);
      }
    } catch (e) {
      setError(e.message);
    }
    setLoading(false);
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  const beginEdit = (row) => {
    setEditing(row.id);
    setDraftLessons(row.lessons || '');
    setDraftOutcome(row.outcome || 'PENDING');
  };

  const commitEdit = async (row) => {
    const live = quotes[row.ticker];
    let returnPct = row.return_pct;
    if (live && row.price_at_analysis) {
      returnPct = ((live.price - row.price_at_analysis) / row.price_at_analysis) * 100;
    }
    const res = await updateReview(row.id, {
      outcome: draftOutcome,
      lessons: draftLessons,
      priceAtReview: live?.price ?? null,
      returnPct: returnPct ?? null,
    });
    if (!res.ok) { setError(res.reason); return; }
    setEditing(null);
    load();
  };

  const del = async (row) => {
    if (!window.confirm(`Delete journal entry for ${row.ticker} from ${new Date(row.created_at).toLocaleDateString()}?`)) return;
    const res = await deleteAnalysis(row.id);
    if (!res.ok) { setError(res.reason); return; }
    load();
  };

  if (!configured) {
    return (
      <div>
        <SectionTitle eyebrow="Module 05 — Learning Loop">Analysis Journal</SectionTitle>
        <Card>
          <div style={{ fontFamily: FONT_BODY, fontSize: 14, color: C.text, lineHeight: 1.6, marginBottom: 12 }}>
            The journal saves every stock analysis so future runs can reference past calls and avoid repeating mistakes.
          </div>
          <div style={{ fontFamily: FONT_BODY, fontSize: 13, color: C.textMute, lineHeight: 1.6 }}>
            To enable: open the gear icon (top right) and add a free Supabase Project URL + anon key. The Settings modal has a "Show setup SQL" button — run that SQL once in your Supabase SQL editor to create the table.
          </div>
        </Card>
      </div>
    );
  }

  const hits = rows.filter(r => r.outcome === 'HIT').length;
  const misses = rows.filter(r => r.outcome === 'MISS').length;
  const pending = rows.length - hits - misses;

  return (
    <div>
      <SectionTitle eyebrow="Module 05 — Learning Loop">Analysis Journal</SectionTitle>

      <Card style={{ marginBottom: 20 }}>
        <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', alignItems: 'center' }}>
          <div>
            <div style={{ fontFamily: FONT_MONO, fontSize: 9, color: C.textDim, letterSpacing: 1.5 }}>TOTAL CALLS</div>
            <div style={{ fontFamily: FONT_MONO, fontSize: 22, color: C.text, fontWeight: 500 }}>{rows.length}</div>
          </div>
          <div>
            <div style={{ fontFamily: FONT_MONO, fontSize: 9, color: C.textDim, letterSpacing: 1.5 }}>HITS</div>
            <div style={{ fontFamily: FONT_MONO, fontSize: 22, color: C.pos, fontWeight: 500 }}>{hits}</div>
          </div>
          <div>
            <div style={{ fontFamily: FONT_MONO, fontSize: 9, color: C.textDim, letterSpacing: 1.5 }}>MISSES</div>
            <div style={{ fontFamily: FONT_MONO, fontSize: 22, color: C.neg, fontWeight: 500 }}>{misses}</div>
          </div>
          <div>
            <div style={{ fontFamily: FONT_MONO, fontSize: 9, color: C.textDim, letterSpacing: 1.5 }}>PENDING</div>
            <div style={{ fontFamily: FONT_MONO, fontSize: 22, color: C.textMute, fontWeight: 500 }}>{pending}</div>
          </div>
          <div style={{ marginLeft: 'auto' }}>
            <Button onClick={load} disabled={loading}>
              {loading ? <><Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> Loading</> : <><RefreshCw size={14} /> Refresh</>}
            </Button>
          </div>
        </div>
      </Card>

      <ErrorBanner error={error} onDismiss={() => setError(null)} />

      {rows.length === 0 && !loading && (
        <Card>
          <div style={{ fontFamily: FONT_BODY, fontSize: 13, color: C.textMute, lineHeight: 1.6 }}>
            No entries yet. Head to the Stock tab, run an Analyze — it'll show up here.
          </div>
        </Card>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {rows.map(row => {
          const live = quotes[row.ticker];
          const returnPct = live && row.price_at_analysis
            ? ((live.price - row.price_at_analysis) / row.price_at_analysis) * 100
            : row.return_pct;
          const returnColor = returnPct == null ? C.textMute : returnPct >= 0 ? C.pos : C.neg;
          const outcomeColor = row.outcome === 'HIT' ? C.pos : row.outcome === 'MISS' ? C.neg : C.textMute;
          const recColor = { BUY: C.pos, HOLD: C.info, WATCH: C.warn, AVOID: C.neg }[row.recommendation] || C.textMute;
          const when = new Date(row.created_at);
          const isEditing = editing === row.id;

          return (
            <Card key={row.id}>
              <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-start' }}>
                <div style={{ minWidth: 140 }}>
                  <div style={{ fontFamily: FONT_MONO, fontSize: 14, color: C.text, fontWeight: 600 }}>{row.ticker}</div>
                  <div style={{ fontFamily: FONT_BODY, fontSize: 12, color: C.textMute, marginTop: 2 }}>{row.company_name || ''}</div>
                  <div style={{ fontFamily: FONT_MONO, fontSize: 10, color: C.textDim, marginTop: 4 }}>
                    {when.toLocaleDateString()} · {row.horizon || '?'}
                  </div>
                </div>

                <div style={{ minWidth: 90 }}>
                  <div style={{ fontFamily: FONT_MONO, fontSize: 9, color: C.textDim, letterSpacing: 1.5 }}>CALL</div>
                  <div style={{ fontFamily: FONT_MONO, fontSize: 13, color: recColor, fontWeight: 600, marginTop: 2 }}>{row.recommendation || '—'}</div>
                  {row.confidence != null && (
                    <div style={{ fontFamily: FONT_MONO, fontSize: 10, color: C.textMute, marginTop: 2 }}>{row.confidence}% conf</div>
                  )}
                </div>

                <div style={{ minWidth: 140 }}>
                  <div style={{ fontFamily: FONT_MONO, fontSize: 9, color: C.textDim, letterSpacing: 1.5 }}>PRICE THEN → NOW</div>
                  <div style={{ fontFamily: FONT_MONO, fontSize: 13, color: C.text, marginTop: 2, fontVariantNumeric: 'tabular-nums' }}>
                    {row.price_at_analysis != null ? `${row.currency || 'INR'} ${row.price_at_analysis.toFixed(2)}` : '—'}
                    <span style={{ color: C.textDim, margin: '0 6px' }}>→</span>
                    {live ? formatPrice(live.price, live.currency) : '—'}
                  </div>
                  {returnPct != null && (
                    <div style={{ fontFamily: FONT_MONO, fontSize: 12, color: returnColor, marginTop: 2, fontVariantNumeric: 'tabular-nums' }}>
                      {returnPct >= 0 ? '+' : ''}{returnPct.toFixed(2)}%
                    </div>
                  )}
                </div>

                <div style={{ minWidth: 90 }}>
                  <div style={{ fontFamily: FONT_MONO, fontSize: 9, color: C.textDim, letterSpacing: 1.5 }}>OUTCOME</div>
                  <div style={{ fontFamily: FONT_MONO, fontSize: 12, color: outcomeColor, fontWeight: 600, marginTop: 4 }}>
                    {row.outcome || 'PENDING'}
                  </div>
                </div>

                <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                  {!isEditing ? (
                    <>
                      <button onClick={() => beginEdit(row)} style={editBtnStyle}>Review</button>
                      <button onClick={() => del(row)} style={{ ...editBtnStyle, color: C.neg, borderColor: C.neg }}><Trash2 size={12} /></button>
                    </>
                  ) : (
                    <>
                      <button onClick={() => commitEdit(row)} style={{ ...editBtnStyle, background: C.brass, color: C.bg, borderColor: C.brass }}>Save</button>
                      <button onClick={() => setEditing(null)} style={editBtnStyle}>Cancel</button>
                    </>
                  )}
                </div>
              </div>

              {row.summary && !isEditing && (
                <div style={{ fontFamily: FONT_BODY, fontSize: 12, color: C.textMute, lineHeight: 1.5, marginTop: 12, fontStyle: 'italic' }}>
                  {row.summary}
                </div>
              )}

              {row.lessons && !isEditing && (
                <div style={{ marginTop: 10, padding: 10, background: C.bg, borderRadius: 3, borderLeft: `2px solid ${C.brass}` }}>
                  <div style={{ fontFamily: FONT_MONO, fontSize: 9, color: C.brass, letterSpacing: 1.5, marginBottom: 4 }}>LESSONS</div>
                  <div style={{ fontFamily: FONT_BODY, fontSize: 12, color: C.text, lineHeight: 1.5 }}>{row.lessons}</div>
                </div>
              )}

              {isEditing && (
                <div style={{ marginTop: 12, display: 'grid', gap: 10 }}>
                  <div style={{ display: 'flex', gap: 8 }}>
                    {['HIT', 'MISS', 'PENDING'].map(o => (
                      <button
                        key={o}
                        onClick={() => setDraftOutcome(o)}
                        style={{
                          flex: 1,
                          padding: '8px 12px',
                          border: `1px solid ${draftOutcome === o ? C.brass : C.border}`,
                          background: draftOutcome === o ? C.brass : 'transparent',
                          color: draftOutcome === o ? C.bg : C.text,
                          fontFamily: FONT_MONO, fontSize: 11, letterSpacing: 1.5,
                          borderRadius: 3, cursor: 'pointer', fontWeight: 600,
                        }}
                      >
                        {o}
                      </button>
                    ))}
                  </div>
                  <textarea
                    value={draftLessons}
                    onChange={e => setDraftLessons(e.target.value)}
                    placeholder="What did I get right or wrong? What signal did I miss? (This is fed back into future analyses.)"
                    rows={3}
                    style={{
                      width: '100%', padding: 10, background: C.bg,
                      border: `1px solid ${C.border}`, borderRadius: 4,
                      color: C.text, fontFamily: FONT_BODY, fontSize: 13,
                      outline: 'none', resize: 'vertical', lineHeight: 1.5,
                    }}
                  />
                </div>
              )}
            </Card>
          );
        })}
      </div>
    </div>
  );
}
const editBtnStyle = {
  padding: '6px 12px',
  border: `1px solid ${C.border}`,
  background: 'transparent',
  color: C.textMute,
  borderRadius: 3,
  fontFamily: FONT_MONO,
  fontSize: 11,
  letterSpacing: 1,
  cursor: 'pointer',
};

function SettingsModal({ open, onClose }) {
  const [key, setKey] = useState('');
  const [groqKey, setGroqKey] = useState('');
  const [provider, setProvider] = useState('gemini');
  const [supabaseUrl, setSupabaseUrl] = useState('');
  const [supabaseKey, setSupabaseKey] = useState('');
  const [showSql, setShowSql] = useState(false);
  const [copiedSql, setCopiedSql] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!open) return;
    try {
      setKey(localStorage.getItem('geminiApiKey') || '');
      setGroqKey(localStorage.getItem('groqApiKey') || '');
      setProvider(localStorage.getItem('llmProvider') || 'gemini');
      setSupabaseUrl(localStorage.getItem('supabaseUrl') || '');
      setSupabaseKey(localStorage.getItem('supabaseAnonKey') || '');
    } catch {}
    setSaved(false);
    setShowSql(false);
    setCopiedSql(false);
  }, [open]);

  if (!open) return null;

  const save = () => {
    try {
      localStorage.setItem('geminiApiKey', key.trim());
      localStorage.setItem('groqApiKey', groqKey.trim());
      localStorage.setItem('llmProvider', provider);
      localStorage.setItem('supabaseUrl', supabaseUrl.trim());
      localStorage.setItem('supabaseAnonKey', supabaseKey.trim());
    } catch {}
    setSaved(true);
    setTimeout(() => { setSaved(false); onClose(); }, 700);
  };

  const clear = () => {
    try {
      localStorage.removeItem('geminiApiKey');
      localStorage.removeItem('groqApiKey');
      localStorage.removeItem('supabaseUrl');
      localStorage.removeItem('supabaseAnonKey');
    } catch {}
    setKey('');
    setGroqKey('');
    setSupabaseUrl('');
    setSupabaseKey('');
  };

  const copySql = async () => {
    try {
      await navigator.clipboard.writeText(JOURNAL_SETUP_SQL);
      setCopiedSql(true);
      setTimeout(() => setCopiedSql(false), 1500);
    } catch {}
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.65)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 100, padding: 20,
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: C.surface, border: `1px solid ${C.border}`,
          borderRadius: 6, padding: 28, maxWidth: 520, width: '100%',
          maxHeight: '90vh', overflowY: 'auto',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 }}>
          <div style={{ fontFamily: FONT_DISPLAY, fontSize: 20, fontWeight: 500, color: C.text }}>Settings</div>
          <button onClick={onClose} style={{ background: 'transparent', border: 'none', color: C.textMute, cursor: 'pointer', padding: 4 }}>
            <X size={18} />
          </button>
        </div>

        <div style={{ fontFamily: FONT_MONO, fontSize: 10, color: C.brass, letterSpacing: 2, textTransform: 'uppercase', marginBottom: 8 }}>
          Active LLM Provider
        </div>
        <div style={{ display: 'flex', gap: 8, marginBottom: 6 }}>
          {[
            { id: 'gemini', label: 'Gemini', hint: 'grounded (fresh news)' },
            { id: 'groq',   label: 'Groq',   hint: '5–10× faster, no search' },
          ].map(p => (
            <button
              key={p.id}
              onClick={() => setProvider(p.id)}
              style={{
                flex: 1,
                background: provider === p.id ? C.brass : 'transparent',
                border: `1px solid ${provider === p.id ? C.brass : C.border}`,
                borderRadius: 4, padding: '10px 12px',
                color: provider === p.id ? C.bg : C.text,
                fontFamily: FONT_MONO, fontSize: 12, letterSpacing: 1,
                cursor: 'pointer', textAlign: 'left', fontWeight: 500,
              }}
            >
              <div style={{ textTransform: 'uppercase', fontSize: 11 }}>{p.label}</div>
              <div style={{ fontSize: 9, opacity: 0.75, marginTop: 2 }}>{p.hint}</div>
            </button>
          ))}
        </div>
        <div style={{ fontFamily: FONT_BODY, fontSize: 11, color: C.textDim, marginTop: 4, marginBottom: 18, lineHeight: 1.5 }}>
          Gemini has live web search — best for daily brief and stock analysis. Groq is much faster but works from training data alone, so news-sensitive reports may look stale.
        </div>

        <div style={{ fontFamily: FONT_MONO, fontSize: 10, color: C.brass, letterSpacing: 2, textTransform: 'uppercase', marginBottom: 8 }}>
          Gemini API Key
        </div>
        <input
          type="password"
          value={key}
          onChange={e => setKey(e.target.value)}
          placeholder="AIza..."
          autoFocus
          style={{
            width: '100%', padding: '10px 12px', background: C.bg,
            border: `1px solid ${C.border}`, borderRadius: 4, color: C.text,
            fontFamily: FONT_MONO, fontSize: 12, outline: 'none',
          }}
        />
        <div style={{ fontFamily: FONT_BODY, fontSize: 11, color: C.textDim, marginTop: 8, marginBottom: 16, lineHeight: 1.5 }}>
          Free key at <a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noreferrer" style={{ color: C.brass, textDecoration: 'none' }}>aistudio.google.com/app/apikey</a>.
        </div>

        <div style={{ fontFamily: FONT_MONO, fontSize: 10, color: C.brass, letterSpacing: 2, textTransform: 'uppercase', marginBottom: 8 }}>
          Groq API Key
        </div>
        <input
          type="password"
          value={groqKey}
          onChange={e => setGroqKey(e.target.value)}
          placeholder="gsk_..."
          style={{
            width: '100%', padding: '10px 12px', background: C.bg,
            border: `1px solid ${C.border}`, borderRadius: 4, color: C.text,
            fontFamily: FONT_MONO, fontSize: 12, outline: 'none',
          }}
        />
        <div style={{ fontFamily: FONT_BODY, fontSize: 11, color: C.textDim, marginTop: 8, lineHeight: 1.5 }}>
          Free key at <a href="https://console.groq.com/keys" target="_blank" rel="noreferrer" style={{ color: C.brass, textDecoration: 'none' }}>console.groq.com/keys</a>. Both keys stored only in this browser's localStorage.
        </div>

        <div style={{ borderTop: `1px solid ${C.border}`, marginTop: 22, paddingTop: 22 }}>
          <div style={{ fontFamily: FONT_MONO, fontSize: 10, color: C.brass, letterSpacing: 2, textTransform: 'uppercase', marginBottom: 8 }}>
            Analysis Journal (Supabase)
          </div>
          <div style={{ fontFamily: FONT_BODY, fontSize: 11, color: C.textDim, marginBottom: 12, lineHeight: 1.5 }}>
            Optional. When configured, every stock analysis is logged so future runs can learn from past calls. Free project at <a href="https://supabase.com/dashboard" target="_blank" rel="noreferrer" style={{ color: C.brass, textDecoration: 'none' }}>supabase.com</a>.
          </div>

          <div style={{ fontFamily: FONT_MONO, fontSize: 9, color: C.textMute, letterSpacing: 1.5, textTransform: 'uppercase', marginBottom: 6 }}>
            Project URL
          </div>
          <input
            type="text"
            value={supabaseUrl}
            onChange={e => setSupabaseUrl(e.target.value)}
            placeholder="https://xxx.supabase.co"
            style={{
              width: '100%', padding: '10px 12px', background: C.bg,
              border: `1px solid ${C.border}`, borderRadius: 4, color: C.text,
              fontFamily: FONT_MONO, fontSize: 12, outline: 'none', marginBottom: 10,
            }}
          />

          <div style={{ fontFamily: FONT_MONO, fontSize: 9, color: C.textMute, letterSpacing: 1.5, textTransform: 'uppercase', marginBottom: 6 }}>
            Anon Key
          </div>
          <input
            type="password"
            value={supabaseKey}
            onChange={e => setSupabaseKey(e.target.value)}
            placeholder="eyJhbGci..."
            style={{
              width: '100%', padding: '10px 12px', background: C.bg,
              border: `1px solid ${C.border}`, borderRadius: 4, color: C.text,
              fontFamily: FONT_MONO, fontSize: 12, outline: 'none',
            }}
          />

          <button
            onClick={() => setShowSql(v => !v)}
            style={{
              background: 'transparent', border: 'none', color: C.brass,
              fontFamily: FONT_MONO, fontSize: 11, cursor: 'pointer',
              marginTop: 10, padding: 0, textDecoration: 'underline',
            }}
          >
            {showSql ? 'Hide setup SQL' : 'Show setup SQL (run once in Supabase)'}
          </button>
          {showSql && (
            <div style={{ marginTop: 8 }}>
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 4 }}>
                <button
                  onClick={copySql}
                  style={{
                    background: 'transparent', border: `1px solid ${C.border}`,
                    color: C.textMute, borderRadius: 3, padding: '3px 8px',
                    fontFamily: FONT_MONO, fontSize: 10, cursor: 'pointer',
                    letterSpacing: 1,
                  }}
                >
                  {copiedSql ? 'COPIED' : 'COPY'}
                </button>
              </div>
              <pre style={{
                background: C.bg, border: `1px solid ${C.border}`,
                borderRadius: 4, padding: 12, margin: 0,
                fontFamily: FONT_MONO, fontSize: 10, color: C.textMute,
                overflow: 'auto', maxHeight: 200, lineHeight: 1.5,
              }}>
                {JOURNAL_SETUP_SQL}
              </pre>
            </div>
          )}
        </div>

        <div style={{ display: 'flex', gap: 10, marginTop: 22 }}>
          {(() => {
            const activeKey = provider === 'groq' ? groqKey : key;
            const canSave = !!activeKey.trim();
            return (
          <button
            onClick={save}
            disabled={!canSave}
            style={{
              flex: 1, background: C.brass, border: 'none', borderRadius: 4,
              padding: '11px 16px', color: C.bg, fontFamily: FONT_MONO,
              fontSize: 12, letterSpacing: 1.5, textTransform: 'uppercase',
              cursor: canSave ? 'pointer' : 'not-allowed',
              opacity: canSave ? 1 : 0.4, fontWeight: 600,
            }}
          >
            {saved ? 'Saved' : 'Save'}
          </button>
            );
          })()}
          <button
            onClick={clear}
            style={{
              background: 'transparent', border: `1px solid ${C.border}`,
              borderRadius: 4, padding: '11px 16px', color: C.textMute,
              fontFamily: FONT_MONO, fontSize: 12, letterSpacing: 1.5,
              textTransform: 'uppercase', cursor: 'pointer',
            }}
          >
            Clear
          </button>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// MAIN APP
// ============================================================
export default function App() {
  const [tab, setTab] = useState('brief');
  const [settingsOpen, setSettingsOpen] = useState(false);

  const tabs = [
    { id: 'brief', label: 'Brief', icon: Newspaper },
    { id: 'stock', label: 'Stock', icon: Search },
    { id: 'portfolio', label: 'Portfolio', icon: Briefcase },
    { id: 'screen', label: 'Screen', icon: Filter },
    { id: 'journal', label: 'Journal', icon: Clock },
  ];

  return (
    <div style={{ 
      background: C.bg, 
      minHeight: '100vh', 
      color: C.text,
      fontFamily: FONT_BODY,
    }}>
      {/* Fraunces + Inter + JetBrains Mono loaded via Google Fonts */}
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,500;9..144,600&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500;600&display=swap');
        * { box-sizing: border-box; }
        input::placeholder, textarea::placeholder { color: ${C.textDim}; }
        button:hover:not(:disabled) { transform: translateY(-1px); }
      `}</style>

      {/* Header */}
      <header style={{ 
        borderBottom: `1px solid ${C.border}`, 
        padding: '18px 24px',
        background: C.bg,
        position: 'sticky',
        top: 0,
        zIndex: 50
      }}>
        <div style={{ maxWidth: 1200, margin: '0 auto', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
              <div style={{ 
                fontFamily: FONT_DISPLAY, 
                fontSize: 22, 
                fontWeight: 500,
                letterSpacing: -0.5,
                color: C.text
              }}>
                The Desk
              </div>
              <div style={{ 
                fontFamily: FONT_MONO, 
                fontSize: 10, 
                color: C.brass, 
                letterSpacing: 2,
                textTransform: 'uppercase'
              }}>
                Investment Research
              </div>
            </div>
            <div style={{ 
              fontFamily: FONT_BODY, 
              fontSize: 11, 
              color: C.textDim, 
              marginTop: 2
            }}>
              Live data · Live search · Every session fresh
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <div style={{
              fontFamily: FONT_MONO,
              fontSize: 11,
              color: C.textMute,
              letterSpacing: 1,
              fontVariantNumeric: 'tabular-nums'
            }}>
              {new Date().toLocaleDateString('en-IN', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' })}
            </div>
            <button
              onClick={() => setSettingsOpen(true)}
              title="Settings"
              style={{
                background: 'transparent',
                border: `1px solid ${C.border}`,
                borderRadius: 4,
                padding: '6px 8px',
                cursor: 'pointer',
                color: C.textMute,
                display: 'flex',
                alignItems: 'center',
              }}
            >
              <Settings size={14} />
            </button>
          </div>
        </div>
      </header>

      {/* Tab nav */}
      <nav style={{ 
        borderBottom: `1px solid ${C.border}`,
        background: C.surface,
        position: 'sticky',
        top: 65,
        zIndex: 49
      }}>
        <div style={{ maxWidth: 1200, margin: '0 auto', display: 'flex', overflowX: 'auto' }}>
          {tabs.map(t => {
            const Icon = t.icon;
            const active = tab === t.id;
            return (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                style={{
                  background: 'transparent',
                  border: 'none',
                  borderBottom: `2px solid ${active ? C.brass : 'transparent'}`,
                  padding: '14px 20px',
                  cursor: 'pointer',
                  fontFamily: FONT_MONO,
                  fontSize: 12,
                  color: active ? C.brass : C.textMute,
                  letterSpacing: 1.5,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  whiteSpace: 'nowrap',
                  transition: 'all 0.15s',
                  textTransform: 'uppercase',
                  fontWeight: 500
                }}
              >
                <Icon size={14} />
                {t.label}
              </button>
            );
          })}
        </div>
      </nav>

      {/* Content */}
      <main style={{ maxWidth: 1200, margin: '0 auto', padding: '28px 24px 60px' }}>
        {tab === 'brief' && <DailyBrief />}
        {tab === 'stock' && <StockDeepDive />}
        {tab === 'portfolio' && <PortfolioTab />}
        {tab === 'screen' && <ThematicScreen />}
        {tab === 'journal' && <JournalTab />}
      </main>

      {/* Footer */}
      <footer style={{ 
        borderTop: `1px solid ${C.border}`, 
        padding: '20px 24px',
        marginTop: 40
      }}>
        <div style={{ 
          maxWidth: 1200, 
          margin: '0 auto', 
          fontFamily: FONT_BODY,
          fontSize: 11,
          color: C.textDim,
          lineHeight: 1.6
        }}>
          Research tool for informational purposes only. Not investment advice from a SEBI-registered Investment Adviser. 
          Data is retrieved via live web search from public sources (NSE, BSE, Reuters, MoneyControl, Screener, etc.) 
          and may be delayed by up to 15 minutes. Verify with primary sources before allocating capital. 
          Past performance does not guarantee future results.
        </div>
      </footer>

      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  );
}
