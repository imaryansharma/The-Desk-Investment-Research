"""LLM endpoints. Phase 1 exposed a thin proxy; Phase 2 adds orchestrated
endpoints that fetch market data, load memory, assemble the prompt, apply
the safety gate + calibration, save to the journal — one call, full pipeline."""
import json
import logging
import re
import time
from typing import Any, Dict, Optional

from fastapi import APIRouter, HTTPException

from .. import ai, decision, journal as jsvc, market, prompts
from ..schemas import (
    AnalyzeRequest,
    AnalyzeResponse,
    BriefResponse,
    PortfolioAnalyzeRequest,
    PortfolioAnalyzeResponse,
    ScreenAnalyzeRequest,
    ScreenAnalyzeResponse,
    StockAnalyzeFullRequest,
    StockAnalyzeFullResponse,
)

log = logging.getLogger("desk.routes.analyze")
router = APIRouter(prefix="/analyze")


def _extract_json(text: str) -> Dict[str, Any]:
    cleaned = re.sub(r"```(?:json)?\s*|```", "", text).strip()
    start = cleaned.find("{")
    end = cleaned.rfind("}")
    if start == -1 or end == -1:
        raise ValueError("No JSON object in LLM response")
    return json.loads(cleaned[start : end + 1])


def _format_price(price: Optional[float], currency: str = "INR") -> str:
    if price is None:
        return "—"
    sym = "₹" if currency == "INR" else "$" if currency == "USD" else f"{currency} "
    return f"{sym}{price:,.2f}"


def _format_change_pct(pct: Optional[float]) -> str:
    if pct is None:
        return "—"
    sign = "+" if pct >= 0 else ""
    return f"{sign}{pct:.2f}%"


# ============================================================
# Phase 1 — thin proxy (kept for backward compatibility)
# ============================================================
@router.post("/stock", response_model=AnalyzeResponse)
async def analyze_stock_proxy(req: AnalyzeRequest):
    try:
        text, provider, model, latency = await ai.analyze(
            prompt=req.prompt,
            provider=req.provider,
            max_tokens=req.max_tokens,
            temperature=req.temperature,
            use_search=req.use_search,
        )
        return AnalyzeResponse(ok=True, text=text, provider_used=provider, model_used=model, latency_ms=latency)
    except ai.LLMError as e:
        raise HTTPException(status_code=e.status or 500, detail=str(e))
    except Exception as e:
        log.exception("analyze.stock.proxy.failed")
        raise HTTPException(status_code=500, detail=str(e))


# ============================================================
# Phase 2 — orchestrated stock deep-dive
# ============================================================
@router.post("/stock/full", response_model=StockAnalyzeFullResponse)
async def analyze_stock_full(req: StockAnalyzeFullRequest):
    """One-shot pipeline: Yahoo → memory → LLM → safety gate → calibrate → journal save."""
    start = time.time()
    t = req.ticker.strip().upper()
    if not t:
        raise HTTPException(status_code=400, detail="ticker required")

    # 1. Fetch market data + memory in parallel
    market_data: Dict[str, Any] = {}
    try:
        quote = await market.get_quote(t)
        history = await market.get_history(t, "5y", "1mo")
        rets = _compute_returns(history)
        price_history = [round(p["close"], 2) for p in history[-24:]]
        market_data = {"quote": quote, "history": history, "returns": rets, "priceHistory": price_history}
    except Exception as e:
        log.warning("analyze.stock_full.market_fail", extra={"ticker": t, "reason": str(e)})

    prior_ticker = jsvc.list_for_ticker(t, 5) if jsvc.is_ready() else []
    global_misses = jsvc.list_recent_misses(5) if jsvc.is_ready() else []
    ticker_misses = jsvc.list_misses_for_ticker(t, 3) if jsvc.is_ready() else []
    stats = jsvc.get_mistake_stats(500) if jsvc.is_ready() else None

    memory_block = jsvc.format_memory_for_prompt(prior_ticker, global_misses, stats)
    prompt = prompts.build_stock_deepdive_prompt(t, req.horizon, market_data or None, memory_block)

    # 2. LLM
    try:
        text, provider_used, model_used, _ = await ai.analyze(
            prompt=prompt,
            provider=req.provider,
            max_tokens=3200,
            temperature=0.4,
            use_search=req.use_search,
        )
    except ai.LLMError as e:
        raise HTTPException(status_code=e.status or 500, detail=str(e))

    try:
        parsed = _extract_json(text)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"LLM returned invalid JSON: {e}")

    # 3. Safety gate + calibration
    gate = decision.apply_safety_gate(parsed, market_data or None, ticker_misses)
    conf = decision.calibrate_confidence(parsed, market_data or None, gate, ticker_misses)

    # 4. Merge: live market on top, final rec is post-gate
    merged: Dict[str, Any] = dict(parsed)
    merged["ticker"] = t
    merged["horizon"] = req.horizon
    merged["recommendation"] = gate["finalRec"]
    merged["originalRecommendation"] = gate["originalRec"]
    merged["safetyGate"] = gate
    merged["statedConfidence"] = conf["stated"]
    merged["confidence"] = conf["calibrated"] if conf["calibrated"] is not None else parsed.get("confidence")
    merged["confidenceCalibration"] = conf
    merged["promptVersion"] = jsvc.PROMPT_VERSION
    if market_data:
        q = market_data["quote"]
        merged["companyName"] = q.get("name") or parsed.get("companyName")
        merged["currentPrice"] = _format_price(q.get("price"), q.get("currency") or "INR")
        merged["dayChange"] = _format_change_pct(q.get("changePct"))
        merged["priceHistory"] = market_data.get("priceHistory")
        merged["returns"] = market_data.get("returns")

    # 5. Journal save (fire-and-log, but blocking so we return the id)
    journal_saved = False
    journal_id: Optional[str] = None
    if req.save_to_journal and jsvc.is_ready():
        payload = {
            "ticker": t,
            "companyName": merged.get("companyName"),
            "provider": provider_used,
            "horizon": req.horizon,
            "priceAtAnalysis": (market_data.get("quote") or {}).get("price") if market_data else None,
            "currency": (market_data.get("quote") or {}).get("currency", "INR") if market_data else "INR",
            "recommendation": merged["recommendation"],
            "confidence": conf["calibrated"],
            "statedConfidence": conf["stated"],
            "calibratedConfidence": conf["calibrated"],
            "risk": merged.get("risk"),
            "fairValue": merged.get("fairValue"),
            "buyRange": merged.get("buyRange"),
            "summary": merged.get("summary"),
            "reasoning": merged.get("reasoning"),
            "bullCase": merged.get("bullCase"),
            "bearCase": merged.get("bearCase"),
            "fullData": parsed,
            "recordType": "stock_deepdive",
            "marketRegime": merged.get("marketRegime"),
            "modelVersion": model_used,
            "promptVersion": jsvc.PROMPT_VERSION,
            "grounded": (provider_used or "").lower() == "gemini",
            "invalidators": merged.get("invalidators"),
            "recheckTriggers": merged.get("recheckTriggers"),
            "priorMistakesConsidered": merged.get("priorMistakesConsidered"),
            "safetyGate": gate,
        }
        save_res = jsvc.save_analysis(payload)
        journal_saved = save_res.get("ok", False)
        journal_id = save_res.get("id")

    latency_ms = int((time.time() - start) * 1000)
    log.info(
        "analyze.stock_full.ok",
        extra={
            "ticker": t,
            "provider": provider_used,
            "model": model_used,
            "downgraded": gate["downgraded"],
            "latency_ms": latency_ms,
            "prior_ticker": len(prior_ticker),
            "global_misses": len(global_misses),
        },
    )

    return StockAnalyzeFullResponse(
        ok=True,
        data=merged,
        safety_gate=gate,
        confidence_calibration=conf,
        journal_saved=journal_saved,
        journal_id=journal_id,
        memory_used={
            "prior_ticker": len(prior_ticker),
            "global_misses": len(global_misses),
            "mistake_categories": len((stats or {}).get("mistake_stats", [])) if stats else 0,
        },
        provider_used=provider_used,
        model_used=model_used,
        latency_ms=latency_ms,
    )


def _compute_returns(history) -> Dict[str, Optional[str]]:
    """Mirrors computeReturns in src/market.js — used by orchestrated flow."""
    from datetime import datetime, timedelta
    if not history or len(history) < 2:
        return {}
    last = history[-1]
    try:
        today = datetime.fromisoformat(last["date"])
    except Exception:
        return {}
    price = last["close"]

    def find_at_or_before(target):
        best = None
        for p in history:
            try:
                d = datetime.fromisoformat(p["date"])
            except Exception:
                continue
            if d <= target:
                best = p
            else:
                break
        return best

    def pct(past):
        if not past or not past.get("close"):
            return None
        return (price - past["close"]) / past["close"] * 100

    def cagr(past, years):
        if not past or not past.get("close"):
            return None
        return ((price / past["close"]) ** (1 / years) - 1) * 100

    def fmt(v, suffix=""):
        if v is None:
            return None
        sign = "+" if v >= 0 else ""
        return f"{sign}{v:.1f}%{suffix}"

    return {
        "1M": fmt(pct(find_at_or_before(today - timedelta(days=30)))),
        "3M": fmt(pct(find_at_or_before(today - timedelta(days=90)))),
        "6M": fmt(pct(find_at_or_before(today - timedelta(days=180)))),
        "1Y": fmt(pct(find_at_or_before(today - timedelta(days=365)))),
        "3Y": fmt(cagr(find_at_or_before(today - timedelta(days=365 * 3)), 3), " CAGR"),
        "5Y": fmt(cagr(find_at_or_before(today - timedelta(days=365 * 5)), 5), " CAGR"),
    }


# ============================================================
# Phase 2 — portfolio consultant
# ============================================================
@router.post("/portfolio", response_model=PortfolioAnalyzeResponse)
async def analyze_portfolio(req: PortfolioAnalyzeRequest):
    start = time.time()
    global_misses = jsvc.list_recent_misses(5) if jsvc.is_ready() else []
    stats = jsvc.get_mistake_stats(500) if jsvc.is_ready() else None
    memory_block = jsvc.format_memory_for_prompt([], global_misses, stats)

    holdings = {
        "stocks": [s.model_dump(exclude_none=True) for s in req.stocks],
        "funds": [f.model_dump(exclude_none=True) for f in req.funds],
        "cash": req.cash,
    }
    prompt = prompts.build_portfolio_prompt(
        holdings, req.goals.model_dump(exclude_none=True) if req.goals else None, memory_block
    )

    try:
        text, provider_used, model_used, _ = await ai.analyze(
            prompt=prompt, provider=req.provider, max_tokens=3200, temperature=0.4, use_search=req.use_search,
        )
        parsed = _extract_json(text)
    except ai.LLMError as e:
        raise HTTPException(status_code=e.status or 500, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))

    journal_saved = False
    journal_id: Optional[str] = None
    if req.save_to_journal and jsvc.is_ready():
        save_res = jsvc.save_analysis({
            "ticker": "PORTFOLIO",
            "recordType": "portfolio",
            "provider": provider_used,
            "modelVersion": model_used,
            "promptVersion": jsvc.PROMPT_VERSION,
            "grounded": (provider_used or "").lower() == "gemini",
            "summary": parsed.get("summary"),
            "recommendation": None,
            "reasoning": parsed.get("reasoning"),
            "invalidators": parsed.get("invalidators"),
            "recheckTriggers": parsed.get("recheckTriggers"),
            "priorMistakesConsidered": parsed.get("priorMistakesConsidered"),
            "fullData": parsed,
        })
        journal_saved = save_res.get("ok", False)
        journal_id = save_res.get("id")

    return PortfolioAnalyzeResponse(
        ok=True,
        data=parsed,
        journal_saved=journal_saved,
        journal_id=journal_id,
        provider_used=provider_used,
        model_used=model_used,
        latency_ms=int((time.time() - start) * 1000),
    )


# ============================================================
# Phase 2 — thematic screening
# ============================================================
@router.post("/screen", response_model=ScreenAnalyzeResponse)
async def analyze_screen(req: ScreenAnalyzeRequest):
    start = time.time()
    global_misses = jsvc.list_recent_misses(5) if jsvc.is_ready() else []
    stats = jsvc.get_mistake_stats(500) if jsvc.is_ready() else None
    memory_block = jsvc.format_memory_for_prompt([], global_misses, stats)

    prompt = prompts.build_screen_prompt(req.theme, req.criteria, memory_block)
    try:
        text, provider_used, model_used, _ = await ai.analyze(
            prompt=prompt, provider=req.provider, max_tokens=3000, temperature=0.5, use_search=req.use_search,
        )
        parsed = _extract_json(text)
    except ai.LLMError as e:
        raise HTTPException(status_code=e.status or 500, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))

    journal_saved = False
    journal_id: Optional[str] = None
    if req.save_to_journal and jsvc.is_ready():
        save_res = jsvc.save_analysis({
            "ticker": "SCREEN",
            "recordType": "screen",
            "provider": provider_used,
            "modelVersion": model_used,
            "promptVersion": jsvc.PROMPT_VERSION,
            "grounded": (provider_used or "").lower() == "gemini",
            "summary": f"{req.theme}" + (f" · {req.criteria}" if req.criteria else ""),
            "fullData": parsed,
        })
        journal_saved = save_res.get("ok", False)
        journal_id = save_res.get("id")

    return ScreenAnalyzeResponse(
        ok=True,
        data=parsed,
        journal_saved=journal_saved,
        journal_id=journal_id,
        provider_used=provider_used,
        model_used=model_used,
        latency_ms=int((time.time() - start) * 1000),
    )
