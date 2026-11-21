import pytest
from cryptography.fernet import Fernet

from app.config import (
    DB_NAME,
    DEFAULT_ADO_TIMEOUT_SECONDS,
    DEFAULT_SESSION_MAX_AGE_SECONDS,
    Settings,
    get_settings,
    is_valid_fernet_key,
    parse_allowed_hosts,
    parse_mcp_allowed_hosts,
)

FERNET_KEY = Fernet.generate_key().decode()
ONPREM_HOST = "tfs-projects.cmf.criticalmanufacturing.com"


def test_settings_defaults():
    settings = Settings.from_env({})
    assert settings.ado_allowed_hosts == ("dev.azure.com", "*.visualstudio.com", ONPREM_HOST)
    assert settings.ado_timeout_seconds == DEFAULT_ADO_TIMEOUT_SECONDS == 30.0


def test_settings_parse_hosts_trimmed_lowercased_blanks_dropped():
    settings = Settings.from_env({"ADO_ALLOWED_HOSTS": " TFS.Example.com, ,*.Foo.org,, ", "ADO_TIMEOUT_SECONDS": "12.5"})
    assert settings.ado_allowed_hosts == ("tfs.example.com", "*.foo.org")
    assert settings.ado_timeout_seconds == 12.5


@pytest.mark.parametrize("raw", ["", "   ", ",,"])
def test_settings_blank_hosts_fall_back_to_default(raw):
    # No entries at all: an empty allowlist would refuse every host.
    assert Settings.from_env({"ADO_ALLOWED_HOSTS": raw}).ado_allowed_hosts == parse_allowed_hosts(None)


@pytest.mark.parametrize("raw", ["abc", "0", "-5", "nan", "inf", ""])
def test_settings_invalid_timeout_falls_back_to_default(raw):
    assert Settings.from_env({"ADO_TIMEOUT_SECONDS": raw}).ado_timeout_seconds == DEFAULT_ADO_TIMEOUT_SECONDS


def test_settings_from_process_environment(monkeypatch):
    monkeypatch.setenv("ADO_ALLOWED_HOSTS", "tfs.example.com")
    monkeypatch.setenv("ADO_TIMEOUT_SECONDS", "5")
    monkeypatch.delenv("AUTH_ENABLED")  # conftest switches auth off for the suite; compare with the defaults
    assert Settings.from_env() == Settings(ado_allowed_hosts=("tfs.example.com",), ado_timeout_seconds=5.0)


def test_get_settings_is_cached():
    assert get_settings() is get_settings()


def test_db_settings_defaults():
    settings = Settings.from_env({})
    assert settings.db_host == "localhost"
    assert settings.db_port == 5432
    assert settings.db_user == ""
    assert settings.db_password == ""
    assert settings.db_migrate_on_startup is True
    assert settings.db_startup_timeout_seconds == 60.0


def test_db_settings_parsed_from_env():
    settings = Settings.from_env(
        {
            "DB_HOST": "db",
            "DB_PORT": "6543",
            "DB_USER": "u",
            "DB_PASSWORD": "pw",
            "DB_MIGRATE_ON_STARTUP": "false",
            "DB_STARTUP_TIMEOUT_SECONDS": "5.5",
        }
    )
    assert (settings.db_host, settings.db_port) == ("db", 6543)
    assert (settings.db_user, settings.db_password) == ("u", "pw")
    assert settings.db_migrate_on_startup is False
    assert settings.db_startup_timeout_seconds == 5.5


@pytest.mark.parametrize("raw", ["abc", "0", "70000", "-1", "5.5", ""])
def test_db_invalid_port_falls_back_to_default(raw):
    assert Settings.from_env({"DB_PORT": raw}).db_port == 5432


@pytest.mark.parametrize("raw", ["abc", "0", "-5", "nan", "inf", ""])
def test_db_invalid_startup_timeout_falls_back_to_default(raw):
    assert Settings.from_env({"DB_STARTUP_TIMEOUT_SECONDS": raw}).db_startup_timeout_seconds == 60.0


@pytest.mark.parametrize("raw,expected", [("0", False), ("OFF", False), ("no", False), ("1", True), ("True", True)])
def test_db_migrate_on_startup_parsing(raw, expected):
    assert Settings.from_env({"DB_MIGRATE_ON_STARTUP": raw}).db_migrate_on_startup is expected


@pytest.mark.parametrize("raw", ["maybe", "", "  "])
def test_db_migrate_on_startup_invalid_falls_back_to_true(raw):
    assert Settings.from_env({"DB_MIGRATE_ON_STARTUP": raw}).db_migrate_on_startup is True


def test_database_url_escapes_password():
    settings = Settings.from_env({"DB_HOST": "h", "DB_USER": "u", "DB_PASSWORD": "p@ss:w/rd"})
    url = settings.database_url()
    assert url.drivername == "postgresql+asyncpg"
    assert url.password == "p@ss:w/rd"
    assert (url.host, url.port, url.database, url.username) == ("h", 5432, "planninghub", "u")
    rendered = url.render_as_string(hide_password=False)
    assert "p%40ss%3Aw%2Frd" in rendered
    assert "p@ss:w/rd" not in rendered


def test_database_name_is_fixed_and_env_var_ignored():
    url = Settings.from_env({"DB_NAME": "other"}).database_url()
    assert url.database == DB_NAME == "planninghub"


def test_database_url_hides_password_when_rendered():
    url = Settings.from_env({"DB_USER": "u", "DB_PASSWORD": "secret"}).database_url()
    assert "secret" not in url.render_as_string(hide_password=True)
    assert "secret" not in repr(url)


def test_settings_repr_does_not_leak_password():
    assert "secret" not in repr(Settings.from_env({"DB_PASSWORD": "secret"}))


# --- MCP and description settings -----------------------------------------------------


def test_mcp_and_description_defaults():
    settings = Settings.from_env({})
    assert settings.mcp_allowed_hosts == ("localhost", "localhost:*", "127.0.0.1", "127.0.0.1:*")
    assert settings.public_base_url == ""
    assert settings.ado_description_max_chars == 2000


def test_mcp_allowed_hosts_are_trimmed_and_lowercased():
    settings = Settings.from_env({"MCP_ALLOWED_HOSTS": " Hub.Example.com, ,localhost:*,, "})
    assert settings.mcp_allowed_hosts == ("hub.example.com", "localhost:*")


@pytest.mark.parametrize("raw", ["", "   ", ",,"])
def test_blank_mcp_allowed_hosts_use_the_default(raw):
    assert Settings.from_env({"MCP_ALLOWED_HOSTS": raw}).mcp_allowed_hosts == parse_mcp_allowed_hosts(None)


@pytest.mark.parametrize(
    ("raw", "expected"),
    [("https://hub.example.com/", "https://hub.example.com"), (" http://x:8080// ", "http://x:8080"), ("", "")],
)
def test_public_base_url_trailing_slash_trimmed(raw, expected):
    assert Settings.from_env({"PUBLIC_BASE_URL": raw}).public_base_url == expected


def test_description_max_chars_valid():
    assert Settings.from_env({"ADO_DESCRIPTION_MAX_CHARS": " 500 "}).ado_description_max_chars == 500


@pytest.mark.parametrize("raw", ["", "  ", "abc", "1.5", "0", "-3"])
def test_invalid_description_max_chars_uses_default(raw):
    assert Settings.from_env({"ADO_DESCRIPTION_MAX_CHARS": raw}).ado_description_max_chars == 2000


@pytest.mark.parametrize("raw", ["abc", "0", "-3"])
def test_invalid_description_max_chars_logs_warning(raw, caplog):
    Settings.from_env({"ADO_DESCRIPTION_MAX_CHARS": raw})
    assert "ADO_DESCRIPTION_MAX_CHARS" in caplog.text


# --- authentication settings -------------------------------------------------


def test_auth_defaults():
    settings = Settings.from_env({})
    assert settings.auth_enabled is True
    assert settings.auth_allowed_email_domains == ()
    assert settings.session_max_age_seconds == DEFAULT_SESSION_MAX_AGE_SECONDS == 8 * 60 * 60
    assert (settings.google_client_id, settings.google_client_secret) == ("", "")
    assert (settings.session_secret, settings.pat_encryption_key) == ("", "")


def test_auth_settings_are_read_from_the_environment():
    settings = Settings.from_env(
        {
            "GOOGLE_CLIENT_ID": " id ",
            "GOOGLE_CLIENT_SECRET": "secret",
            "SESSION_SECRET": "s3",
            "PAT_ENCRYPTION_KEY": "key",
            "AUTH_ENABLED": "false",
            "AUTH_ALLOWED_EMAIL_DOMAINS": " Example.com, @Foo.org ,, ",
            "SESSION_MAX_AGE_SECONDS": "60",
        }
    )
    assert settings.google_client_id == "id"
    assert settings.auth_enabled is False
    assert settings.auth_allowed_email_domains == ("example.com", "foo.org")
    assert settings.session_max_age_seconds == 60


@pytest.mark.parametrize("raw", ["abc", "0", "-1", ""])
def test_invalid_session_max_age_falls_back_to_default(raw):
    assert Settings.from_env({"SESSION_MAX_AGE_SECONDS": raw}).session_max_age_seconds == DEFAULT_SESSION_MAX_AGE_SECONDS


def test_invalid_auth_enabled_stays_enabled():
    assert Settings.from_env({"AUTH_ENABLED": "maybe"}).auth_enabled is True


def test_auth_secrets_are_not_in_repr():
    settings = Settings.from_env({"GOOGLE_CLIENT_SECRET": "top-secret", "SESSION_SECRET": "cookie-key", "PAT_ENCRYPTION_KEY": "fernet"})
    text = repr(settings)
    assert "top-secret" not in text and "cookie-key" not in text and "fernet" not in text


def test_auth_config_errors_lists_every_missing_secret():
    errors = Settings.from_env({}).auth_config_errors()
    assert [e.split(" ")[0] for e in errors] == [
        "GOOGLE_CLIENT_ID",
        "GOOGLE_CLIENT_SECRET",
        "SESSION_SECRET",
        "PAT_ENCRYPTION_KEY",
        "PUBLIC_BASE_URL",
    ]


def test_auth_config_errors_empty_when_configured_or_disabled():
    configured = {
        "GOOGLE_CLIENT_ID": "a",
        "GOOGLE_CLIENT_SECRET": "b",
        "SESSION_SECRET": "c" * 32,
        "PAT_ENCRYPTION_KEY": FERNET_KEY,
        "PUBLIC_BASE_URL": "https://hub.example.com",
    }
    assert Settings.from_env(configured).auth_config_errors() == []
    assert Settings.from_env({"AUTH_ENABLED": "false"}).auth_config_errors() == []


@pytest.mark.parametrize(
    ("url", "secure"),
    [("https://hub.example.com", True), ("HTTPS://hub.example.com", True), ("http://localhost:8080", False), ("", False)],
)
def test_cookie_secure_only_for_https_public_url(url, secure):
    assert Settings.from_env({"PUBLIC_BASE_URL": url}).cookie_secure() is secure


def test_auth_config_errors_rejects_a_short_session_secret():
    env = {
        "GOOGLE_CLIENT_ID": "a",
        "GOOGLE_CLIENT_SECRET": "b",
        "PAT_ENCRYPTION_KEY": FERNET_KEY,
        "PUBLIC_BASE_URL": "http://localhost:8080",
    }
    errors = Settings.from_env({**env, "SESSION_SECRET": "c" * 31}).auth_config_errors()
    assert errors == ["SESSION_SECRET must be at least 32 characters."]
    assert Settings.from_env({**env, "SESSION_SECRET": "c" * 32}).auth_config_errors() == []


@pytest.mark.parametrize("url", ["hub.example.com", "ftp://hub.example.com", "https://", "https://hub.example.com/app", "https://hub.example.com?x=1"])
def test_auth_config_errors_rejects_a_bad_public_base_url(url):
    env = {
        "GOOGLE_CLIENT_ID": "a",
        "GOOGLE_CLIENT_SECRET": "b",
        "SESSION_SECRET": "c" * 32,
        "PAT_ENCRYPTION_KEY": FERNET_KEY,
        "PUBLIC_BASE_URL": url,
    }
    assert Settings.from_env(env).auth_config_errors() == [
        "PUBLIC_BASE_URL must be an absolute http(s) URL without a trailing slash."
    ]


def test_trailing_slash_of_public_base_url_is_normalised_so_it_passes():
    env = {
        "GOOGLE_CLIENT_ID": "a",
        "GOOGLE_CLIENT_SECRET": "b",
        "SESSION_SECRET": "c" * 32,
        "PAT_ENCRYPTION_KEY": FERNET_KEY,
        "PUBLIC_BASE_URL": "http://localhost:8080/",
    }
    assert Settings.from_env(env).auth_config_errors() == []


@pytest.mark.parametrize("key", ["not-a-key", "short", "a" * 44, "é" * 44])
def test_auth_config_errors_rejects_an_invalid_pat_encryption_key(key):
    env = {
        "GOOGLE_CLIENT_ID": "a",
        "GOOGLE_CLIENT_SECRET": "b",
        "SESSION_SECRET": "c" * 32,
        "PAT_ENCRYPTION_KEY": key,
        "PUBLIC_BASE_URL": "http://localhost:8080",
    }
    errors = Settings.from_env(env).auth_config_errors()
    assert errors == ["PAT_ENCRYPTION_KEY must be a valid Fernet key (32 url-safe base64-encoded bytes)."]
    assert key not in errors[0]


def test_is_valid_fernet_key():
    assert is_valid_fernet_key(FERNET_KEY)
    assert not is_valid_fernet_key("")
