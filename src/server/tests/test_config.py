import pytest

from app.config import DB_NAME, DEFAULT_ADO_TIMEOUT_SECONDS, Settings, get_settings, parse_allowed_hosts

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
