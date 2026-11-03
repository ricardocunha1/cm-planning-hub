import logging
import math
import os
from collections.abc import Mapping
from dataclasses import dataclass, field
from functools import lru_cache

from sqlalchemy.engine import URL

logger = logging.getLogger(__name__)

DEFAULT_ADO_ALLOWED_HOSTS = "dev.azure.com,*.visualstudio.com,tfs-projects.cmf.criticalmanufacturing.com"
DEFAULT_ADO_TIMEOUT_SECONDS = 30.0
DEFAULT_DB_HOST = "localhost"
DEFAULT_DB_PORT = 5432
DB_NAME = "planninghub"
DEFAULT_DB_STARTUP_TIMEOUT_SECONDS = 60.0


@dataclass(frozen=True)
class Settings:
    """Server settings read from the environment (see plans/release-plan-ado.md).

    `ado_allowed_hosts` is the SSRF allowlist for the Azure DevOps proxy: exact
    host names, or `*.example.com` for any subdomain of example.com.

    The `db_*` fields locate the PostgreSQL database that stores Release Plan
    boards (see plans/release-plan-persistence.md). The database name is the
    fixed constant `DB_NAME`, not configurable. The password is kept out of
    `repr` so it never reaches logs.
    """

    ado_allowed_hosts: tuple[str, ...]
    ado_timeout_seconds: float
    db_host: str = DEFAULT_DB_HOST
    db_port: int = DEFAULT_DB_PORT
    db_user: str = ""
    db_password: str = field(default="", repr=False)
    db_migrate_on_startup: bool = True
    db_startup_timeout_seconds: float = DEFAULT_DB_STARTUP_TIMEOUT_SECONDS

    @classmethod
    def from_env(cls, environ: Mapping[str, str] | None = None) -> "Settings":
        env = os.environ if environ is None else environ
        return cls(
            ado_allowed_hosts=parse_allowed_hosts(env.get("ADO_ALLOWED_HOSTS")),
            ado_timeout_seconds=_parse_timeout(env.get("ADO_TIMEOUT_SECONDS")),
            db_host=(env.get("DB_HOST") or "").strip() or DEFAULT_DB_HOST,
            db_port=_parse_port(env.get("DB_PORT")),
            db_user=env.get("DB_USER") or "",
            db_password=env.get("DB_PASSWORD") or "",
            db_migrate_on_startup=_parse_bool(env.get("DB_MIGRATE_ON_STARTUP"), True, "DB_MIGRATE_ON_STARTUP"),
            db_startup_timeout_seconds=_parse_positive_float(
                env.get("DB_STARTUP_TIMEOUT_SECONDS"),
                DEFAULT_DB_STARTUP_TIMEOUT_SECONDS,
                "DB_STARTUP_TIMEOUT_SECONDS",
            ),
        )

    def database_url(self) -> URL:
        """The asyncpg connection URL, always for the `DB_NAME` database. `URL.create` escapes special characters
        in the credentials; render it with `hide_password=True` when logging."""
        return URL.create(
            drivername="postgresql+asyncpg",
            username=self.db_user or None,
            password=self.db_password or None,
            host=self.db_host,
            port=self.db_port,
            database=DB_NAME,
        )


def parse_allowed_hosts(raw: str | None) -> tuple[str, ...]:
    """Split a comma-separated host list: entries trimmed, lower-cased, blanks
    dropped. A value with no entries (unset, blank, ",,") means the default
    list, since an empty allowlist would silently refuse every host."""
    entries = tuple(entry.strip().lower() for entry in (raw or "").split(",") if entry.strip())
    if not entries:
        entries = tuple(DEFAULT_ADO_ALLOWED_HOSTS.split(","))
    return entries


def _parse_positive_float(raw: str | None, default: float, name: str) -> float:
    if raw is None or not raw.strip():
        return default
    try:
        value = float(raw)
    except ValueError:
        value = 0.0
    if not math.isfinite(value) or value <= 0:
        logger.warning("Ignoring invalid %s; using %s", name, default)
        return default
    return value


def _parse_timeout(raw: str | None) -> float:
    return _parse_positive_float(raw, DEFAULT_ADO_TIMEOUT_SECONDS, "ADO_TIMEOUT_SECONDS")


def _parse_port(raw: str | None) -> int:
    if raw is None or not raw.strip():
        return DEFAULT_DB_PORT
    try:
        value = int(raw)
    except ValueError:
        value = 0
    if not 1 <= value <= 65535:
        logger.warning("Ignoring invalid DB_PORT; using %s", DEFAULT_DB_PORT)
        return DEFAULT_DB_PORT
    return value


def _parse_bool(raw: str | None, default: bool, name: str) -> bool:
    if raw is None or not raw.strip():
        return default
    value = raw.strip().lower()
    if value in ("1", "true", "yes", "on"):
        return True
    if value in ("0", "false", "no", "off"):
        return False
    logger.warning("Ignoring invalid %s; using %s", name, default)
    return default


@lru_cache
def get_settings() -> Settings:
    """The process-wide settings, read once. Used as a FastAPI dependency so
    tests can replace it through `app.dependency_overrides`."""
    return Settings.from_env()
