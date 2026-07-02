"""Yahoo Finance proxy. In Phase 1 the frontend can start using these
endpoints instead of hitting Yahoo directly (which relies on a CORS proxy)."""
import logging

from fastapi import APIRouter, HTTPException, Query

from .. import market
from ..schemas import HistoryPoint, HistoryResponse, QuoteResponse

log = logging.getLogger("desk.routes.market")
router = APIRouter(prefix="/market")


@router.get("/quote", response_model=QuoteResponse)
async def quote(ticker: str = Query(..., min_length=1, max_length=32)):
    try:
        q = await market.get_quote(ticker)
        return QuoteResponse(**q)
    except market.YahooError as e:
        raise HTTPException(status_code=502, detail=f"yahoo error: {e}")
    except Exception as e:
        log.exception("quote.failed", extra={"ticker": ticker})
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/history", response_model=HistoryResponse)
async def history(
    ticker: str = Query(..., min_length=1, max_length=32),
    range_: str = Query("5y", alias="range"),
    interval: str = Query("1mo"),
):
    try:
        rows = await market.get_history(ticker, range_, interval)
        return HistoryResponse(
            ticker=ticker.upper(),
            symbol=market.to_yahoo_symbol(ticker),
            points=[HistoryPoint(**r) for r in rows],
        )
    except market.YahooError as e:
        raise HTTPException(status_code=502, detail=f"yahoo error: {e}")
    except Exception as e:
        log.exception("history.failed", extra={"ticker": ticker})
        raise HTTPException(status_code=500, detail=str(e))
