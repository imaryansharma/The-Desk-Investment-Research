"""Journal endpoints — CRUD + aggregations over the Supabase analyses table.
Frontend can migrate to these gradually; direct Supabase writes still work."""
import logging
from typing import Optional

from fastapi import APIRouter, HTTPException, Query

from .. import journal as jsvc
from ..schemas import (
    MistakeStatsResponse,
    MutationResponse,
    ReviewRequest,
    SaveAnalysisRequest,
    SaveAnalysisResponse,
)

log = logging.getLogger("desk.routes.journal")
router = APIRouter(prefix="/journal")


def _require_journal():
    if not jsvc.is_ready():
        raise HTTPException(status_code=503, detail="Journal not configured (SUPABASE_URL / SUPABASE_SERVICE_KEY missing).")


@router.post("/save", response_model=SaveAnalysisResponse)
async def save(req: SaveAnalysisRequest):
    _require_journal()
    payload = req.model_dump(by_alias=False, exclude_none=True)
    res = jsvc.save_analysis(payload)
    if not res.get("ok"):
        return SaveAnalysisResponse(ok=False, reason=res.get("reason"))
    return SaveAnalysisResponse(ok=True, id=res.get("id"))


@router.get("/ticker/{ticker}")
async def by_ticker(ticker: str, limit: int = Query(5, ge=1, le=50)):
    _require_journal()
    return {"ok": True, "rows": jsvc.list_for_ticker(ticker, limit)}


@router.get("/ticker/{ticker}/misses")
async def ticker_misses(ticker: str, limit: int = Query(3, ge=1, le=20)):
    _require_journal()
    return {"ok": True, "rows": jsvc.list_misses_for_ticker(ticker, limit)}


@router.get("/mistakes")
async def recent_mistakes(limit: int = Query(5, ge=1, le=50)):
    _require_journal()
    return {"ok": True, "rows": jsvc.list_recent_misses(limit)}


@router.get("/all")
async def list_all(
    limit: int = Query(100, ge=1, le=500),
    record_type: Optional[str] = Query(None),
):
    _require_journal()
    return {"ok": True, "rows": jsvc.list_all(limit, record_type)}


@router.get("/stats", response_model=MistakeStatsResponse)
async def stats(limit: int = Query(500, ge=1, le=2000)):
    _require_journal()
    s = jsvc.get_mistake_stats(limit)
    if s is None:
        raise HTTPException(status_code=500, detail="stats aggregation failed")
    return MistakeStatsResponse(ok=True, **s)


@router.post("/review/{analysis_id}", response_model=MutationResponse)
async def review(analysis_id: str, req: ReviewRequest):
    _require_journal()
    res = jsvc.update_review(analysis_id, req.model_dump(exclude_none=True))
    if not res.get("ok"):
        return MutationResponse(ok=False, reason=res.get("reason"))
    return MutationResponse(ok=True)


@router.delete("/{analysis_id}", response_model=MutationResponse)
async def delete(analysis_id: str):
    _require_journal()
    res = jsvc.delete_analysis(analysis_id)
    if not res.get("ok"):
        return MutationResponse(ok=False, reason=res.get("reason"))
    return MutationResponse(ok=True)
