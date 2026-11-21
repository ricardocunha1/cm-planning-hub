"""Authentication dependencies for the protected routers
(plans/oauth-authentication.md). Open paths (`/api/health`, `/api/auth/*`,
`/api/mcp`) simply do not use them."""

from fastapi import Depends, Request
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings, get_settings
from app.db import get_session
from app.services.auth import SESSION_USER_KEY, get_user

CSRF_HEADER = "X-Requested-With"
CSRF_VALUE = "planning-hub"
UNSAFE_METHODS = frozenset({"POST", "PUT", "PATCH", "DELETE"})


class ApiError(Exception):
    """An error answered as `{errors: [message]}` with `status_code` (see the handler in `app.main`)."""

    def __init__(self, status_code: int, message: str) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.message = message


def session_user_id(request: Request) -> int | None:
    """The user id stored in the session cookie, or None when there is none."""
    value = request.session.get(SESSION_USER_KEY)
    return value if isinstance(value, int) and not isinstance(value, bool) else None


async def require_user(
    request: Request,
    settings: Settings = Depends(get_settings),
    session: AsyncSession = Depends(get_session),
) -> int | None:
    """The signed-in user's id; 401 without a valid session. Returns None only
    when `AUTH_ENABLED` is false (a server setting, never request-controlled).

    The id comes from the signed cookie, and the user row must still exist
    (plans and credentials reference it): otherwise the session is cleared and
    the answer is 401. That costs one primary-key lookup per protected request.
    """
    if not settings.auth_enabled:
        return None
    user_id = session_user_id(request)
    if user_id is None:
        raise ApiError(401, "Authentication required.")
    if await get_user(session, user_id) is None:
        request.session.clear()
        raise ApiError(401, "Authentication required.")
    return user_id


def require_csrf(request: Request, settings: Settings = Depends(get_settings)) -> None:
    """Require `X-Requested-With: planning-hub` on state-changing requests.
    A cross-site form or fetch cannot set it without a CORS preflight, which
    the server never grants; this adds to the `SameSite=Lax` cookie."""
    if not settings.auth_enabled or request.method not in UNSAFE_METHODS:
        return
    if request.headers.get(CSRF_HEADER) != CSRF_VALUE:
        raise ApiError(403, f"Missing {CSRF_HEADER} header.")
