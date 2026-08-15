from fastapi import FastAPI
import uvicorn

from app.api.routes_calls import router as calls_router
from app.api.routes_conversations import router as conversations_router
from app.api.routes_livekit import router as livekit_router
from app.api.routes_system import router as system_router
from app.api.routes_testing import router as testing_router
from app.api.routes_ui import router as ui_router
from app.core.config import get_settings
from app.services.observability import configure_logging


def create_app() -> FastAPI:
    settings = get_settings()
    configure_logging()

    app = FastAPI(
        title=settings.app_name,
        version=settings.app_version,
        debug=settings.debug,
    )
    app.include_router(calls_router)
    app.include_router(conversations_router)
    app.include_router(livekit_router)
    app.include_router(system_router)
    app.include_router(testing_router)
    app.include_router(ui_router)
    return app


app = create_app()


def run() -> None:
    settings = get_settings()
    uvicorn.run(
        "app.main:app",
        host=settings.host,
        port=settings.port,
        reload=settings.reload,
    )
