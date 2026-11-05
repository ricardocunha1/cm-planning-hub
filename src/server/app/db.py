import asyncio
import logging
import time
from collections.abc import AsyncIterator
from pathlib import Path

import asyncpg
from alembic import command
from alembic.config import Config
from sqlalchemy import text
from sqlalchemy.engine import Connection
from sqlalchemy.exc import InterfaceError, OperationalError
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker, create_async_engine

from app.config import get_settings

logger = logging.getLogger(__name__)

SERVER_ROOT = Path(__file__).resolve().parents[1]
ALEMBIC_INI = SERVER_ROOT / "alembic.ini"
RETRY_DELAY_SECONDS = 1.0

DB_UNAVAILABLE = "The release plan database is unavailable."
# Connection failures (session acquisition or a query): REST maps them to 503, MCP tools to a ToolError.
DB_ERRORS = (OperationalError, InterfaceError, OSError, asyncpg.PostgresConnectionError)

_engine: AsyncEngine | None = None
_sessionmaker: async_sessionmaker[AsyncSession] | None = None


def get_engine() -> AsyncEngine:
    """The process-wide async engine, created on first use (nothing connects
    at import time; the pool connects lazily)."""
    global _engine
    if _engine is None:
        url = get_settings().database_url()
        logger.info("Creating database engine for %s", url.render_as_string(hide_password=True))
        _engine = create_async_engine(url, pool_pre_ping=True)
    return _engine


def get_sessionmaker() -> async_sessionmaker[AsyncSession]:
    global _sessionmaker
    if _sessionmaker is None:
        _sessionmaker = async_sessionmaker(get_engine(), expire_on_commit=False)
    return _sessionmaker


async def get_session() -> AsyncIterator[AsyncSession]:
    """FastAPI dependency yielding one `AsyncSession` per request. Tests
    replace it through `app.dependency_overrides`."""
    async with get_sessionmaker()() as session:
        yield session


async def dispose_engine() -> None:
    """Close the pool and forget the engine (called on shutdown)."""
    global _engine, _sessionmaker
    if _engine is not None:
        await _engine.dispose()
    _engine = None
    _sessionmaker = None


def _upgrade_head(connection: Connection) -> None:
    config = Config(str(ALEMBIC_INI))
    config.attributes["connection"] = connection
    command.upgrade(config, "head")


async def wait_for_database(timeout_seconds: float, retry_delay: float = RETRY_DELAY_SECONDS) -> None:
    """Retry a trivial query until the database answers.

    Raises:
        OSError / SQLAlchemy errors: the last connection error once
            `timeout_seconds` have elapsed, so the startup fails.
    """
    engine = get_engine()
    target = get_settings().database_url().render_as_string(hide_password=True)
    deadline = time.monotonic() + timeout_seconds
    attempt = 0
    while True:
        attempt += 1
        try:
            async with engine.connect() as connection:
                await connection.execute(text("SELECT 1"))
            return
        except Exception as exc:
            if time.monotonic() >= deadline:
                logger.error("Database %s unreachable after %d attempt(s)", target, attempt)
                raise
            logger.warning("Database %s not ready (attempt %d): %s", target, attempt, type(exc).__name__)
            await asyncio.sleep(retry_delay)


async def migrate_to_head() -> None:
    """Run `alembic upgrade head` on the application engine."""
    async with get_engine().connect() as connection:
        await connection.run_sync(_upgrade_head)
        await connection.commit()
    logger.info("Database migrations applied (alembic upgrade head)")
