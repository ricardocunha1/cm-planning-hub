"""Synchronous helpers for the PostgreSQL tests (see conftest.py)."""
import asyncio

from alembic.config import Config
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine
from sqlalchemy.pool import NullPool

from app.db import ALEMBIC_INI


def alembic_config(url: str) -> Config:
    """An Alembic config pointed at `url` (`%` escaped for configparser)."""
    config = Config(str(ALEMBIC_INI))
    config.set_main_option("sqlalchemy.url", url.replace("%", "%%"))
    return config


def run_sql(url: str, statement: str) -> None:
    async def _run() -> None:
        engine = create_async_engine(url, poolclass=NullPool)
        try:
            async with engine.begin() as connection:
                await connection.execute(text(statement))
        finally:
            await engine.dispose()

    asyncio.run(_run())
