import logging
import math
import os
from collections.abc import Mapping
from dataclasses import dataclass, field
from functools import lru_cache
from urllib.parse import urlsplit

from cryptography.fernet import Fernet
from sqlalchemy.engine import URL

logger = logging.getLogger(__name__)

DEFAULT_ADO_ALLOWED_HOSTS = "dev.azure.com,*.visualstudio.com,tfs-projects.cmf.criticalmanufacturing.com"
DEFAULT_ADO_TIMEOUT_SECONDS = 30.0
DEFAULT_DB_HOST = "localhost"
DEFAULT_DB_PORT = 5432
DB_NAME = "planninghub"
DEFAULT_DB_STARTUP_TIMEOUT_SECONDS = 60.0
DEFAULT_MCP_ALLOWED_HOSTS = "localhost,localhost:*,127.0.0.1,127.0.0.1:*"
DEFAULT_ADO_DESCRIPTION_MAX_CHARS = 2000
DEFAULT_SESSION_MAX_AGE_SECONDS = 8 * 60 * 60
MIN_SESSION_SECRET_LENGTH = 32


@dataclass(frozen=True)
class Settings:
    """Server settings read from the environment (see plans/release-plan-ado.md).

    `ado_allowed_hosts` is the SSRF allowlist for the Azure DevOps proxy: exact
    host names, or `*.example.com` for any subdomain of example.com.

    The `db_*` fields locate the PostgreSQL database that stores Release Plan
    boards (see plans/release-plan-persistence.md). The database name is the
    fixed constant `DB_NAME`, not configurable. The password is kept out of
    `repr` so it never reaches logs.

    The MCP endpoint (see plans/release-plan-mcp-server.md) uses
    `mcp_allowed_hosts` (Host header allowlist; `host:*` allows any port) and
    `public_base_url` (no trailing `/`, empty when unset) to build board links.
    `ado_description_max_chars` caps each backlog work item's description.

    Authentication (see plans/oauth-authentication.md): Google OIDC login with
    a signed session cookie. The client id/secret, the session secret and the
    PAT encryption key are kept out of `repr`. `auth_enabled=False` turns the
    session requirement off (dev/test only; it is read from the environment,
    never from a request). `pat_encryption_key` is the Fernet key of the stored
    Azure DevOps PATs (required when auth is enabled). `auth_allowed_email_domains` empty means any
    verified Google account may sign in.
    """

    ado_allowed_hosts: tuple[str, ...]
    ado_timeout_seconds: float
    db_host: str = DEFAULT_DB_HOST
    db_port: int = DEFAULT_DB_PORT
    db_user: str = ""
    db_password: str = field(default="", repr=False)
    db_migrate_on_startup: bool = True
    db_startup_timeout_seconds: float = DEFAULT_DB_STARTUP_TIMEOUT_SECONDS
    mcp_allowed_hosts: tuple[str, ...] = tuple(DEFAULT_MCP_ALLOWED_HOSTS.split(","))
    public_base_url: str = ""
    ado_description_max_chars: int = DEFAULT_ADO_DESCRIPTION_MAX_CHARS
    google_client_id: str = field(default="", repr=False)
    google_client_secret: str = field(default="", repr=False)
    session_secret: str = field(default="", repr=False)
    pat_encryption_key: str = field(default="", repr=False)
    auth_enabled: bool = True
    auth_allowed_email_domains: tuple[str, ...] = ()
    session_max_age_seconds: int = DEFAULT_SESSION_MAX_AGE_SECONDS

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
            mcp_allowed_hosts=parse_mcp_allowed_hosts(env.get("MCP_ALLOWED_HOSTS")),
            public_base_url=(env.get("PUBLIC_BASE_URL") or "").strip().rstrip("/"),
            ado_description_max_chars=_parse_positive_int(
                env.get("ADO_DESCRIPTION_MAX_CHARS"),
                DEFAULT_ADO_DESCRIPTION_MAX_CHARS,
                "ADO_DESCRIPTION_MAX_CHARS",
            ),
            google_client_id=(env.get("GOOGLE_CLIENT_ID") or "").strip(),
            google_client_secret=(env.get("GOOGLE_CLIENT_SECRET") or "").strip(),
            session_secret=env.get("SESSION_SECRET") or "",
            pat_encryption_key=(env.get("PAT_ENCRYPTION_KEY") or "").strip(),
            auth_enabled=_parse_bool(env.get("AUTH_ENABLED"), True, "AUTH_ENABLED"),
            auth_allowed_email_domains=parse_email_domains(env.get("AUTH_ALLOWED_EMAIL_DOMAINS")),
            session_max_age_seconds=_parse_positive_int(
                env.get("SESSION_MAX_AGE_SECONDS"),
                DEFAULT_SESSION_MAX_AGE_SECONDS,
                "SESSION_MAX_AGE_SECONDS",
            ),
        )

    def auth_config_errors(self) -> list[str]:
        """The auth settings missing or invalid when `auth_enabled` (empty list
        when authentication is off or fully configured). `PUBLIC_BASE_URL` is
        required because the OAuth redirect URI and the Secure cookie flag come
        from it, never from request headers. The lifespan fails the startup on
        a non-empty list."""
        if not self.auth_enabled:
            return []
        required = {
            "GOOGLE_CLIENT_ID": self.google_client_id,
            "GOOGLE_CLIENT_SECRET": self.google_client_secret,
            "SESSION_SECRET": self.session_secret,
            "PAT_ENCRYPTION_KEY": self.pat_encryption_key,
            "PUBLIC_BASE_URL": self.public_base_url,
        }
        errors = [f"{name} is required when AUTH_ENABLED is true." for name, value in required.items() if not value]
        if self.session_secret and len(self.session_secret) < MIN_SESSION_SECRET_LENGTH:
            errors.append(f"SESSION_SECRET must be at least {MIN_SESSION_SECRET_LENGTH} characters.")
        if self.pat_encryption_key and not is_valid_fernet_key(self.pat_encryption_key):
            errors.append("PAT_ENCRYPTION_KEY must be a valid Fernet key (32 url-safe base64-encoded bytes).")
        if self.public_base_url and not _is_absolute_http_url(self.public_base_url):
            errors.append("PUBLIC_BASE_URL must be an absolute http(s) URL without a trailing slash.")
        return errors

    def cookie_secure(self) -> bool:
        """Whether the session cookie is `Secure`: only when the public URL is https."""
        return self.public_base_url.lower().startswith("https://")

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


def parse_mcp_allowed_hosts(raw: str | None) -> tuple[str, ...]:
    """Split the comma-separated `MCP_ALLOWED_HOSTS` like `parse_allowed_hosts`
    (a value with no entries means the default list)."""
    entries = tuple(entry.strip().lower() for entry in (raw or "").split(",") if entry.strip())
    return entries or tuple(DEFAULT_MCP_ALLOWED_HOSTS.split(","))


def is_valid_fernet_key(key: str) -> bool:
    """Whether `key` is a usable Fernet key (the stored PATs' encryption key)."""
    try:
        Fernet(key.encode("ascii"))
    except (ValueError, TypeError):
        return False
    return True


def _is_absolute_http_url(value: str) -> bool:
    parts = urlsplit(value)
    return parts.scheme in ("http", "https") and bool(parts.netloc) and not parts.path and not parts.query and not parts.fragment


def parse_email_domains(raw: str | None) -> tuple[str, ...]:
    """Split the comma-separated `AUTH_ALLOWED_EMAIL_DOMAINS`: entries trimmed,
    lower-cased, a leading `@` dropped, blanks dropped. No entries (the
    default) means any domain."""
    entries = (entry.strip().lower().removeprefix("@") for entry in (raw or "").split(","))
    return tuple(entry for entry in entries if entry)


def _parse_positive_int(raw: str | None, default: int, name: str) -> int:
    if raw is None or not raw.strip():
        return default
    try:
        value = int(raw)
    except ValueError:
        value = 0
    if value <= 0:
        logger.warning("Ignoring invalid %s; using %s", name, default)
        return default
    return value


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
