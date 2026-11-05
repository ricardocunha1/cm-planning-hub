import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.routing import Route
from starlette.types import Receive, Scope, Send

from app.api.ado_routes import router as ado_router
from app.api.plan_routes import router as plan_router
from app.api.routes import router
from app.config import get_settings
from app.db import dispose_engine, migrate_to_head, wait_for_database
from app.mcp_server.server import MCP_PATH, create_mcp_app, create_mcp_server

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """Migrate the database at startup (when `DB_MIGRATE_ON_STARTUP`), waiting
    up to `DB_STARTUP_TIMEOUT_SECONDS` for it to be reachable, and dispose the
    engine on shutdown. An unreachable database fails the startup.

    Starlette only runs this inside `with TestClient(app)`. The existing tests
    use `TestClient(app)` without `with`, so they never run it and need no DB.

    It also runs the MCP session manager. That can run only once per server
    instance, and tests enter this lifespan repeatedly, so each run builds a
    fresh MCP server and ASGI app and keeps it in `app.state.mcp_app`.
    """
    settings = get_settings()
    mcp_server = create_mcp_server()
    app.state.mcp_app = create_mcp_app(settings, mcp_server)
    try:
        if settings.db_migrate_on_startup:
            await wait_for_database(settings.db_startup_timeout_seconds)
            await migrate_to_head()
        async with mcp_server.session_manager.run():
            yield
    finally:
        app.state.mcp_app = None
        await dispose_engine()


class McpEndpoint:
    """Hand `/api/mcp` to the MCP ASGI app of the running lifespan. An exact
    route (not a mount) so the path is served without a trailing-slash
    redirect. A class, because Starlette wraps plain functions as request
    handlers (GET only) instead of treating them as ASGI apps."""

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        mcp_app = getattr(scope["app"].state, "mcp_app", None)
        if mcp_app is None:
            response = JSONResponse(status_code=503, content={"errors": ["The MCP endpoint is not running."]})
            await response(scope, receive, send)
            return
        await mcp_app(scope, receive, send)


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
    app.router.routes.append(Route(MCP_PATH, endpoint=McpEndpoint()))
    return app


app = create_app()
