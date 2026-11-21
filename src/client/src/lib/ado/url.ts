import type { AdoSource } from "./types";

/**
 * Client-side check of an Azure DevOps project URL, mirroring the server's
 * `app/services/ado_url.py` (`parse_project_url`) so the same input gets the
 * same message without a network call. The host allowlist stays server-only.
 */

export const SOURCE_REQUIRED = "Choose the Azure DevOps source (On-Prem or Collaboration Hub).";
export const PROJECT_REQUIRED = "Select an Azure DevOps project.";
export const URL_REQUIRED = "Enter the Azure DevOps project URL.";
export const PAT_REQUIRED = "Enter a Personal Access Token.";
export const HTTPS_REQUIRED = "The URL must start with https://.";
export const CLOUD_SHAPE = "Collaboration Hub URLs look like https://dev.azure.com/<organization>/<project>.";
export const ONPREM_SHAPE = "On-Prem URLs look like https://<server>/<collection>/<project>.";

/** Example project URL shown as the input placeholder, per source. */
export const PLACEHOLDER: Readonly<Record<AdoSource, string>> = {
  onprem: "https://tfs-projects.cmf.criticalmanufacturing.com/ImplementationProjects/<PROJECT_NAME>",
  cloud: "https://dev.azure.com/<ORGANIZATION>/<PROJECT_NAME>",
};

/** Display label of each source. */
export const SOURCE_LABELS: Readonly<Record<AdoSource, string>> = {
  onprem: "On-Prem",
  cloud: "Collaboration Hub",
};

/**
 * The Azure DevOps source a stored project URL belongs to, by the server's rule
 * (`parse_project_url`): "cloud" only for host `dev.azure.com` or
 * `<org>.visualstudio.com` (exactly one label before `visualstudio.com`);
 * anything else (or an unparsable URL) is "onprem".
 */
export function sourceOf(url: string): AdoSource {
  const stripped = pyStrip(url);
  if (!stripped.toLowerCase().startsWith("https://") || LONE_SURROGATE.test(stripped)) {
    return "onprem";
  }
  const rest = stripped.replace(/[\t\r\n]/g, "").slice("https://".length);
  const netlocEnd = rest.search(/[/?#]/);
  const parsed = splitNetloc(netlocEnd < 0 ? rest : rest.slice(0, netlocEnd));
  if (parsed === null) {
    return "onprem";
  }
  const { host } = parsed;
  return host === CLOUD_HOST || (host.endsWith(VISUALSTUDIO_SUFFIX) && host.split(".").length === 3) ? "cloud" : "onprem";
}

/** Whether two project URLs are the same project: compared case-insensitively, ignoring surrounding whitespace and trailing slashes. */
export function sameProjectUrl(a: string, b: string): boolean {
  const normalize = (url: string) => url.trim().replace(/\/+$/, "").toLowerCase();
  return normalize(a) === normalize(b);
}

const CLOUD_HOST = "dev.azure.com";
const VISUALSTUDIO_SUFFIX = ".visualstudio.com";
const LDH_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
/** Characters Python's `str.strip()` removes (`str.isspace()`). */
const PY_SPACE = "\\t\\n\\x0b\\x0c\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const PY_STRIP = new RegExp(`^[${PY_SPACE}]+|[${PY_SPACE}]+$`, "g");
const PERCENT_RUN = /(?:%[0-9A-Fa-f]{2})+/g;

function pyStrip(text: string): string {
  return text.replace(PY_STRIP, "");
}

/**
 * Whether `input` (an `xn--` label without the prefix) is well-formed RFC 3492
 * punycode, like Python's `punycode` codec. Done here rather than relying on
 * the URL parser, since newer ones (Node 24+, recent browsers) accept
 * incomplete strings such as `zz`.
 */
function isValidPunycode(input: string): boolean {
  const base = 36;
  const tMin = 1;
  const tMax = 26;
  const maxInt = 0x7fffffff;
  const adapt = (delta: number, numPoints: number, firstTime: boolean): number => {
    delta = firstTime ? Math.floor(delta / 700) : delta >> 1;
    delta += Math.floor(delta / numPoints);
    let k = 0;
    while (delta > ((base - tMin) * tMax) >> 1) {
      delta = Math.floor(delta / (base - tMin));
      k += base;
    }
    return k + Math.floor(((base - tMin + 1) * delta) / (delta + 38));
  };
  const digit = (code: number): number =>
    code >= 0x30 && code <= 0x39 ? code - 22 : code >= 0x61 && code <= 0x7a ? code - 0x61 : base;

  const delimiter = input.lastIndexOf("-");
  let length = delimiter < 0 ? 0 : delimiter;
  let n = 0x80;
  let i = 0;
  let bias = 72;
  for (let pos = delimiter < 0 ? 0 : delimiter + 1; pos < input.length; ) {
    const oldI = i;
    for (let w = 1, k = base; ; k += base) {
      if (pos >= input.length) {
        return false; // incomplete
      }
      const d = digit(input.charCodeAt(pos++));
      if (d >= base || d > Math.floor((maxInt - i) / w)) {
        return false;
      }
      i += d * w;
      const t = k <= bias ? tMin : k >= bias + tMax ? tMax : k - bias;
      if (d < t) {
        break;
      }
      w *= base - t;
    }
    length += 1;
    bias = adapt(i - oldI, length, oldI === 0);
    n += Math.floor(i / length);
    if (n > 0x10ffff) {
      return false;
    }
    i %= length;
    i += 1;
  }
  return true;
}

/**
 * The lower-case ASCII (IDNA) form of `host`, or `null` when it is not a valid
 * DNS name (LDH labels of 1-63 chars, no leading/trailing hyphen, valid `xn--`
 * punycode). Non-ASCII hosts are converted with the browser's URL parser (UTS
 * #46), which is close to, but not exactly, Python's IDNA 2003 codec.
 */
function asciiHost(host: string): string | null {
  let ascii = host.toLowerCase();
  if (/[^\x00-\x7f]/.test(ascii)) {
    if (/[^a-z0-9.\-\u0080-￿]/.test(ascii)) {
      return null;
    }
    try {
      ascii = new URL(`https://${ascii}/`).hostname.toLowerCase();
    } catch {
      return null;
    }
  }
  const labels = ascii.split(".");
  if (ascii.length > 253 || !labels.every((label) => LDH_LABEL.test(label))) {
    return null;
  }
  for (const label of labels) {
    if (label.startsWith("xn--")) {
      if (!isValidPunycode(label.slice(4))) {
        return null;
      }
      try {
        new URL(`https://${label}/`);
      } catch {
        return null;
      }
    }
  }
  return ascii;
}

/**
 * Python's `unquote(text, errors="strict")`: runs of `%XX` escapes are decoded
 * as UTF-8; a `%` that is not an escape stays literal.
 * @throws TypeError when an escape run is not valid UTF-8.
 */
function unquoteStrict(text: string): string {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  return text.replace(PERCENT_RUN, (run) => {
    const bytes = new Uint8Array(run.length / 3);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = parseInt(run.slice(i * 3 + 1, i * 3 + 3), 16);
    }
    return decoder.decode(bytes);
  });
}

/** Decoded, non-empty path segments up to the first `_…` one; `[]` when a segment is unusable. */
function pathSegments(path: string): string[] {
  const segments: string[] = [];
  for (const raw of path.split("/")) {
    if (!raw) {
      continue;
    }
    if (raw.startsWith("_")) {
      break;
    }
    let decoded: string;
    try {
      decoded = pyStrip(unquoteStrict(raw));
    } catch {
      return [];
    }
    if (!decoded || decoded === "." || decoded === ".." || decoded.includes("/") || CONTROL_CHARS.test(decoded)) {
      return [];
    }
    segments.push(decoded);
  }
  return segments;
}

/** Python `urlsplit` netloc checks: `null` when the netloc is unusable, else the parsed host and port. */
function splitNetloc(netloc: string): { host: string; port: number | null } | null {
  if (netloc.includes("[") || netloc.includes("]") || netloc.includes("@")) {
    return null;
  }
  if (/[^\x00-\x7f]/.test(netloc)) {
    const normalized = netloc.replace(/[@:#?]/g, "").normalize("NFKC");
    if (/[/?#@:]/.test(normalized)) {
      return null;
    }
  }
  const colon = netloc.indexOf(":");
  const hostname = colon < 0 ? netloc : netloc.slice(0, colon);
  const portText = colon < 0 ? "" : netloc.slice(colon + 1);
  let port: number | null = null;
  if (portText) {
    if (!/^[0-9]+$/.test(portText) || Number(portText) > 65535) {
      return null;
    }
    port = Number(portText);
  }
  const host = hostname ? asciiHost(hostname) : null;
  return host === null ? null : { host, port };
}

/**
 * The first rule `url` breaks for the selected source, as the server's message,
 * or `null` when its shape is valid. Checked in order: https scheme, host
 * syntax, then the shape for the source (Collaboration Hub:
 * `https://dev.azure.com/<org>/<project>` or `https://<org>.visualstudio.com/<project>`;
 * On-Prem: `https://<host>/<collection>/<project>`). A trailing `/`, the first
 * `/_…` segment and everything after it, the query and the fragment are ignored.
 * Blank input gives `URL_REQUIRED`. Whether the host is allowed is only known
 * to the server.
 */
export function validateProjectUrl(source: AdoSource, url: string): string | null {
  const shapeError = source === "cloud" ? CLOUD_SHAPE : ONPREM_SHAPE;
  const stripped = pyStrip(url);
  if (!stripped) {
    return URL_REQUIRED;
  }
  if (!stripped.toLowerCase().startsWith("https://")) {
    return HTTPS_REQUIRED;
  }
  if (LONE_SURROGATE.test(stripped)) {
    return shapeError;
  }

  const rest = stripped.replace(/[\t\r\n]/g, "").slice("https://".length);
  const netlocEnd = rest.search(/[/?#]/);
  const netloc = netlocEnd < 0 ? rest : rest.slice(0, netlocEnd);
  const path = (netlocEnd < 0 ? "" : rest.slice(netlocEnd)).split("#")[0].split("?")[0];

  const parsed = splitNetloc(netloc);
  if (parsed === null) {
    return shapeError;
  }
  const { host } = parsed;
  const segments = pathSegments(path);
  const isVisualStudio = host.endsWith(VISUALSTUDIO_SUFFIX) && host.split(".").length === 3;
  const valid =
    (source === "cloud" && host === CLOUD_HOST && segments.length === 2) ||
    (source === "cloud" && isVisualStudio && segments.length === 1) ||
    (source === "onprem" && segments.length === 2);
  return valid ? null : shapeError;
}
