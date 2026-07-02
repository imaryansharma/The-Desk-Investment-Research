"""LLM orchestrator. Routes to Gemini (grounded) or Groq (fast, no search).
Handles model fallback + retries on transient errors. In Phase 1 this is a
straight proxy — the client sends an assembled prompt. Phase 2 will move
prompt assembly + memory injection into this layer."""
import asyncio
import logging
import time
from typing import Optional, Tuple

import httpx

from .config import get_settings

log = logging.getLogger("desk.ai")

GEMINI_MODELS = ["gemini-2.5-flash-lite", "gemini-2.5-flash", "gemini-2.0-flash"]
GROQ_MODELS = ["llama-3.3-70b-versatile", "llama-3.1-8b-instant"]

RETRYABLE_STATUS = {429, 500, 502, 503}


class LLMError(Exception):
    def __init__(self, msg: str, status: Optional[int] = None):
        super().__init__(msg)
        self.status = status


async def _gemini_call(model: str, prompt: str, max_tokens: int, temperature: float, use_search: bool) -> str:
    settings = get_settings()
    if not settings.gemini_api_key:
        raise LLMError("GEMINI_API_KEY not configured", status=400)
    url = (
        "https://generativelanguage.googleapis.com/v1beta/models/"
        f"{model}:generateContent?key={settings.gemini_api_key}"
    )
    body = {
        "contents": [{"role": "user", "parts": [{"text": prompt}]}],
        "generationConfig": {
            "maxOutputTokens": max_tokens,
            "temperature": temperature,
            # Disable thinking on 2.5 series — saves 3-6s per call.
            "thinkingConfig": {"thinkingBudget": 0},
        },
    }
    if use_search:
        body["tools"] = [{"google_search": {}}]

    async with httpx.AsyncClient(timeout=60.0) as client:
        r = await client.post(url, json=body)
    if r.status_code in RETRYABLE_STATUS:
        raise LLMError(f"gemini transient {r.status_code}", status=r.status_code)
    if r.status_code >= 400:
        raise LLMError(f"gemini {r.status_code}: {r.text[:300]}", status=r.status_code)
    data = r.json()
    cand = (data.get("candidates") or [{}])[0]
    parts = ((cand.get("content") or {}).get("parts")) or []
    text = "\n".join(p.get("text", "") for p in parts if p.get("text"))
    if not text:
        raise LLMError("gemini empty response", status=502)
    return text


async def _groq_call(model: str, prompt: str, max_tokens: int, temperature: float) -> str:
    settings = get_settings()
    if not settings.groq_api_key:
        raise LLMError("GROQ_API_KEY not configured", status=400)
    body = {
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": max_tokens,
        "temperature": temperature,
        "response_format": {"type": "json_object"},
    }
    async with httpx.AsyncClient(timeout=60.0) as client:
        r = await client.post(
            "https://api.groq.com/openai/v1/chat/completions",
            json=body,
            headers={"Authorization": f"Bearer {settings.groq_api_key}"},
        )
    if r.status_code in RETRYABLE_STATUS:
        raise LLMError(f"groq transient {r.status_code}", status=r.status_code)
    if r.status_code >= 400:
        raise LLMError(f"groq {r.status_code}: {r.text[:300]}", status=r.status_code)
    data = r.json()
    text = ((data.get("choices") or [{}])[0].get("message") or {}).get("content", "")
    if not text:
        raise LLMError("groq empty response", status=502)
    return text


async def analyze(prompt: str, provider: Optional[str], max_tokens: int, temperature: float, use_search: bool) -> Tuple[str, str, str, int]:
    """Returns (text, provider_used, model_used, latency_ms). Falls back through
    model list on transient errors. Groq is used only if it's the explicit
    provider — Gemini's grounding is preferred for research-grade output."""
    settings = get_settings()
    pv = (provider or settings.llm_provider or "gemini").lower()
    if pv not in {"gemini", "groq"}:
        pv = "gemini"

    start = time.time()
    models = GROQ_MODELS if pv == "groq" else GEMINI_MODELS
    last_err: Optional[str] = None
    for m in models:
        for attempt in range(3):
            try:
                text = (
                    await _groq_call(m, prompt, max_tokens, temperature)
                    if pv == "groq"
                    else await _gemini_call(m, prompt, max_tokens, temperature, use_search)
                )
                latency = int((time.time() - start) * 1000)
                log.info("llm.ok", extra={"provider": pv, "model": m, "latency_ms": latency, "attempts": attempt + 1})
                return text, pv, m, latency
            except LLMError as e:
                last_err = str(e)
                if e.status and e.status not in RETRYABLE_STATUS:
                    log.warning("llm.fatal", extra={"provider": pv, "model": m, "status": e.status})
                    raise
                # Exponential backoff before retry
                await asyncio.sleep(1 * (2 ** attempt))
            except httpx.TransportError as e:
                last_err = f"transport: {e}"
                await asyncio.sleep(1 * (2 ** attempt))
        log.warning("llm.model_exhausted", extra={"provider": pv, "model": m})
    raise LLMError(f"all {pv} models exhausted: {last_err}", status=503)
