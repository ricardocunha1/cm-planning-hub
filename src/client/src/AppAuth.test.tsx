import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appRoutes } from "./App";
import { AuthProvider } from "./authStore";
import { ToastProvider } from "./components/Toast";
import { ForecastProvider } from "./monteCarloStore";
import { TEST_USER } from "./test/authFixtures";
import { renderApp } from "./test/renderApp";
import { ProbeLayout } from "./test/render";

const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

beforeEach(() => {
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("route guard", () => {
  it("redirects an anonymous visitor to /login from any protected route", () => {
    renderApp("/monte-carlo", { initialUser: null });
    expect(screen.getByTestId("location")).toHaveTextContent("/login");
    expect(screen.getByRole("button", { name: "Login with SSO" })).toBeInTheDocument();
  });

  it("redirects an anonymous visitor from an unknown path to /login", () => {
    renderApp("/nope", { initialUser: null });
    expect(screen.getByTestId("location")).toHaveTextContent("/login");
  });

  it("shows the protected page to a signed-in user", () => {
    renderApp("/");
    expect(screen.getByTestId("location")).toHaveTextContent("/");
    expect(screen.getByRole("link", { name: "Open Monte Carlo" })).toBeInTheDocument();
  });

  it("redirects /login to / when already signed in", () => {
    renderApp("/login");
    expect(screen.getByTestId("location")).toHaveTextContent(/^\/$/);
    expect(screen.queryByRole("button", { name: "Login with SSO" })).not.toBeInTheDocument();
  });

  it("shows the login page to an anonymous visitor at /login", () => {
    renderApp("/login", { initialUser: null });
    expect(screen.getByRole("heading", { name: "CM Planning Hub" })).toBeInTheDocument();
  });
});

describe("session check", () => {
  function renderWithMe(path: string, me: Promise<Response>) {
    const fetchMock = vi.fn<typeof fetch>().mockReturnValue(me);
    vi.stubGlobal("fetch", fetchMock);
    const router = createMemoryRouter([{ element: <ProbeLayout />, children: appRoutes }], { initialEntries: [path] });
    render(
      <ToastProvider>
        <AuthProvider>
          <ForecastProvider>
            <RouterProvider router={router} />
          </ForecastProvider>
        </AuthProvider>
      </ToastProvider>,
    );
    return fetchMock;
  }

  it("shows a spinner while /api/auth/me is pending, without redirecting", () => {
    renderWithMe("/monte-carlo", new Promise<Response>(() => {}));
    expect(screen.getByRole("status", { name: "Checking your session" })).toBeInTheDocument();
    expect(screen.getByTestId("location")).toHaveTextContent("/monte-carlo");
  });

  it("opens the requested page once /api/auth/me returns the user", async () => {
    const fetchMock = renderWithMe("/", Promise.resolve(jsonResponse(TEST_USER)));
    expect(await screen.findByRole("link", { name: "Open Monte Carlo" })).toBeInTheDocument();
    expect(fetchMock.mock.calls[0][0]).toBe("/api/auth/me");
  });

  it("redirects to /login when /api/auth/me answers 401", async () => {
    renderWithMe("/release-plan", Promise.resolve(jsonResponse({ errors: ["Not authenticated."] }, 401)));
    expect(await screen.findByRole("button", { name: "Login with SSO" })).toBeInTheDocument();
    expect(screen.getByTestId("location")).toHaveTextContent("/login");
  });
});

describe("session expiry and sign-out", () => {
  it("sends the user to /login when an API call answers 401 (expired session)", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ errors: ["Not authenticated."] }, 401));
    vi.stubGlobal("fetch", fetchMock);
    renderApp("/release-plan");
    // The plan list loads on mount; its 401 flags the session as gone.
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/login"));
    expect(screen.getByRole("button", { name: "Login with SSO" })).toBeInTheDocument();
  });

  it("signs out through POST /api/auth/logout and lands on /login", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    renderApp("/");
    await userEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/login"));
    expect(fetchMock).toHaveBeenCalledWith("/api/auth/logout", expect.objectContaining({ method: "POST" }));
  });
});
