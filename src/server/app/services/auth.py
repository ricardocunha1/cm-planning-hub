"""Google OIDC login (plans/oauth-authentication.md): the OIDC client, the
checks on the verified ID token claims, and the user upsert.

The authorization-code flow runs on the server with PKCE, `state` and `nonce`;
authlib stores them in the (signed) session between `/login` and `/callback`
and verifies the ID token signature, `iss`, `aud`, `exp` and `nonce`.
"""

from dataclasses import dataclass
from functools import lru_cache
from typing import Any, Mapping

from authlib.integrations.starlette_client import OAuth
from sqlalchemy import func
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.models import User

GOOGLE_METADATA_URL = "https://accounts.google.com/.well-known/openid-configuration"
SESSION_USER_KEY = "user_id"

# Codes sent to the SPA as `/login?error=<code>`; the client maps them to messages.
ERROR_LOGIN_FAILED = "login_failed"
ERROR_ACCESS_DENIED = "access_denied"
ERROR_STATE_MISMATCH = "state_mismatch"
ERROR_INVALID_CLAIMS = "invalid_claims"
ERROR_EMAIL_NOT_VERIFIED = "email_not_verified"
ERROR_DOMAIN_NOT_ALLOWED = "domain_not_allowed"


class AuthError(Exception):
    """A failed login; `code` is the `error` query value of the redirect to `/login`."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class GoogleProfile:
    """The identity taken from a verified Google ID token."""

    sub: str
    email: str
    name: str
    picture_url: str | None


@lru_cache
def _oauth_client(client_id: str, client_secret: str) -> Any:
    oauth = OAuth()
    return oauth.register(
        name="google",
        client_id=client_id,
        client_secret=client_secret,
        server_metadata_url=GOOGLE_METADATA_URL,
        client_kwargs={"scope": "openid email profile", "code_challenge_method": "S256"},
    )


def build_oidc_client(settings: Settings) -> Any:
    """The authlib Starlette client for Google (cached per credentials). It
    exposes `authorize_redirect(request, redirect_uri)` and
    `authorize_access_token(request)`; the latter returns the token with the
    validated claims in `userinfo`. Tests replace it with a fake."""
    return _oauth_client(settings.google_client_id, settings.google_client_secret)


def callback_url(settings: Settings) -> str:
    """The redirect URI: `PUBLIC_BASE_URL` + `/api/auth/callback`. Never derived
    from request headers; the startup check requires `PUBLIC_BASE_URL` when
    authentication is enabled."""
    return f"{settings.public_base_url}/api/auth/callback"


def profile_from_claims(claims: Mapping[str, Any], allowed_domains: tuple[str, ...]) -> GoogleProfile:
    """Check the ID token claims and extract the profile.

    Raises:
        AuthError: `invalid_claims` (no `sub`/`email`), `email_not_verified`
            (`email_verified` is not exactly true) or `domain_not_allowed`
            (the email domain is not in `allowed_domains`, when that is set).
    """
    sub = claims.get("sub")
    email = claims.get("email")
    if not isinstance(sub, str) or not sub or not isinstance(email, str) or "@" not in email:
        raise AuthError(ERROR_INVALID_CLAIMS)
    if claims.get("email_verified") is not True:
        raise AuthError(ERROR_EMAIL_NOT_VERIFIED)
    if allowed_domains and email.rsplit("@", 1)[1].lower() not in allowed_domains:
        raise AuthError(ERROR_DOMAIN_NOT_ALLOWED)
    name = claims.get("name")
    picture = claims.get("picture")
    return GoogleProfile(
        sub=sub,
        email=email,
        name=name.strip() if isinstance(name, str) and name.strip() else email,
        picture_url=picture if isinstance(picture, str) and picture else None,
    )


async def upsert_user(session: AsyncSession, profile: GoogleProfile) -> User:
    """Insert the user, or refresh email/name/picture and `last_login_at` of the
    existing one with the same `sub`; commits and returns the row."""
    insert_stmt = insert(User).values(
        sub=profile.sub, email=profile.email, name=profile.name, picture_url=profile.picture_url
    )
    statement = insert_stmt.on_conflict_do_update(
        index_elements=[User.sub],
        set_={
            "email": insert_stmt.excluded.email,
            "name": insert_stmt.excluded.name,
            "picture_url": insert_stmt.excluded.picture_url,
            "last_login_at": func.now(),
        },
    ).returning(User)
    user = (await session.execute(statement)).scalar_one()
    await session.commit()
    return user


async def get_user(session: AsyncSession, user_id: int) -> User | None:
    return await session.get(User, user_id)
