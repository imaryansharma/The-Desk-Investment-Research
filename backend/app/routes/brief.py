"""Daily brief endpoint. Grounded (Gemini) is strongly preferred here since
the brief depends entirely on real-time news + macro data."""
import json
import logging
import re
import time

from fastapi import APIRouter, HTTPException, Query

from .. import ai, prompts
from .. import journal as jsvc
from ..schemas import BriefResponse

log = logging.getLogger("desk.routes.brief")
router = APIRouter(prefix="/brief")


def _extract_json(text: str):
    cleaned = re.sub(r"```(?:json)?\s*|```", "", text).strip()
    start = cleaned.find("{")
    end = cleaned.rfind("}")
    if start == -1 or end == -1:
        raise ValueError("No JSON object in LLM response")
    return json.loads(cleaned[start : end + 1])


@router.get("/daily", response_model=BriefResponse)
async def daily(provider: str = Query("gemini")):
    start = time.time()
    # Brief is short-form and news-driven — memory injection isn't valuable here.
    memory_block = jsvc.format_memory_for_prompt([], [], None) if jsvc.is_ready() else ""
    prompt = prompts.build_daily_brief_prompt(memory_block)
    try:
        text, provider_used, model_used, _ = await ai.analyze(
            prompt=prompt, provider=provider, max_tokens=3000, temperature=0.4, use_search=True,
        )
        parsed = _extract_json(text)
    except ai.LLMError as e:
        raise HTTPException(status_code=e.status or 500, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))

    return BriefResponse(
        ok=True,
        data=parsed,
        provider_used=provider_used,
        model_used=model_used,
        latency_ms=int((time.time() - start) * 1000),
    )
