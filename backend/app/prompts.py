"""Prompt templates. Kept as pure functions so tests/refactors don't touch
FastAPI or Supabase. Bump PROMPT_VERSION in journal.py when the schema
changes materially so we can filter memory by prompt version later."""
from typing import Any, Dict, List, Optional


def build_stock_deepdive_prompt(
    ticker: str,
    horizon: str,
    market: Optional[Dict[str, Any]],
    memory_block: str,
) -> str:
    """Deep-dive prompt — mirrors the shape used by the frontend so the
    schema of the LLM response is identical whether assembled here or client-side."""
    ctx_lines = ""
    if market and market.get("quote"):
        q = market["quote"]
        rets = market.get("returns") or {}
        ctx_lines = "\n".join([
            "Live market data (verified, do NOT re-search prices):",
            f"- Company: {q.get('name')}",
            f"- Current price: {q.get('currency') or 'INR'} "
            f"{q['price']:.2f}" if q.get("price") is not None else "- Current price: unavailable",
            f"- Day change: {q['changePct']:.2f}%" if q.get("changePct") is not None else "- Day change: unavailable",
            f"- 1M: {rets.get('1M') or 'n/a'}, 1Y: {rets.get('1Y') or 'n/a'}, 5Y: {rets.get('5Y') or 'n/a'}",
        ])

    return f"""You are a disciplined equity analyst. {horizon} outlook for {ticker.upper()}.

{ctx_lines}
{memory_block}
Use web search for: recent quarterly results, analyst consensus, promoter/FII holding, upcoming catalysts, peer valuations. Do NOT re-fetch prices — use the live numbers above.

DECISION DISCIPLINE (read before choosing a recommendation):
- Prefer WATCH over BUY when evidence is thin, verifications are missing, or setup resembles a prior MISS with no material change.
- Every actionable call (BUY/AVOID/EXIT) MUST have at least 2 explicit invalidators and at least 1 recheck trigger.
- If any critical fundamental is "unavailable", either downgrade confidence or set recommendation to WATCH.

Return ONLY valid JSON, no fences:
{{
  "sector": "sector name",
  "marketCap": "e.g. Rs 5.2L Cr",
  "recommendation": "BUY|HOLD|WATCH|AVOID",
  "confidence": "0-100",
  "risk": "Low|Medium|High",
  "fairValue": "target price with currency",
  "upside": "percent upside",
  "expectedCAGR": "annualized return expectation",
  "summary": "3-sentence investment thesis",
  "fundamentals": {{"revenueGrowth":"","profitGrowth":"","roe":"","roce":"","debtToEquity":"","pe":"","pb":"","dividendYield":"","promoterHolding":"","fiiHolding":""}},
  "bullCase": ["3 drivers"],
  "bearCase": ["3 risks"],
  "catalysts": ["2-3 upcoming events"],
  "peers": [{{"name":"","pe":"","roe":""}}],
  "entryStrategy": "how to build a position",
  "buyRange": "ideal accumulation range",
  "scores": {{"fundamental":"0-10","technical":"0-10","sentiment":"0-10","overall":"0-10"}},
  "marketRegime": "1-line description of current regime (rate cycle / sector cycle / sentiment)",
  "invalidators": ["specific events or datapoints that would break this thesis"],
  "recheckTriggers": [{{"event":"what to watch for","byWhen":"quarter or date"}}],
  "priorMistakesConsidered": [{{"pattern":"which past mistake pattern","howAvoided":"why THIS call won't repeat it"}}],
  "reasoning": {{
    "considered": ["what data / signals I evaluated"],
    "couldntVerify": ["what I could not confirm"],
    "assumptions": ["explicit assumptions made"],
    "changesFromPrior": "if past calls exist, what changed and why (or 'no change')"
  }}
}}

Be specific. Use "unavailable" if a datapoint can't be verified. Never fabricate. Do NOT include priceHistory or returns fields — those come from live data. If prior calls are in memory above, reference them explicitly in reasoning.changesFromPrior AND priorMistakesConsidered."""


def build_portfolio_prompt(
    holdings: Dict[str, Any],
    goals: Optional[Dict[str, Any]],
    memory_block: str,
) -> str:
    """Consultative portfolio review. Reasons about concentration, sector overlap,
    cash buffer, tax impact, liquidity, and produces per-holding rebalancing actions
    with the same audit trail schema as stock deep-dive."""
    stocks = holdings.get("stocks") or []
    funds = holdings.get("funds") or []
    cash = holdings.get("cash") or 0

    stock_lines = "\n".join(
        f"- {s.get('name') or s.get('ticker')}: {s.get('qty', 0)} × ₹{s.get('avgCost', 0)}"
        + (f" — sector: {s.get('sector')}" if s.get("sector") else "")
        for s in stocks
    ) or "(no stock holdings)"
    fund_lines = "\n".join(f"- {f.get('name')}: ₹{f.get('value', 0)}" for f in funds) or "(no fund holdings)"

    goals_block = ""
    if goals:
        parts = []
        if goals.get("horizon"):     parts.append(f"- Horizon: {goals['horizon']}")
        if goals.get("targetReturn"):parts.append(f"- Target return: {goals['targetReturn']}")
        if goals.get("emergencyCash"): parts.append(f"- Emergency-cash target: {goals['emergencyCash']}")
        if goals.get("liquidityNeed"):parts.append(f"- Near-term liquidity need: {goals['liquidityNeed']}")
        if goals.get("taxRegime"):   parts.append(f"- Tax regime: {goals['taxRegime']}")
        if parts:
            goals_block = "GOALS & CONSTRAINTS:\n" + "\n".join(parts) + "\n"

    return f"""You are a disciplined finance consultant reviewing a personal portfolio. Act like a fiduciary — protect capital first, grow it second.

HOLDINGS:
STOCKS:
{stock_lines}

FUNDS:
{fund_lines}

CASH: ₹{cash}

{goals_block}{memory_block}
Use web search for current prices, sector classification, recent news on each holding.

CONSULTATIVE FRAMEWORK — reason through ALL of these before producing rebalancing actions:
1. Concentration risk (single-name, single-sector) — flag anything >15% of equity portion
2. Sector overlap across funds + direct stocks
3. Cash buffer adequacy vs stated emergency / liquidity needs
4. Downside risk under a 20% market drawdown
5. Tax impact of any recommended sell (LTCG > 1Y, STCG < 1Y, harvest opportunities)
6. Whether risk-adjusted return (Sharpe-ish) improves after rebalancing
7. Actions must be ADD / HOLD / REDUCE / EXIT with a clear reason each

Return ONLY valid JSON:
{{
  "portfolioValue": "total in ₹",
  "allocation": {{"equity":"%", "debt":"%", "cash":"%", "other":"%"}},
  "riskMetrics": {{"estimatedBeta":"", "concentrationRisk":"Low|Medium|High", "geographicRisk":"", "drawdownEstimate":"% under -20% market"}},
  "concentration": [{{"kind":"stock|sector|fund", "name":"", "pctOfEquity":"", "verdict":"OK|WATCH|REDUCE"}}],
  "sectorOverlap": ["specific overlaps between funds + stocks"],
  "cashBuffer": {{"adequate": true, "months": "N months of expenses", "gap":"if under target"}},
  "strengths": ["what's working"],
  "concerns": ["specific issues to fix"],
  "rebalancing": [
    {{"action":"REDUCE|ADD|EXIT|HOLD", "holding":"name", "reason":"why", "targetAllocation":"...", "taxImpact":"LTCG/STCG note if selling"}}
  ],
  "gaps": ["missing exposures — e.g. no international, no small cap"],
  "taxOptimization": ["specific tax-loss harvesting or LTCG suggestions"],
  "summary": "3-sentence consultant view",
  "invalidators": ["what would invalidate this plan"],
  "recheckTriggers": [{{"event":"","byWhen":""}}],
  "priorMistakesConsidered": [{{"pattern":"","howAvoided":""}}],
  "reasoning": {{"considered":[], "couldntVerify":[], "assumptions":[]}}
}}

Be specific. Reference actual holdings by name. Prefer HOLD over EXIT when tax impact is significant unless thesis is broken. If a fundamental is unavailable, say so — do not fabricate."""


def build_screen_prompt(
    theme: str,
    criteria: Optional[str],
    memory_block: str,
) -> str:
    return f"""You are a disciplined equity screener for Indian markets.

THEME: {theme}
{('CRITERIA: ' + criteria) if criteria else ''}
{memory_block}
Use web search to find real Indian-listed stocks matching this theme.

Return ONLY valid JSON:
{{
  "methodology": "1-2 sentences on how you screened",
  "topPicks": [
    {{
      "ticker": "...",
      "name": "...",
      "sector": "...",
      "marketCap": "...",
      "currentPrice": "...",
      "keyMetrics": {{"roe":"", "roce":"", "de":"", "pe":""}},
      "whyItFits": "1-2 sentence rationale",
      "risks": "1 line",
      "suggestedAction": "BUY|WATCH|RESEARCH",
      "invalidators": ["what would remove this from the screen"]
    }}
  ],
  "honorableMentions": [{{"ticker":"", "name":"", "note":""}}],
  "avoidList": [{{"ticker":"", "name":"", "reason":""}}]
}}

Return 5-8 top picks. Real, verifiable Indian stocks only. If a metric is unavailable, use "unavailable"."""


def build_daily_brief_prompt(memory_block: str) -> str:
    return f"""You are an Indian market strategist producing today's opening brief.

{memory_block}
Use web search for: today's Nifty/Sensex levels, FII/DII flows, global markets, macro data, top news.

Return ONLY valid JSON:
{{
  "date": "YYYY-MM-DD",
  "indices": {{"nifty":"", "sensex":"", "niftyBank":""}},
  "flows": {{"fii":"", "dii":"", "date":"", "interpretation":""}},
  "global": [{{"name":"", "value":"", "changePct":""}}],
  "macro": {{"repoRate":"", "cpi":"", "usdInr":"", "crude":""}},
  "news": [{{"headline":"", "impact":"positive|negative|neutral", "summary":""}}],
  "watchlist": ["3-5 specific things to track today"],
  "focusStocks": [{{"ticker":"", "name":"", "change":"", "reason":""}}]
}}

Include 3-5 news items, 3-5 watchlist items, 3-5 focus stocks. Real numbers from live search. If a field is unavailable, use "unavailable" — never fabricate."""
