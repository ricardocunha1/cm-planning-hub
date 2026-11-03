import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from app.api.ado_routes import router as ado_router
from app.api.plan_routes import router as plan_router
from app.api.routes import router
from app.config import get_settings
from app.db import dispose_engine, migrate_to_head, wait_for_database

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    """Migrate the database at startup (when `DB_MIGRATE_ON_STARTUP`), waiting
    up to `DB_STARTUP_TIMEOUT_SECONDS` for it to be reachable, and dispose the
    engine on shutdown. An unreachable database fails the startup.

    Starlette only runs this inside `with TestClient(app)`. The existing tests
    use `TestClient(app)` without `with`, so they never run it and need no DB.
    """
    settings = get_settings()
    try:
        if settings.db_migrate_on_startup:
            await wait_for_database(settings.db_startup_timeout_seconds)
            await migrate_to_head()
        yield
    finally:
        await dispose_engine()


def create_app() -> FastAPI:
    app = FastAPI(title="Planning Hub API", lifespan=lifespan)

    @app.exception_handler(RequestValidationError)
    async def request_validation_error(request: Request, exc: RequestValidationError):
        # Keep every 422 in the same `{errors: [str]}` shape the client renders.
        errors = [
            f"Invalid request: {'.'.join(str(part) for part in err['loc'])}: {err['msg']}"
            for err in exc.errors()
        ]
        return JSONResponse(status_code=422, content={"errors": errors})

    @app.exception_handler(Exception)
    async def unhandled_exception(request: Request, _: Exception):
        # Anything not handled elsewhere: log the traceback server-side and
        # return a generic 500 in the same `{errors: [str]}` shape, without
        # leaking internals to the client.
        logger.exception("Unhandled error on %s %s", request.method, request.url.path)
        return JSONResponse(
            status_code=500,
            content={"errors": ["An unexpected error occurred. Please review your input historical data."]},
        )

    app.include_router(router, prefix="/api")
    app.include_router(ado_router, prefix="/api/ado")
    app.include_router(plan_router, prefix="/api/plan")
    return app


app = create_app()
