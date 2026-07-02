"""Yahoo Finance client. Mirrors src/market.js so the frontend can migrate
to backend calls without behaviour changes."""
import logging
import re
from typing import Any, Dict, List, Optional

import httpx
from tenacity import retry, stop_after_attempt, wait_exponential, retry_if_exception_type

from .config import get_settings

log = logging.getLogger("desk.market")

# NSE / index / commodity aliases — same map as market.js.
SPECIAL_MAP: Dict[str, str] = {
    "NIFTY": "^NSEI", "NIFTY50": "^NSEI",
    "SENSEX": "^BSESN", "BANKNIFTY": "^NSEBANK", "INDIAVIX": "^INDIAVIX",
    "NIFTYIT": "^CNXIT", "NIFTYBANK": "^NSEBANK",
    "NIFTYAUTO": "^CNXAUTO", "NIFTYPHARMA": "^CNXPHARMA",
    "DOW": "^DJI", "DOWJONES": "^DJI", "SP500": "^GSPC", "NASDAQ": "^IXIC",
    "USDINR": "INR=X", "CRUDE": "CL=F", "GOLD": "GC=F",
}


def to_yahoo_symbol(ticker: str) -> str:
    if not ticker:
        return ""
    raw = str(ticker).upper().strip()
    if raw.startswith("^"):
        return raw
    key = re.sub(r"[\s\-_&]", "", raw)
    if key in SPECIAL_MAP:
        return SPECIAL_MAP[key]
    if "=" in raw or raw.endswith(".NS") or raw.endswith(".BO"):
        return raw
    cleaned = raw.replace("&", "_")
    return f"{cleaned}.NS"


class YahooError(Exception):
    pass


@retry(
    stop=stop_after_attempt(3),
    wait=wait_exponential(multiplier=1, min=1, max=5),
    retry=retry_if_exception_type((httpx.TransportError, YahooError)),
    reraise=True,
)
async def _yahoo_get(path: str) -> Dict[str, Any]:
    settings = get_settings()
    url = f"{settings.yahoo_host}{path}"
    async with httpx.AsyncClient(timeout=15.0) as client:
        r = await client.get(
            url,
            headers={"User-Agent": "Mozilla/5.0 (compatible; DeskBackend/0.1)"},
        )
        if r.status_code >= 500:
            raise YahooError(f"yahoo {r.status_code}")
        if r.status_code >= 400:
            raise YahooError(f"yahoo {r.status_code}: {r.text[:200]}")
        return r.json()


async def get_quote(ticker: str) -> Dict[str, Any]:
    symbol = to_yahoo_symbol(ticker)
    data = await _yahoo_get(f"/v8/finance/chart/{symbol}?range=5d&interval=1d")
    result = (data.get("chart") or {}).get("result", [None])[0]
    if not result:
        raise YahooError(f"no data for {ticker}")
    meta = result.get("meta") or {}
    price = meta.get("regularMarketPrice")
    prev = meta.get("chartPreviousClose") or meta.get("previousClose") or price
    change = (price - prev) if price is not None and prev is not None else None
    change_pct = (change / prev * 100) if change is not None and prev else None
    return {
        "ticker": ticker.upper(),
        "symbol": symbol,
        "name": meta.get("longName") or meta.get("shortName") or ticker.upper(),
        "price": price,
        "previousClose": prev,
        "change": change,
        "changePct": change_pct,
        "currency": meta.get("currency") or "INR",
        "dayHigh": meta.get("regularMarketDayHigh"),
        "dayLow": meta.get("regularMarketDayLow"),
        "volume": meta.get("regularMarketVolume"),
        "exchange": meta.get("exchangeName"),
        "regularMarketTime": meta.get("regularMarketTime"),
    }


async def get_history(ticker: str, range_: str = "5y", interval: str = "1mo") -> List[Dict[str, Any]]:
    symbol = to_yahoo_symbol(ticker)
    data = await _yahoo_get(f"/v8/finance/chart/{symbol}?range={range_}&interval={interval}")
    result = (data.get("chart") or {}).get("result", [None])[0]
    if not result:
        raise YahooError(f"no history for {ticker}")
    timestamps = result.get("timestamp") or []
    closes = ((result.get("indicators") or {}).get("quote") or [{}])[0].get("close") or []
    out = []
    for t, c in zip(timestamps, closes):
        if c is not None:
            out.append({"date": _iso_from_epoch(t), "close": float(c)})
    return out


def _iso_from_epoch(ts: int) -> str:
    from datetime import datetime, timezone
    return datetime.fromtimestamp(ts, tz=timezone.utc).date().isoformat()
