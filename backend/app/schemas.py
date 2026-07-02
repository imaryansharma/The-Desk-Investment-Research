"""Pydantic request/response models."""
from typing import Any, Dict, List, Optional
from pydantic import BaseModel, Field


# ============================================================
# Phase 1 — health, market proxy, LLM proxy
# ============================================================
class HealthResponse(BaseModel):
    ok: bool
    service: str = "desk-backend"
    version: str = "0.2.0"
    providers: Dict[str, bool]
    journal_ready: bool


class QuoteResponse(BaseModel):
    ticker: str
    symbol: str
    name: Optional[str] = None
    price: Optional[float] = None
    previous_close: Optional[float] = Field(None, alias="previousClose")
    change: Optional[float] = None
    change_pct: Optional[float] = Field(None, alias="changePct")
    currency: Optional[str] = None
    day_high: Optional[float] = Field(None, alias="dayHigh")
    day_low: Optional[float] = Field(None, alias="dayLow")
    volume: Optional[int] = None
    exchange: Optional[str] = None
    regular_market_time: Optional[int] = Field(None, alias="regularMarketTime")
    model_config = {"populate_by_name": True}


class HistoryPoint(BaseModel):
    date: str
    close: float


class HistoryResponse(BaseModel):
    ticker: str
    symbol: str
    points: List[HistoryPoint]


class AnalyzeRequest(BaseModel):
    """Phase 1 proxy — client sends fully-assembled prompt."""
    prompt: str
    provider: Optional[str] = None
    max_tokens: int = 3200
    use_search: bool = True
    temperature: float = 0.4


class AnalyzeResponse(BaseModel):
    ok: bool
    text: Optional[str] = None
    provider_used: Optional[str] = None
    model_used: Optional[str] = None
    error: Optional[str] = None
    latency_ms: Optional[int] = None


# ============================================================
# Phase 2 — orchestrated analyses + journal
# ============================================================
class StockAnalyzeFullRequest(BaseModel):
    """Phase 2 orchestrated call. Backend fetches market data, loads memory,
    assembles prompt, calls LLM, runs safety gate + calibration, saves to
    journal, and returns the merged result."""
    ticker: str
    horizon: str = "3Y"
    provider: Optional[str] = None
    use_search: bool = True
    save_to_journal: bool = True


class StockAnalyzeFullResponse(BaseModel):
    ok: bool
    data: Optional[Dict[str, Any]] = None
    safety_gate: Optional[Dict[str, Any]] = None
    confidence_calibration: Optional[Dict[str, Any]] = None
    journal_saved: Optional[bool] = None
    journal_id: Optional[str] = None
    memory_used: Optional[Dict[str, Any]] = None  # counts of prior calls / misses
    provider_used: Optional[str] = None
    model_used: Optional[str] = None
    latency_ms: Optional[int] = None
    error: Optional[str] = None


class Holding(BaseModel):
    ticker: Optional[str] = None
    name: Optional[str] = None
    qty: Optional[float] = None
    avgCost: Optional[float] = None
    sector: Optional[str] = None
    value: Optional[float] = None  # for funds


class PortfolioGoals(BaseModel):
    horizon: Optional[str] = None
    targetReturn: Optional[str] = None
    emergencyCash: Optional[str] = None
    liquidityNeed: Optional[str] = None
    taxRegime: Optional[str] = None


class PortfolioAnalyzeRequest(BaseModel):
    stocks: List[Holding] = []
    funds: List[Holding] = []
    cash: float = 0
    goals: Optional[PortfolioGoals] = None
    provider: Optional[str] = None
    use_search: bool = True
    save_to_journal: bool = True


class PortfolioAnalyzeResponse(BaseModel):
    ok: bool
    data: Optional[Dict[str, Any]] = None
    journal_saved: Optional[bool] = None
    journal_id: Optional[str] = None
    provider_used: Optional[str] = None
    model_used: Optional[str] = None
    latency_ms: Optional[int] = None
    error: Optional[str] = None


class ScreenAnalyzeRequest(BaseModel):
    theme: str
    criteria: Optional[str] = None
    provider: Optional[str] = None
    use_search: bool = True
    save_to_journal: bool = True


class ScreenAnalyzeResponse(BaseModel):
    ok: bool
    data: Optional[Dict[str, Any]] = None
    journal_saved: Optional[bool] = None
    journal_id: Optional[str] = None
    provider_used: Optional[str] = None
    model_used: Optional[str] = None
    latency_ms: Optional[int] = None
    error: Optional[str] = None


class BriefResponse(BaseModel):
    ok: bool
    data: Optional[Dict[str, Any]] = None
    provider_used: Optional[str] = None
    model_used: Optional[str] = None
    latency_ms: Optional[int] = None
    error: Optional[str] = None


# ============================================================
# Journal endpoints
# ============================================================
class SaveAnalysisRequest(BaseModel):
    """Free-form insert. All fields optional so client can pass whatever
    subset it has. Accepts both camelCase and snake_case keys."""
    ticker: str
    company_name: Optional[str] = Field(None, alias="companyName")
    provider: Optional[str] = None
    horizon: Optional[str] = None
    price_at_analysis: Optional[float] = Field(None, alias="priceAtAnalysis")
    currency: Optional[str] = None
    recommendation: Optional[str] = None
    confidence: Optional[int] = None
    risk: Optional[str] = None
    fair_value: Optional[str] = Field(None, alias="fairValue")
    buy_range: Optional[str] = Field(None, alias="buyRange")
    summary: Optional[str] = None
    reasoning: Optional[Dict[str, Any]] = None
    bull_case: Optional[List[str]] = Field(None, alias="bullCase")
    bear_case: Optional[List[str]] = Field(None, alias="bearCase")
    full_data: Optional[Dict[str, Any]] = Field(None, alias="fullData")
    record_type: Optional[str] = Field(None, alias="recordType")
    market_regime: Optional[str] = Field(None, alias="marketRegime")
    model_version: Optional[str] = Field(None, alias="modelVersion")
    prompt_version: Optional[str] = Field(None, alias="promptVersion")
    grounded: Optional[bool] = None
    stated_confidence: Optional[int] = Field(None, alias="statedConfidence")
    calibrated_confidence: Optional[int] = Field(None, alias="calibratedConfidence")
    invalidators: Optional[List[Any]] = None
    recheck_triggers: Optional[List[Any]] = Field(None, alias="recheckTriggers")
    prior_mistakes_considered: Optional[List[Any]] = Field(None, alias="priorMistakesConsidered")
    safety_gate: Optional[Dict[str, Any]] = Field(None, alias="safetyGate")
    model_config = {"populate_by_name": True, "extra": "ignore"}


class SaveAnalysisResponse(BaseModel):
    ok: bool
    id: Optional[str] = None
    reason: Optional[str] = None


class ReviewRequest(BaseModel):
    outcome: Optional[str] = None
    lessons: Optional[str] = None
    priceAtReview: Optional[float] = None
    returnPct: Optional[float] = None
    mistakeCategory: Optional[str] = None
    whatWasMissed: Optional[str] = None
    whatToCheck: Optional[str] = None
    marketRegime: Optional[str] = None


class MutationResponse(BaseModel):
    ok: bool
    reason: Optional[str] = None


class MistakeStatsResponse(BaseModel):
    ok: bool
    action_stats: List[Dict[str, Any]] = []
    mistake_stats: List[Dict[str, Any]] = []
    total_rows: int = 0
