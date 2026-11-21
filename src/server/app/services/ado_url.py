"""Azure DevOps project URL rules (plans/release-plan-ado.md "Decisions" and
"API contract"). The client mirrors these rules in lib/releasePlan/adoUrl.ts;
the host allowlist stays server-only."""

import re
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from typing import Any
from urllib.parse import quote, unquote, urlsplit

SOURCES = ("onprem", "cloud")
CLOUD_HOST = "dev.azure.com"
VISUALSTUDIO_SUFFIX = ".visualstudio.com"
_LDH_LABEL = re.compile(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?")
_CONTROL_CHARS = re.compile(r"[\x00-\x1f\x7f]")

SOURCE_REQUIRED = "Choose the Azure DevOps source (On-Prem or Collaboration Hub)."
URL_REQUIRED = "Enter the Azure DevOps project URL."
PAT_REQUIRED = "Enter a Personal Access Token."
PAT_OR_SAVED_REQUIRED = (
    "A Personal Access Token is required: enter one, or save one for this project in Settings."
)
HTTPS_REQUIRED = "The URL must start with https://."
CLOUD_SHAPE = "Collaboration Hub URLs look like https://dev.azure.com/<organization>/<project>."
ONPREM_SHAPE = "On-Prem URLs look like https://<server>/<collection>/<project>."


class AdoUrlError(Exception):
    pass


@dataclass(frozen=True)
class AdoProject:
    """A parsed project URL.

    `base_url` is `https://host/<org|collection>` (just `https://<org>.visualstudio.com`
    for that cloud form), `project` the decoded project name and `project_url`
    the canonical URL (encoded, no trailing slash).
    """

    kind: str
    base_url: str
    project: str
    project_url: str

    @property
    def host(self) -> str:
        return urlsplit(self.base_url).hostname or ""


def connection_field_errors(data: Mapping[str, Any], *, pat_required: bool = True) -> list[str]:
    """Missing/blank checks for the common `/api/ado/*` request part.

    Every failing field is reported at once, in field order (source, URL,
    PAT), like /api/validate reports all its form errors together. With
    `pat_required` false (the REST routes, which fall back to the user's saved
    PAT) an absent, null or blank `pat` passes; any other non-string is still
    reported.
    """
    errors: list[str] = []
    if data.get("source") not in SOURCES:
        errors.append(SOURCE_REQUIRED)
    if not _non_blank(data.get("projectUrl")):
        errors.append(URL_REQUIRED)
    pat = data.get("pat")
    absent = pat is None or (isinstance(pat, str) and not pat.strip())
    if not _non_blank(pat) and (pat_required or not absent):
        errors.append(PAT_REQUIRED)
    return errors


def host_allowed(host: str, patterns: Iterable[str]) -> bool:
    """Case-insensitive allowlist match: `*.x` matches any subdomain of `x`
    (but not `x` itself); any other pattern must equal the host."""
    host = host.lower()
    for pattern in patterns:
        pattern = pattern.lower()
        if pattern.startswith("*."):
            if host.endswith(pattern[1:]):
                return True
        elif host == pattern:
            return True
    return False


def parse_project_url(source: str, url: str, allowed_hosts: Iterable[str]) -> AdoProject:
    """Validate a project URL for the selected source and split it.

    Checked in order: https scheme, host syntax (a valid DNS name once
    IDNA-encoded), host on the allowlist, then the URL shape for the source.
    A URL that cannot be UTF-8 encoded (a lone surrogate from a JSON `\\ud800`
    escape), a malformed host or an unusable path segment (see
    `_path_segments`) fails with the shape message, before any request is made. A trailing `/`, the first `/_…` segment and
    everything after it, the query string and the fragment are ignored.

    Raises:
        AdoUrlError: with the contract message for the first failed rule.
    """
    shape_error = CLOUD_SHAPE if source == "cloud" else ONPREM_SHAPE
    url = url.strip()
    if not url.lower().startswith("https://"):
        raise AdoUrlError(HTTPS_REQUIRED)
    if not _utf8_encodable(url):
        raise AdoUrlError(shape_error)

    try:
        parts = urlsplit(url)
        host = _ascii_host(parts.hostname or "")
        port = parts.port
    except ValueError as exc:
        raise AdoUrlError(shape_error) from exc
    if host is None or parts.username is not None or parts.password is not None:
        raise AdoUrlError(shape_error)
    if not host_allowed(host, allowed_hosts):
        raise AdoUrlError(f"This Azure DevOps host is not allowed: {host}.")

    segments = _path_segments(parts.path)
    origin = f"https://{host}" if port is None else f"https://{host}:{port}"

    if source == "cloud" and host == CLOUD_HOST and len(segments) == 2:
        base_url = f"{origin}/{quote(segments[0], safe='')}"
    elif source == "cloud" and _is_visualstudio_host(host) and len(segments) == 1:
        base_url = origin
    elif source == "onprem" and len(segments) == 2:
        base_url = f"{origin}/{quote(segments[0], safe='')}"
    else:
        raise AdoUrlError(shape_error)

    project = segments[-1]
    return AdoProject(
        kind=source,
        base_url=base_url,
        project=project,
        project_url=f"{base_url}/{quote(project, safe='')}",
    )


def _ascii_host(host: str) -> str | None:
    """The lower-case IDNA (ASCII) form of `host`, or None when it is not a
    valid DNS name (LDH labels of 1-63 chars, no leading/trailing hyphen,
    `xn--` labels must be valid punycode). IP literals other than dotted IPv4
    are refused, as is anything with `\\`, `%`, spaces or control characters.
    """
    try:
        ascii_host = host.encode("idna").decode("ascii").lower()
    except UnicodeError:
        return None
    labels = ascii_host.split(".")
    if len(ascii_host) > 253 or not all(_LDH_LABEL.fullmatch(label) for label in labels):
        return None
    for label in labels:
        if label.startswith("xn--"):
            try:
                if label.encode("ascii").decode("idna").encode("idna").decode("ascii") != label:
                    return None
            except UnicodeError:
                return None
    return ascii_host


def _path_segments(path: str) -> list[str]:
    """Decoded, non-empty path segments up to (not including) the first `_…` one.

    Returns [] when a segment decodes to blank, `.`/`..`, contains `/` or a
    control character, has percent-escapes that are not valid UTF-8 (`%FF`) or
    is not UTF-8 encodable (a lone surrogate), so the shape check fails. A
    stray `%` that is not an escape (`%ZZ`) is kept literally and re-encoded.
    """
    segments: list[str] = []
    for raw in path.split("/"):
        if not raw:
            continue
        if raw.startswith("_"):
            break
        try:
            decoded = unquote(raw, errors="strict").strip()
        except UnicodeDecodeError:
            return []
        if (
            not decoded
            or decoded in (".", "..")
            or "/" in decoded
            or _CONTROL_CHARS.search(decoded)
            or not _utf8_encodable(decoded)
        ):
            return []
        segments.append(decoded)
    return segments


def _is_visualstudio_host(host: str) -> bool:
    return host.endswith(VISUALSTUDIO_SUFFIX) and host.count(".") == 2


def _utf8_encodable(text: str) -> bool:
    try:
        text.encode("utf-8")
    except UnicodeEncodeError:
        return False
    return True


def _non_blank(value: Any) -> bool:
    return isinstance(value, str) and bool(value.strip())
