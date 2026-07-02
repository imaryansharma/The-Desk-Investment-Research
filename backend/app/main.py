"""FastAPI app entry. Mounts the Phase 1 routers (health, market, analyze).
Phase 2+ will add: journal, notifications, watchlist, scheduler-driven briefs."""
import logging

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .config import get_settings
from .routes import analyze as analyze_route
from .routes import brief as brief_route
from .routes import health as health_route
from .routes import journal as journal_route
from .routes import market as market_route

log = logging.getLogger("desk")


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(
        title="DESK Backend",
        version="0.1.0",
        description="Railway-hosted orchestration layer for DESK. Phase 1 proxies AI + market calls.",
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins_list,
        allow_credentials=False,
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["*"],
    )

    app.include_router(health_route.router)
    app.include_router(market_route.router)
    app.include_router(analyze_route.router)
    app.include_router(journal_route.router)
    app.include_router(brief_route.router)

    @app.on_event("startup")
    async def _startup() -> None:
        log.info(
            "startup",
            extra={
                "gemini": settings.has_gemini,
                "groq": settings.has_groq,
                "journal_ready": settings.journal_ready,
                "cors": settings.cors_origins_list,
            },
        )

    return app


app = create_app()
