"""Journal service — server-side Supabase client. Mirrors src/journal.js so
the memory format and schema stay compatible with existing frontend writes.

The frontend can continue writing directly with the anon key while the
backend also reads/writes with the service key — both paths use the same
`analyses` table and produce identical memory blocks."""
import logging
import re
from typing import Any, Dict, List, Optional

from supabase import Client, create_client

from .config import get_settings

log = logging.getLogger("desk.journal")

# Keep in sync with MISTAKE_CATEGORIES in src/journal.js.
MISTAKE_CATEGORIES = [
    "stale_data",
    "wrong_assumption",
    "valuation_error",
    "earnings_surprise",
    "macro_shift",
    "thesis_drift",
    "data_gap",
    "concentration",
    "other",
]

PROMPT_VERSION = "v2-2026-07"

_client: Optional[Client] = None
_client_key = ""


def _get_client() -> Optional[Client]:
    """Lazy singleton — rebuilds only if config changes."""
    global _client, _client_key
    s = get_settings()
    if not s.supabase_url or not s.supabase_service_key:
        return None
    key = f"{s.supabase_url}|{s.supabase_service_key}"
    if _client is not None and _client_key == key:
        return _client
    _client = create_client(s.supabase_url, s.supabase_service_key)
    _client_key = key
    return _client


def is_ready() -> bool:
    return _get_client() is not None


def _parse_price(v: Any) -> Optional[float]:
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return float(v) if v == v else None  # reject NaN
    s = re.sub(r"[,\s₹$€£]", "", str(v))
    s = re.sub(r"^Rs\.?", "", s, flags=re.IGNORECASE)
    try:
        f = float(s)
        return f if f == f else None
    except (ValueError, TypeError):
        return None


def save_analysis(record: Dict[str, Any]) -> Dict[str, Any]:
    c = _get_client()
    if c is None:
        return {"ok": False, "reason": "not-configured"}
    row = {
        "ticker": record.get("ticker"),
        "company_name": record.get("company_name") or record.get("companyName"),
        "provider": record.get("provider"),
        "horizon": record.get("horizon"),
        "price_at_analysis": _parse_price(record.get("price_at_analysis") or record.get("priceAtAnalysis")),
        "currency": record.get("currency") or "INR",
        "recommendation": record.get("recommendation"),
        "confidence": _to_int(record.get("confidence")),
        "risk": record.get("risk"),
        "fair_value": record.get("fair_value") or record.get("fairValue"),
        "buy_range": record.get("buy_range") or record.get("buyRange"),
        "target_price": _parse_price(record.get("fair_value") or record.get("fairValue")),
        "summary": record.get("summary"),
        "reasoning": record.get("reasoning"),
        "bull_case": record.get("bull_case") or record.get("bullCase"),
        "bear_case": record.get("bear_case") or record.get("bearCase"),
        "full_data": record.get("full_data") or record.get("fullData"),
        # v2 fields
        "record_type": record.get("record_type") or record.get("recordType") or "stock_deepdive",
        "market_regime": record.get("market_regime") or record.get("marketRegime"),
        "model_version": record.get("model_version") or record.get("modelVersion"),
        "prompt_version": record.get("prompt_version") or record.get("promptVersion") or PROMPT_VERSION,
        "grounded": record.get("grounded"),
        "stated_confidence": _to_int(record.get("stated_confidence") or record.get("statedConfidence")),
        "calibrated_confidence": _to_int(record.get("calibrated_confidence") or record.get("calibratedConfidence")),
        "invalidators": record.get("invalidators"),
        "recheck_triggers": record.get("recheck_triggers") or record.get("recheckTriggers"),
        "prior_mistakes_considered": record.get("prior_mistakes_considered") or record.get("priorMistakesConsidered"),
        "safety_gate": record.get("safety_gate") or record.get("safetyGate"),
    }
    try:
        resp = c.table("analyses").insert(row).execute()
        rid = (resp.data or [{}])[0].get("id")
        log.info("journal.save.ok", extra={"ticker": row["ticker"], "record_type": row["record_type"], "id": rid})
        return {"ok": True, "id": rid}
    except Exception as e:
        log.warning("journal.save.fail", extra={"reason": str(e)})
        return {"ok": False, "reason": str(e)}


def _to_int(v: Any) -> Optional[int]:
    if v is None:
        return None
    try:
        return int(float(v))
    except (ValueError, TypeError):
        return None


def list_for_ticker(ticker: str, limit: int = 5) -> List[Dict[str, Any]]:
    c = _get_client()
    if c is None or not ticker:
        return []
    try:
        r = (
            c.table("analyses")
            .select("*")
            .eq("ticker", ticker.upper())
            .order("created_at", desc=True)
            .limit(limit)
            .execute()
        )
        return r.data or []
    except Exception as e:
        log.warning("journal.list_for_ticker.fail", extra={"reason": str(e)})
        return []


def list_recent_misses(limit: int = 5) -> List[Dict[str, Any]]:
    c = _get_client()
    if c is None:
        return []
    try:
        r = (
            c.table("analyses")
            .select("*")
            .eq("outcome", "MISS")
            .order("return_pct", desc=False)  # most negative first
            .limit(limit)
            .execute()
        )
        return r.data or []
    except Exception as e:
        log.warning("journal.list_recent_misses.fail", extra={"reason": str(e)})
        return []


def list_misses_for_ticker(ticker: str, limit: int = 3) -> List[Dict[str, Any]]:
    c = _get_client()
    if c is None or not ticker:
        return []
    try:
        r = (
            c.table("analyses")
            .select("*")
            .eq("ticker", ticker.upper())
            .eq("outcome", "MISS")
            .order("created_at", desc=True)
            .limit(limit)
            .execute()
        )
        return r.data or []
    except Exception:
        return []


def list_all(limit: int = 100, record_type: Optional[str] = None) -> List[Dict[str, Any]]:
    c = _get_client()
    if c is None:
        return []
    try:
        q = c.table("analyses").select("*").order("created_at", desc=True).limit(limit)
        if record_type:
            q = q.eq("record_type", record_type)
        return (q.execute()).data or []
    except Exception as e:
        log.warning("journal.list_all.fail", extra={"reason": str(e)})
        return []


def update_review(analysis_id: str, patch: Dict[str, Any]) -> Dict[str, Any]:
    c = _get_client()
    if c is None:
        return {"ok": False, "reason": "not-configured"}
    from datetime import datetime, timezone
    row: Dict[str, Any] = {"reviewed_at": datetime.now(timezone.utc).isoformat()}
    if "priceAtReview" in patch or "price_at_review" in patch:
        row["price_at_review"] = _parse_price(patch.get("price_at_review") or patch.get("priceAtReview"))
    if patch.get("outcome"):
        row["outcome"] = patch["outcome"]
    if "returnPct" in patch or "return_pct" in patch:
        v = patch.get("return_pct") or patch.get("returnPct")
        row["return_pct"] = float(v) if v is not None else None
    if "lessons" in patch:
        row["lessons"] = patch["lessons"] or None
    if "mistakeCategory" in patch or "mistake_category" in patch:
        row["mistake_category"] = patch.get("mistake_category") or patch.get("mistakeCategory") or None
    if "whatWasMissed" in patch or "what_was_missed" in patch:
        row["what_was_missed"] = patch.get("what_was_missed") or patch.get("whatWasMissed") or None
    if "whatToCheck" in patch or "what_to_check" in patch:
        row["what_to_check"] = patch.get("what_to_check") or patch.get("whatToCheck") or None
    if "marketRegime" in patch or "market_regime" in patch:
        row["market_regime"] = patch.get("market_regime") or patch.get("marketRegime") or None
    try:
        c.table("analyses").update(row).eq("id", analysis_id).execute()
        return {"ok": True}
    except Exception as e:
        return {"ok": False, "reason": str(e)}


def delete_analysis(analysis_id: str) -> Dict[str, Any]:
    c = _get_client()
    if c is None:
        return {"ok": False, "reason": "not-configured"}
    try:
        c.table("analyses").delete().eq("id", analysis_id).execute()
        return {"ok": True}
    except Exception as e:
        return {"ok": False, "reason": str(e)}


def get_mistake_stats(limit: int = 500) -> Optional[Dict[str, Any]]:
    """Client-side aggregation over recent rows — fine for single-user scale."""
    c = _get_client()
    if c is None:
        return None
    try:
        r = (
            c.table("analyses")
            .select("recommendation,outcome,return_pct,mistake_category,record_type")
            .order("created_at", desc=True)
            .limit(limit)
            .execute()
        )
        rows = r.data or []
    except Exception:
        return None

    by_action: Dict[str, Dict[str, Any]] = {}
    by_mistake: Dict[str, int] = {}
    for row in rows:
        a = row.get("recommendation") or "UNKNOWN"
        st = by_action.setdefault(a, {"hit": 0, "miss": 0, "pending": 0, "returns": []})
        outcome = row.get("outcome")
        if outcome == "HIT":
            st["hit"] += 1
        elif outcome == "MISS":
            st["miss"] += 1
        else:
            st["pending"] += 1
        rp = row.get("return_pct")
        if rp is not None:
            try:
                st["returns"].append(float(rp))
            except (ValueError, TypeError):
                pass
        m = row.get("mistake_category")
        if m:
            by_mistake[m] = by_mistake.get(m, 0) + 1

    action_stats = []
    for action, s in by_action.items():
        total = s["hit"] + s["miss"]
        avg = sum(s["returns"]) / len(s["returns"]) if s["returns"] else None
        action_stats.append({
            "action": action,
            "hit": s["hit"],
            "miss": s["miss"],
            "pending": s["pending"],
            "hit_rate": (s["hit"] / total * 100) if total else None,
            "avg_return": avg,
        })
    action_stats.sort(key=lambda x: (x["hit"] + x["miss"]), reverse=True)

    mistake_stats = sorted(
        [{"category": k, "count": v} for k, v in by_mistake.items()],
        key=lambda x: x["count"],
        reverse=True,
    )

    return {"action_stats": action_stats, "mistake_stats": mistake_stats, "total_rows": len(rows)}


def format_memory_for_prompt(
    prior_ticker: List[Dict[str, Any]],
    global_misses: List[Dict[str, Any]],
    mistake_stats: Optional[Dict[str, Any]] = None,
) -> str:
    """Server-side twin of formatMemoryForPrompt in src/journal.js. Output
    is bytewise-compatible so prompts produce equivalent LLM output whether
    assembled client-side or server-side."""
    lines: List[str] = []

    if prior_ticker:
        lines.append("PRIOR ANALYSES FOR THIS TICKER (most recent first):")
        for a in prior_ticker:
            when = str(a.get("created_at") or "")[:10]
            outcome = ""
            if a.get("outcome"):
                rp = a.get("return_pct")
                outcome = f" — {a['outcome']}" + (f" ({rp:.1f}%)" if rp is not None else "")
            price = ""
            if a.get("price_at_analysis") is not None:
                price = f" at {a.get('currency') or ''} {a['price_at_analysis']}"
            lines.append(
                f"- {when}: {a.get('recommendation') or '?'} ({a.get('horizon') or '?'} horizon{price}){outcome}"
            )
            if a.get("mistake_category"):
                msg = f"  mistake: {a['mistake_category']}"
                if a.get("what_was_missed"):
                    msg += f" — {a['what_was_missed']}"
                lines.append(msg)
            if a.get("what_to_check"):
                lines.append(f"  check-next-time: {a['what_to_check']}")
            if a.get("market_regime"):
                lines.append(f"  regime-then: {a['market_regime']}")
            if a.get("lessons"):
                lines.append(f"  free-form lessons: {a['lessons']}")
            reasoning = a.get("reasoning") or {}
            assumptions = reasoning.get("assumptions") if isinstance(reasoning, dict) else None
            if assumptions:
                lines.append(f"  prior assumed: {'; '.join(list(assumptions)[:3])}")

    if global_misses:
        lines.append("")
        lines.append("RECENT WORST CALLS ACROSS TICKERS (avoid these patterns):")
        for m in global_misses:
            when = str(m.get("created_at") or "")[:10]
            cat = f" [{m['mistake_category']}]" if m.get("mistake_category") else ""
            rp = m.get("return_pct")
            note = ""
            if m.get("what_was_missed"):
                note = f" — {m['what_was_missed']}"
            elif m.get("lessons"):
                note = f" — {m['lessons']}"
            lines.append(
                f"- {when} {m.get('ticker')}: {m.get('recommendation')} → "
                f"{rp:.1f}%{cat}{note}" if rp is not None else
                f"- {when} {m.get('ticker')}: {m.get('recommendation')}{cat}{note}"
            )

    if mistake_stats and mistake_stats.get("mistake_stats"):
        lines.append("")
        lines.append("MISTAKE-CATEGORY FREQUENCY (higher = more repeated by this desk):")
        for m in mistake_stats["mistake_stats"][:5]:
            lines.append(f"- {m['category']}: {m['count']} occurrence(s)")

    if not lines:
        return ""

    body = "\n".join(lines)
    return (
        f"\n\n=== MEMORY FROM PAST ANALYSES ===\n{body}\n=== END MEMORY ===\n\n"
        "Before recommending, check whether this thesis matches any pattern above. "
        "In your reasoning, populate priorMistakesConsidered with an array of {pattern, howAvoided} entries. "
        "If the current call closely resembles a prior MISS with no material change in setup, "
        "downgrade the action toward WATCH.\n"
    )
