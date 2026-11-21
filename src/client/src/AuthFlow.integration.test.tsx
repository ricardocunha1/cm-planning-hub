import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { simulate, validate } from "./lib/monteCarlo/api";
import { putJson, deleteRequest } from "./lib/ado/api";
import { renderApp } from "./test/renderApp";

// Auth, full-app integration with fetch mocked at the network boundary only:
// the login error codes the server redirects with, the CSRF header on every
// kind of mutating request, and what a mid-session 401 does to the app.

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

beforeEach(() => {
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// Codes emitted by app/services/auth.py (ERROR_*); each must have its own message.
const SERVER_CODES = [
  "login_failed",
  "access_denied",
  "state_mismatch",
  "invalid_claims",
  "email_not_verified",
  "domain_not_allowed",
];

describe("login error codes from the server redirect", () => {
  it.each(SERVER_CODES)("shows a specific message for ?error=%s", (code) => {
    renderApp(`/login?error=${code}`, { initialUser: null });
    const alert = screen.getByRole("alert");
    expect(alert.textContent).not.toBe("Sign-in failed. Please try again.");
    expect(alert.textContent?.length).toBeGreaterThan(10);
  });

  it("shows the generic message for an unknown code and never reflects it", () => {
    renderApp("/login?error=<img src=x onerror=alert(1)>", { initialUser: null });
    expect(screen.getByRole("alert")).toHaveTextContent("Sign-in failed. Please try again.");
    expect(document.querySelector("img[src='x']")).toBeNull();
  });

  it("does not show an alert without an error code", () => {
    renderApp("/login", { initialUser: null });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("does not redirect anywhere from ?next-style parameters (no open redirect)", () => {
    renderApp("/login?next=https://evil.example&redirect=//evil.example", { initialUser: null });
    expect(screen.getByTestId("location")).toHaveTextContent("/login");
  });
});

describe("CSRF header on the network boundary", () => {
  function stubOk() {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => json({}));
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }
  const headersOf = (fetchMock: ReturnType<typeof stubOk>) =>
    new Headers(fetchMock.mock.calls[0][1]?.headers as HeadersInit);

  it("is sent on the multipart /api/validate upload without breaking the multipart content type", async () => {
    const fetchMock = stubOk();
    await validate(new FormData());
    const headers = headersOf(fetchMock);
    expect(headers.get("X-Requested-With")).toBe("planning-hub");
    expect(headers.get("Content-Type")).toBeNull(); // the browser sets the multipart boundary
  });

  it("is sent on simulate, PUT and DELETE", async () => {
    for (const call of [
      () => simulate({} as never, {} as never),
      () => putJson("/api/plan/1", {}),
      () => deleteRequest("/api/plan/1"),
    ]) {
      const fetchMock = stubOk();
      await call().catch(() => {});
      expect(headersOf(fetchMock).get("X-Requested-With")).toBe("planning-hub");
      vi.unstubAllGlobals();
    }
  });

  it("is not needed on GET calls (the session check carries none)", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(json({ id: 1, name: "A", email: "a@b.c", pictureUrl: null }));
    vi.stubGlobal("fetch", fetchMock);
    const { getMe } = await import("./lib/auth/api");
    await getMe();
    expect(new Headers(fetchMock.mock.calls[0][1]?.headers as HeadersInit).get("X-Requested-With")).toBeNull();
  });
});

describe("mid-session 401", () => {
  it("returns to /login from the Monte Carlo flow when a mutating call answers 401", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(json({ errors: ["Authentication required."] }, 401));
    vi.stubGlobal("fetch", fetchMock);
    renderApp("/monte-carlo/input");
    await expect(validate(new FormData())).rejects.toMatchObject({ status: 401 });
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/login"));
    expect(screen.getByRole("button", { name: "Login with SSO" })).toBeInTheDocument();
  });

  it("login button navigates the browser to the server endpoint", async () => {
    const assign = vi.fn();
    vi.spyOn(window, "location", "get").mockReturnValue({ ...window.location, assign } as unknown as Location);
    renderApp("/login", { initialUser: null });
    await userEvent.click(screen.getByRole("button", { name: "Login with SSO" }));
    expect(assign).toHaveBeenCalledWith("/api/auth/login");
  });
});
