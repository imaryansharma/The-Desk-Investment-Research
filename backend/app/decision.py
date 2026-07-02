"""Safety gate + confidence calibration — server-side port of the logic in
InvestmentDesk.jsx. Central location so orchestrated stock/portfolio/screen
endpoints all get the same discipline."""
import time
from typing import Any, Dict, List, Optional

ACTIONABLE_RECS = {"BUY", "ADD", "EXIT", "REDUCE"}
_MAX_STALE_MIN = 60 * 24  # 24h — weekends will always be "stale" by strict definition


def is_data_stale(quote: Optional[Dict[str, Any]]) -> bool:
    if not quote:
        return False
    ts = quote.get("regularMarketTime")
    if not ts:
        return False
    try:
        age_min = (time.time() - float(ts)) / 60
    except (ValueError, TypeError):
        return False
    return age_min > _MAX_STALE_MIN


def count_missing_fundamentals(fundamentals: Optional[Dict[str, Any]]) -> int:
    if not fundamentals:
        return 6
    keys = ["revenueGrowth", "profitGrowth", "roe", "roce", "debtToEquity", "pe"]
    return sum(1 for k in keys if not fundamentals.get(k) or fundamentals.get(k) == "unavailable")


def apply_safety_gate(
    parsed: Dict[str, Any],
    market: Optional[Dict[str, Any]],
    prior_misses_ticker: List[Dict[str, Any]],
) -> Dict[str, Any]:
    """Downgrade actionable calls to WATCH when evidence is thin, data stale,
    or thesis resembles a prior MISS with no acknowledged change."""
    reasons: List[str] = []
    rec = str(parsed.get("recommendation") or "").upper()
    try:
        conf = int(float(parsed.get("confidence") or 0))
    except (ValueError, TypeError):
        conf = 0
    missing = count_missing_fundamentals(parsed.get("fundamentals"))

    quote = (market or {}).get("quote") if market else None

    if not quote or quote.get("price") is None:
        reasons.append("No live price — market data fetch failed.")
    elif is_data_stale(quote):
        reasons.append("Live price is >24h stale.")

    if missing >= 4:
        reasons.append(f"{missing}/6 core fundamentals unavailable — evidence too thin for an actionable call.")

    if prior_misses_ticker:
        last = prior_misses_ticker[0]
        reasoning = parsed.get("reasoning") or {}
        change = reasoning.get("changesFromPrior") if isinstance(reasoning, dict) else None
        acknowledged = isinstance(change, str) and change.strip() and change.strip().lower() != "no change"
        if not acknowledged:
            reasons.append(
                f"Prior MISS on {last.get('ticker')} ({last.get('mistake_category') or 'uncategorized'}) "
                "— model did not describe what changed."
            )

    if conf and conf < 45 and rec in ACTIONABLE_RECS:
        reasons.append(f"Stated confidence {conf}% is too low for an actionable {rec}.")

    invalidators = parsed.get("invalidators")
    if rec in ACTIONABLE_RECS and (not isinstance(invalidators, list) or not invalidators):
        reasons.append("No invalidators specified — thesis has no falsifiable exit criteria.")

    should_downgrade = bool(reasons) and rec in ACTIONABLE_RECS
    return {
        "originalRec": rec,
        "finalRec": "WATCH" if should_downgrade else rec,
        "downgraded": should_downgrade,
        "reasons": reasons,
        "passed": len(reasons) == 0,
    }


def calibrate_confidence(
    parsed: Dict[str, Any],
    market: Optional[Dict[str, Any]],
    safety_gate: Dict[str, Any],
    prior_misses_ticker: List[Dict[str, Any]],
) -> Dict[str, Any]:
    try:
        stated = int(float(parsed.get("confidence") or 0))
    except (ValueError, TypeError):
        return {"stated": None, "calibrated": None, "deltas": []}

    c = stated
    deltas: List[str] = []
    missing = count_missing_fundamentals(parsed.get("fundamentals"))
    if missing >= 2:
        c -= missing * 5
        deltas.append(f"-{missing * 5} missing fundamentals ({missing})")
    quote = (market or {}).get("quote") if market else None
    if quote and is_data_stale(quote):
        c -= 15
        deltas.append("-15 stale market data")
    if safety_gate.get("downgraded"):
        c -= 20
        deltas.append("-20 safety-gate downgrade")
    if prior_misses_ticker:
        c -= 10
        deltas.append(f"-10 prior MISS on {prior_misses_ticker[0].get('ticker')}")
    return {"stated": stated, "calibrated": max(0, min(100, round(c))), "deltas": deltas}
