import { describe, expect, it } from "vitest";
import {
  CLOUD_SHAPE,
  HTTPS_REQUIRED,
  ONPREM_SHAPE,
  PAT_REQUIRED,
  PLACEHOLDER,
  SOURCE_REQUIRED,
  URL_REQUIRED,
  sameProjectUrl,
  sourceOf,
  validateProjectUrl,
} from "./url";

// Cases mirror src/server/tests/test_ado_url.py (minus the server-only allowlist).
const ONPREM_HOST = "tfs-projects.cmf.criticalmanufacturing.com";
const both = [
  ["onprem", ONPREM_SHAPE],
  ["cloud", CLOUD_SHAPE],
] as const;

describe("adoUrl messages", () => {
  it("are verbatim the server's contract messages", () => {
    expect(SOURCE_REQUIRED).toBe("Choose the Azure DevOps source (On-Prem or Collaboration Hub).");
    expect(URL_REQUIRED).toBe("Enter the Azure DevOps project URL.");
    expect(PAT_REQUIRED).toBe("Enter a Personal Access Token.");
    expect(HTTPS_REQUIRED).toBe("The URL must start with https://.");
    expect(CLOUD_SHAPE).toBe("Collaboration Hub URLs look like https://dev.azure.com/<organization>/<project>.");
    expect(ONPREM_SHAPE).toBe("On-Prem URLs look like https://<server>/<collection>/<project>.");
  });

  it("has a placeholder per source", () => {
    expect(PLACEHOLDER.onprem).toBe(`https://${ONPREM_HOST}/ImplementationProjects/<PROJECT_NAME>`);
    expect(PLACEHOLDER.cloud).toBe("https://dev.azure.com/<ORGANIZATION>/<PROJECT_NAME>");
  });
});

describe("validateProjectUrl: valid URLs", () => {
  it.each([
    ["cloud", "https://dev.azure.com/contoso/Fabrikam"],
    ["cloud", "https://contoso.visualstudio.com/Fabrikam/"],
    ["onprem", `https://${ONPREM_HOST}/ImplementationProjects/PROJ_X`],
    ["onprem", "https://tfs.example.com:8443/Coll/Proj"],
    ["onprem", "https://dev.azure.com/contoso/Fabrikam"],
    ["onprem", "https://10.0.0.5:8443/Coll/Proj"],
    ["onprem", "https://tfs.example.com:/Coll/Proj"],
    ["cloud", "https://dev.azure.com/contoso/Fabrikam%20Plant%2BLine"],
    ["onprem", `https://${ONPREM_HOST}/My Collection/My Project`],
    ["cloud", "  HTTPS://Dev.Azure.com/contoso/Fabrikam  "],
    ["cloud", "https://dev.azure.com/o%ZZ/Fabrikam%20Plant"],
    ["cloud", "https://dev.azure.com/contoso/F%C3%A1brica"],
    ["onprem", `https://${"a".repeat(63)}.visualstudio.com/Coll/Proj`],
    ["onprem", "https://bücher.visualstudio.com/Coll/Proj"],
    ["onprem", "https://xn--bcher-kva.visualstudio.com/Coll/Proj"],
    ["onprem", "https://xn--ls8h.visualstudio.com/Coll/Proj"],
    ["onprem", "https://tfs.example.com/Co\nll/Proj"],
  ] as const)("%s %s", (source, url) => {
    expect(validateProjectUrl(source, url)).toBeNull();
  });

  it.each(["/", "/_apis/projects", "/_backlogs/backlog/Team/Epics", "/_workitems/edit/123", "/_boards/board/t/Team/Features", "/_git/repo", "?a=1", "#frag", "/_workitems?_a=edit&id=1#x", "//"])(
    "strips the suffix %s",
    (suffix) => {
      expect(validateProjectUrl("cloud", `https://dev.azure.com/contoso/Fabrikam${suffix}`)).toBeNull();
    },
  );
});

describe("validateProjectUrl: errors", () => {
  it("asks for a URL when blank", () => {
    expect(validateProjectUrl("cloud", "")).toBe(URL_REQUIRED);
    expect(validateProjectUrl("onprem", "   ")).toBe(URL_REQUIRED);
  });

  it.each(["http://dev.azure.com/contoso/Fabrikam", "dev.azure.com/contoso/Fabrikam", "ftp://dev.azure.com/a/b", "https:/x", "http://dev.azure.com/contoso/\ud800"])(
    "requires https: %s",
    (url) => {
      expect(validateProjectUrl("cloud", url)).toBe(HTTPS_REQUIRED);
    },
  );

  it.each([
    "https://dev.azure.com/contoso",
    "https://dev.azure.com/contoso/",
    "https://dev.azure.com/contoso/Fabrikam/extra",
    "https://dev.azure.com/_apis/projects",
    "https://dev.azure.com/contoso/%20",
    "https://contoso.visualstudio.com/",
    "https://contoso.visualstudio.com/Coll/Fabrikam",
    "https://a.b.visualstudio.com/Fabrikam",
    `https://${ONPREM_HOST}/ImplementationProjects/PROJ`,
    "https://",
    "https://user:secret@dev.azure.com/contoso/Fabrikam",
    "https://evil.example.com/a/b",
  ])("cloud shape error: %s", (url) => {
    expect(validateProjectUrl("cloud", url)).toBe(CLOUD_SHAPE);
  });

  it.each([
    `https://${ONPREM_HOST}/ImplementationProjects`,
    `https://${ONPREM_HOST}/`,
    `https://${ONPREM_HOST}/Coll/Proj/extra`,
    `https://${ONPREM_HOST}/_apis/projects`,
    `https://${ONPREM_HOST}/Coll/a%2Fb`,
    "https://contoso.visualstudio.com/Fabrikam",
    `https://${ONPREM_HOST}:notaport/Coll/Proj`,
    `https://${ONPREM_HOST}:70000/Coll/Proj`,
    "https://evil\\host/Coll/Proj",
    "https://[::1]/Coll/Proj",
    "https://[::1/Coll/Proj",
    "https://@tfs.example.com/Coll/Proj",
  ])("on-prem shape error: %s", (url) => {
    expect(validateProjectUrl("onprem", url)).toBe(ONPREM_SHAPE);
  });

  describe.each(both)("malformed hosts (%s)", (source, shape) => {
    it.each([
      "xn--zz.visualstudio.com",
      "xn--bcher-zz.visualstudio.com",
      "xn--99999999999.visualstudio.com",
      "x\u0000.visualstudio.com",
      "evil.com\\.visualstudio.com",
      "evil.com%2f.visualstudio.com",
      "evil.com .visualstudio.com",
      "-bad.visualstudio.com",
      "bad-.visualstudio.com",
      "a..visualstudio.com",
      `${"a".repeat(64)}.visualstudio.com`,
      "evil.com℀.visualstudio.com",
      "dev.azure.com.",
    ])("%s", (host) => {
      expect(validateProjectUrl(source, `https://${host}/Coll/Proj`)).toBe(shape);
    });
  });

  describe.each(both)("dot segments (%s)", (source, shape) => {
    const host = source === "cloud" ? "dev.azure.com" : ONPREM_HOST;
    it.each(["/../x", "/./x", "/a/..", "/%2e%2e/x", "/a/%2E"])("%s", (path) => {
      expect(validateProjectUrl(source, `https://${host}${path}`)).toBe(shape);
    });
  });

  describe.each(both)("unusable segments (%s)", (source, shape) => {
    const host = source === "cloud" ? "dev.azure.com" : ONPREM_HOST;
    it.each([
      "/Coll/Fab\ud800rikam",
      "/Co\udfffll/Proj",
      "/Coll/Proj?q=\ud800",
      "/Coll/Pr%00oj",
      "/Coll/Pr%1Foj",
      "/Coll/Pr%7Foj",
      "/Co%0All/Proj",
      "/Coll/Pr\x00oj",
      "/Coll/Pr%FFoj",
      "/Coll/%C3",
      "/Coll/%ED%A0%80",
    ])("%s", (path) => {
      expect(validateProjectUrl(source, `https://${host}${path}`)).toBe(shape);
    });
  });
});

describe("sourceOf", () => {
  it.each([
    ["https://dev.azure.com/org/Proj", "cloud"],
    ["https://org.visualstudio.com/Proj", "cloud"],
    ["  HTTPS://DEV.AZURE.COM/org/Proj  ", "cloud"],
    ["https://tfs.example.com/Collection/Proj", "onprem"],
    ["https://evil.example.com/dev.azure.com/Proj", "onprem"],
    ["https://notdev.azure.com.example.com/a/b", "onprem"],
    ["https://sub.dev.azure.com/org/Proj", "onprem"],
    ["https://a.b.visualstudio.com/Proj", "onprem"],
    ["https://visualstudio.com/Proj", "onprem"],
    ["https://org.visualstudio.com:443/Proj", "cloud"],
    ["https://DEV.azure.com:8443/org/Proj", "cloud"],
    ["http://dev.azure.com/org/Proj", "onprem"],
    ["not a url", "onprem"],
  ] as const)("%s -> %s", (url, source) => {
    expect(sourceOf(url)).toBe(source);
  });
});

describe("sameProjectUrl", () => {
  it("ignores case, surrounding whitespace and trailing slashes", () => {
    expect(sameProjectUrl("https://dev.azure.com/Org/Proj", " https://dev.azure.com/org/proj/ ")).toBe(true);
  });

  it("tells different projects apart", () => {
    expect(sameProjectUrl("https://dev.azure.com/org/A", "https://dev.azure.com/org/B")).toBe(false);
  });
});
