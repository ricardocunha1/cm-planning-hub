"""Per-user Azure DevOps credentials (plans/oauth-authentication.md, Phase 3):
the PAT is Fernet-encrypted with `PAT_ENCRYPTION_KEY` before it is stored and
is never returned, logged or put in an error message.

A credential is identified by the canonical project URL from
`parse_project_url` (host lower-cased, no trailing slash, query and fragment
dropped). URLs are compared case-insensitively, since Azure DevOps project
names are, so `.../Alpha` and `.../alpha/` are the same project.
"""

from collections.abc import Iterable, Mapping
from typing import Any

from cryptography.fernet import Fernet, InvalidToken
from sqlalchemy import delete, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings, is_valid_fernet_key
from app.models import AdoCredential
from app.schemas import AdoCredentialResponse

from .ado_url import AdoUrlError, parse_project_url

NAME_MAX_CHARS = 200
PAT_MAX_CHARS = 1024
PAT_LAST4_MIN_CHARS = 8
NUL = "\x00"

NAME_REQUIRED = "Project name is required."
NAME_TOO_LONG = f"Project name must be at most {NAME_MAX_CHARS} characters."
NAME_INVALID_CHARS = "Project name contains invalid characters."
URL_REQUIRED = "Enter the Azure DevOps project URL."
PAT_REQUIRED = "Enter a Personal Access Token."
PAT_INVALID = "The Personal Access Token contains invalid characters or is too long."
PAT_REQUIRED_ON_URL_CHANGE = "Enter the Personal Access Token again: the project URL changed."
DUPLICATE_URL = "A Personal Access Token is already saved for this project URL."
KEY_NOT_CONFIGURED = "Stored credentials are unavailable: PAT_ENCRYPTION_KEY is not configured correctly on the server."
STORED_PAT_UNREADABLE = "The saved Personal Access Token cannot be read. Enter it again in Settings."


class CredentialsUnavailableError(Exception):
    """`PAT_ENCRYPTION_KEY` is missing or invalid, so no PAT can be stored or read."""


class StoredPatUnreadableError(Exception):
    """A stored PAT does not decrypt with the current key (e.g. the key was rotated)."""


def _fernet(settings: Settings) -> Fernet:
    key = settings.pat_encryption_key
    if not key or not is_valid_fernet_key(key):
        raise CredentialsUnavailableError(KEY_NOT_CONFIGURED)
    return Fernet(key.encode("ascii"))


def encrypt_pat(settings: Settings, pat: str) -> str:
    """The Fernet token (url-safe text) of `pat`.

    Raises:
        CredentialsUnavailableError: the encryption key is missing or invalid.
    """
    return _fernet(settings).encrypt(pat.encode("utf-8")).decode("ascii")


def decrypt_pat(settings: Settings, token: str) -> str:
    """The PAT inside a stored Fernet token.

    Raises:
        CredentialsUnavailableError: the encryption key is missing or invalid.
        StoredPatUnreadableError: the token was not made with the current key.
    """
    try:
        return _fernet(settings).decrypt(token.encode("ascii")).decode("utf-8")
    except (InvalidToken, UnicodeError):
        raise StoredPatUnreadableError(STORED_PAT_UNREADABLE) from None


def canonical_project_url(raw: str, allowed_hosts: Iterable[str]) -> str:
    """The canonical project URL of `raw` for either source (the settings form
    has no source field: the Collaboration Hub shape is tried first, then
    On-Prem, whose canonical form is the same for two-segment URLs).

    Raises:
        AdoUrlError: with the cloud message for cloud-style hosts, else the
            On-Prem one (https, host allowlist and shape rules of
            `parse_project_url`).
    """
    try:
        return parse_project_url("cloud", raw, allowed_hosts).project_url
    except AdoUrlError as cloud_error:
        try:
            return parse_project_url("onprem", raw, allowed_hosts).project_url
        except AdoUrlError as onprem_error:
            host = raw.strip().lower().removeprefix("https://").split("/", 1)[0]
            cloud_style = host == "dev.azure.com" or host.endswith(".visualstudio.com")
            raise (cloud_error if cloud_style else onprem_error) from None


def _text(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""


def _encodable(text: str) -> bool:
    try:
        text.encode("utf-8")
    except UnicodeEncodeError:
        return False
    return True


def credential_field_errors(
    data: Mapping[str, Any], allowed_hosts: Iterable[str], *, pat_required: bool
) -> tuple[list[str], str | None]:
    """The 422 messages of a create/update body, all failing fields together
    (name, URL, PAT), and the canonical project URL when it is valid. A
    non-blank `pat` is always checked; a blank one is an error only when
    `pat_required`."""
    errors: list[str] = []
    name = _text(data.get("projectName"))
    if not name:
        errors.append(NAME_REQUIRED)
    elif len(name) > NAME_MAX_CHARS:
        errors.append(NAME_TOO_LONG)
    elif NUL in name or not _encodable(name):
        errors.append(NAME_INVALID_CHARS)

    canonical: str | None = None
    raw_url = _text(data.get("projectUrl"))
    if not raw_url:
        errors.append(URL_REQUIRED)
    else:
        try:
            canonical = canonical_project_url(raw_url, allowed_hosts)
        except AdoUrlError as exc:
            errors.append(str(exc))

    pat = data.get("pat")
    if _text(pat):
        value = pat.strip()
        if len(value) > PAT_MAX_CHARS or any(ord(c) < 32 or ord(c) == 127 for c in value) or not _encodable(value):
            errors.append(PAT_INVALID)
    elif pat_required:
        errors.append(PAT_REQUIRED)
    return errors, canonical


def pat_last4(settings: Settings, token: str) -> str | None:
    """The last 4 characters of the PAT inside `token`, to help users tell
    their tokens apart. None when the PAT is shorter than 8 characters (short
    tokens are not exposed) or cannot be decrypted (unusable key, rotated key,
    corrupt token); never raises and never logs."""
    try:
        pat = decrypt_pat(settings, token)
    except (CredentialsUnavailableError, StoredPatUnreadableError):
        return None
    return pat[-4:] if len(pat) >= PAT_LAST4_MIN_CHARS else None


def to_response(row: AdoCredential, settings: Settings) -> AdoCredentialResponse:
    """The API view of a row: never the PAT, only that one is saved and its
    last 4 characters (`pat_last4`)."""
    return AdoCredentialResponse(
        id=row.id,
        projectName=row.project_name,
        projectUrl=row.project_url,
        hasPat=True,
        patLast4=pat_last4(settings, row.pat_encrypted),
    )


async def list_credentials(session: AsyncSession, user_id: int) -> list[AdoCredential]:
    """The user's credentials, ordered by project name then id."""
    result = await session.execute(
        select(AdoCredential)
        .where(AdoCredential.user_id == user_id)
        .order_by(func.lower(AdoCredential.project_name), AdoCredential.id)
    )
    return list(result.scalars())


async def _get_owned(session: AsyncSession, user_id: int, credential_id: int) -> AdoCredential | None:
    result = await session.execute(
        select(AdoCredential).where(AdoCredential.id == credential_id, AdoCredential.user_id == user_id)
    )
    return result.scalar_one_or_none()


async def get_credential(session: AsyncSession, user_id: int, credential_id: int) -> AdoCredential | None:
    """The user's credential, or None when the id is unknown or belongs to
    someone else (callers answer 404 for both)."""
    if not 1 <= credential_id <= 2**31 - 1:
        return None
    return await _get_owned(session, user_id, credential_id)


async def _duplicate_exists(
    session: AsyncSession, user_id: int, project_url: str, *, exclude_id: int | None = None
) -> bool:
    statement = select(AdoCredential.id).where(
        AdoCredential.user_id == user_id, func.lower(AdoCredential.project_url) == project_url.lower()
    )
    if exclude_id is not None:
        statement = statement.where(AdoCredential.id != exclude_id)
    return (await session.execute(statement.limit(1))).first() is not None


async def create_credential(
    session: AsyncSession, settings: Settings, user_id: int, project_name: str, project_url: str, pat: str
) -> AdoCredential | None:
    """Store a credential (`project_url` already canonical, PAT encrypted) and
    commit. None when the user already has one for that project.

    Raises:
        CredentialsUnavailableError: the encryption key is missing or invalid.
    """
    token = encrypt_pat(settings, pat.strip())
    if await _duplicate_exists(session, user_id, project_url):
        return None
    row = AdoCredential(
        user_id=user_id, project_name=project_name.strip(), project_url=project_url, pat_encrypted=token
    )
    session.add(row)
    try:
        await session.commit()
    except IntegrityError:
        await session.rollback()
        return None
    await session.refresh(row)
    return row


async def update_credential(
    session: AsyncSession,
    settings: Settings,
    row: AdoCredential,
    project_name: str,
    project_url: str,
    pat: str | None,
) -> AdoCredential | None:
    """Change the name, URL and (when `pat` is given) the PAT of an owned row
    and commit. None when the new URL collides with another of the user's
    credentials.

    Raises:
        CredentialsUnavailableError: a new PAT is given and the key is unusable.
    """
    token = encrypt_pat(settings, pat.strip()) if pat else None
    if project_url.lower() != row.project_url.lower() and await _duplicate_exists(
        session, row.user_id, project_url, exclude_id=row.id
    ):
        return None
    row.project_name = project_name.strip()
    row.project_url = project_url
    if token is not None:
        row.pat_encrypted = token
    row.updated_at = func.now()
    try:
        await session.commit()
    except IntegrityError:
        await session.rollback()
        return None
    await session.refresh(row)
    return row


async def delete_credential(session: AsyncSession, user_id: int, credential_id: int) -> bool:
    """Delete an owned credential; False when the id is unknown or not the user's."""
    if not 1 <= credential_id <= 2**31 - 1:
        return False
    result = await session.execute(
        delete(AdoCredential).where(AdoCredential.id == credential_id, AdoCredential.user_id == user_id)
    )
    await session.commit()
    return result.rowcount > 0


async def find_pat(session: AsyncSession, settings: Settings, user_id: int, project_url: str) -> str | None:
    """The decrypted PAT the user saved for the canonical `project_url`, or None.

    Raises:
        CredentialsUnavailableError: the encryption key is missing or invalid.
        StoredPatUnreadableError: the stored token does not decrypt.
    """
    result = await session.execute(
        select(AdoCredential.pat_encrypted)
        .where(AdoCredential.user_id == user_id, func.lower(AdoCredential.project_url) == project_url.lower())
        .limit(1)
    )
    token = result.scalar_one_or_none()
    return None if token is None else decrypt_pat(settings, token)
