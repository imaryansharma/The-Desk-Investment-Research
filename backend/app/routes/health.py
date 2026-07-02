"""Health check — Railway's `healthcheckPath` points here."""
from fastapi import APIRouter

from ..config import get_settings
from ..schemas import HealthResponse

router = APIRouter()


@router.get("/health", response_model=HealthResponse)
async def health() -> HealthResponse:
    s = get_settings()
    return HealthResponse(
        ok=True,
        providers={"gemini": s.has_gemini, "groq": s.has_groq},
        journal_ready=s.journal_ready,
    )
