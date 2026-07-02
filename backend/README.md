# DESK Backend (Railway-hosted)

Orchestration layer for the DESK investment terminal frontend. Phase 1 provides a health endpoint and thin proxies for Yahoo Finance quotes/history and Gemini/Groq LLM calls, so API keys stop living in the browser.

The frontend at `../src/InvestmentDesk.jsx` continues to work unchanged in Phase 1. Migration to backend endpoints happens gradually in Phase 2+.

## Endpoints (Phase 1 + Phase 2 — all live)

### Health + market data (Phase 1)
| Method | Path | Purpose |
|---|---|---|
| `GET`  | `/health` | Railway health check + capability report |
| `GET`  | `/market/quote?ticker=RELIANCE` | Yahoo quote proxy |
| `GET`  | `/market/history?ticker=TCS&range=5y&interval=1mo` | Yahoo history proxy |

### AI analysis (Phase 1 + Phase 2)
| Method | Path | Purpose |
|---|---|---|
| `POST` | `/analyze/stock` | **Phase 1 proxy** — client sends fully-assembled prompt (kept for backward compat) |
| `POST` | `/analyze/stock/full` | **Phase 2 orchestrated** — client sends `{ticker, horizon}`. Backend fetches Yahoo → loads memory → assembles prompt → calls LLM → runs safety gate + calibration → saves to journal |
| `POST` | `/analyze/portfolio` | Portfolio consultant — takes `{stocks, funds, cash, goals}`. Reasons about concentration, sector overlap, cash buffer, tax impact, liquidity, rebalancing |
| `POST` | `/analyze/screen` | Thematic screen — takes `{theme, criteria}` returns 5–8 real Indian picks |
| `GET`  | `/brief/daily` | Grounded daily brief (Nifty/Sensex/FII flows/news/watchlist) |

### Journal (Phase 2)
| Method | Path | Purpose |
|---|---|---|
| `POST`   | `/journal/save` | Insert an analysis. Accepts camelCase or snake_case keys |
| `GET`    | `/journal/ticker/{ticker}?limit=5` | Prior analyses for a ticker |
| `GET`    | `/journal/ticker/{ticker}/misses?limit=3` | Prior MISSes for a ticker |
| `GET`    | `/journal/mistakes?limit=5` | Recent worst calls across tickers |
| `GET`    | `/journal/all?limit=100&record_type=stock_deepdive` | Paginated list with optional filter |
| `GET`    | `/journal/stats?limit=500` | Hit rate by action + recurring mistake categories |
| `POST`   | `/journal/review/{id}` | Mark HIT/MISS + structured lessons |
| `DELETE` | `/journal/{id}` | Delete an analysis |

Phase 3 will add: `POST /notifications/test`, `GET /notifications`, `POST /watchlist`, `GET /watchlist`, plus scheduler-driven jobs.

## Local dev

```bash
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env  # fill in keys
uvicorn app.main:app --reload --port 8000
```

Health check: `curl http://localhost:8000/health`

## Railway deployment

1. Push this repo to GitHub.
2. In Railway → **New Project → Deploy from GitHub** → select this repo.
3. Set **Root Directory** to `backend/` (Settings → General).
4. Railway auto-detects the `Dockerfile` (also see `railway.json`).
5. Add environment variables (Settings → Variables) — see `.env.example`:
   - `GEMINI_API_KEY` and/or `GROQ_API_KEY`
   - `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`
   - `CORS_ORIGINS` — your deployed frontend URL (comma-separated for multiple)
6. Deploy. Railway assigns a URL; the health check at `/health` runs automatically.
7. In the frontend Settings modal (Phase 2+), point the "Backend URL" field at your Railway deployment URL.

## Environment variables

See `.env.example` for the full list. Required for full function:

- `GEMINI_API_KEY` — Gemini for grounded search (recommended primary)
- `GROQ_API_KEY` — Groq for fast, non-grounded calls
- `SUPABASE_URL` + `SUPABASE_SERVICE_KEY` — for journal persistence (Phase 2)
- `CORS_ORIGINS` — comma-separated list of frontend origins

## Logging

All logs are JSON on stdout — Railway's log viewer can filter by field. Key events:

- `startup` — configured providers + journal state
- `llm.ok` — provider, model, latency, attempt count
- `llm.fatal` — non-retryable LLM error
- `llm.model_exhausted` — fell through to next model in fallback list
- `analyze.llm_error`, `analyze.failed`
- `quote.failed`, `history.failed`

## Architecture (Phase 1 + 2)

```
frontend (React/Vite) ──┐
                        ├── /health              (Railway keeps container alive)
                        ├── /market/quote        (Yahoo proxy, retries + backoff)
                        ├── /market/history      (Yahoo proxy)
                        ├── /analyze/stock       (Phase 1 proxy — kept for compat)
                        ├── /analyze/stock/full  ─┐
                        ├── /analyze/portfolio    │  Backend orchestrator:
                        ├── /analyze/screen       │    market → memory → prompt →
                        ├── /brief/daily          │    LLM → safety gate → calibrate →
                        ├── /journal/*            │    journal save
                        └──                       ─┘
```

## What still runs in the frontend

- All UI (React + Vite)
- Local settings (localStorage)
- Optional: direct Supabase writes via `src/journal.js` for backward compat

Frontend integration to Phase 2 endpoints is **opt-in**. When the frontend
adds a "Backend URL" field in Settings and switches its LLM/journal calls,
prompt assembly + memory injection + safety gate all move server-side and
the same discipline applies to every client (including future mobile /
scheduled worker calls).

## What now runs in the backend

- API-key custody (env vars, no browser exposure)
- Yahoo Finance with retries + backoff (no more browser CORS fallback)
- LLM provider routing + retries + `thinkingBudget: 0` tuning
- Prompt assembly for all 4 modules (stock / portfolio / screen / brief)
- Memory injection from Supabase
- Safety gate + confidence calibration
- Journal CRUD + aggregations (`getMistakeStats`)
- Structured JSON logging
