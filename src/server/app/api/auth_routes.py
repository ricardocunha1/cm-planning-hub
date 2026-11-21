import logging
from typing import Any

from authlib.integrations.base_client.errors import MismatchingStateError, OAuthError
from fastapi import APIRouter, Depends, Request, Response
from fastapi.responses import JSONResponse, RedirectResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import ApiError, require_csrf, require_user
from app.config import Settings, get_settings
from app.db import get_session
from app.schemas import ErrorResponse, UserResponse
from app.services.auth import (
    ERROR_ACCESS_DENIED,
    ERROR_LOGIN_FAILED,
    ERROR_STATE_MISMATCH,
    SESSION_USER_KEY,
    AuthError,
    build_oidc_client,
    callback_url,
    get_user,
    profile_from_claims,
    upsert_user,
)

logger = logging.getLogger(__name__)

router = APIRouter()

UNAUTHENTICATED = {401: {"model": ErrorResponse}}
# What `/me` answers when `AUTH_ENABLED` is false (dev/test), so the SPA still works.
DEV_USER = UserResponse(id=0, name="Local developer", email="dev@localhost", pictureUrl=None)


def get_oidc_client(settings: Settings = Depends(get_settings)) -> Any:
    """The OIDC client; tests override this dependency with a fake."""
    return build_oidc_client(settings)


def _login_error(code: str) -> RedirectResponse:
    return RedirectResponse(f"/login?error={code}", status_code=302)


def _require_enabled(settings: Settings) -> None:
    if not settings.auth_enabled:
        raise ApiError(503, "Authentication is disabled.")


@router.get("/login", status_code=302, response_class=RedirectResponse)
async def login(
    request: Request,
    settings: Settings = Depends(get_settings),
    oidc: Any = Depends(get_oidc_client),
):
    """Start the login: redirect to Google. Any previous session is dropped
    first, so only the new `state`/`nonce`/PKCE verifier live in it."""
    _require_enabled(settings)
    request.session.clear()
    redirect_uri = callback_url(settings)
    return await oidc.authorize_redirect(request, redirect_uri)


@router.get("/callback", status_code=302, response_class=RedirectResponse)
async def callback(
    request: Request,
    settings: Settings = Depends(get_settings),
    oidc: Any = Depends(get_oidc_client),
    session: AsyncSession = Depends(get_session),
):
    """Finish the login: exchange the code (authlib checks `state`, PKCE, the
    ID token signature, `iss`, `aud`, `exp` and `nonce`), require a verified
    email in an allowed domain, upsert the user and store only its id in a
    fresh session. Every failure redirects to `/login?error=<code>`."""
    _require_enabled(settings)
    try:
        token = await oidc.authorize_access_token(request)
        profile = profile_from_claims(token.get("userinfo") or {}, settings.auth_allowed_email_domains)
        user = await upsert_user(session, profile)
    except AuthError as exc:
        request.session.clear()
        return _login_error(exc.code)
    except MismatchingStateError:
        request.session.clear()
        return _login_error(ERROR_STATE_MISMATCH)
    except OAuthError as exc:
        request.session.clear()
        return _login_error(ERROR_ACCESS_DENIED if exc.error == "access_denied" else ERROR_LOGIN_FAILED)
    except Exception:
        logger.exception("Login callback failed")
        request.session.clear()
        return _login_error(ERROR_LOGIN_FAILED)
    request.session.clear()
    request.session[SESSION_USER_KEY] = user.id
    return RedirectResponse("/", status_code=302)


@router.get("/me", response_model=UserResponse, responses=UNAUTHENTICATED)
async def me(
    request: Request,
    user_id: int | None = Depends(require_user),
    session: AsyncSession = Depends(get_session),
):
    if user_id is None:
        return DEV_USER
    user = await get_user(session, user_id)
    if user is None:
        request.session.clear()
        raise ApiError(401, "Authentication required.")
    return UserResponse(id=user.id, name=user.name, email=user.email, pictureUrl=user.picture_url)


@router.post("/logout", status_code=204, dependencies=[Depends(require_csrf)])
async def logout(request: Request) -> Response:
    request.session.clear()
    return Response(status_code=204)
