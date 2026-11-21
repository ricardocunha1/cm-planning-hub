import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthProvider, useAuth } from "./authStore";
import { ToastProvider } from "./components/Toast";
import { SettingsProvider, useSettings } from "./settingsStore";
import { CREDENTIALS } from "./test/settingsFixtures";
import { TEST_USER } from "./test/authFixtures";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function Probe() {
  const { items, status, ensureLoaded, load, add, update, remove, settingsOpen, openSettings, closeSettings } = useSettings();
  return (
    <div>
      <p data-testid="status">{status}</p>
      <p data-testid="open">{String(settingsOpen)}</p>
      <button onClick={openSettings}>open settings</button>
      <button onClick={closeSettings}>close settings</button>
      <p data-testid="names">{items.map((item) => item.projectName).join(",")}</p>
      <button onClick={() => void ensureLoaded()}>ensure</button>
      <button onClick={() => void load()}>load</button>
      <button onClick={() => void add({ projectName: "Gamma", projectUrl: "https://dev.azure.com/o/G", pat: "p" })}>add</button>
      <button onClick={() => void update(1, { projectName: "Alpha2", projectUrl: CREDENTIALS[0].projectUrl })}>update</button>
      <button onClick={() => void remove(2)}>remove</button>
    </div>
  );
}

function SignOutButton() {
  const { signOut } = useAuth();
  return <button onClick={() => void signOut()}>sign out</button>;
}

function Harness({ children }: { children: ReactNode }) {
  return (
    <ToastProvider>
      <AuthProvider initialUser={TEST_USER}>
        <SettingsProvider>{children}</SettingsProvider>
        <SignOutButton />
      </AuthProvider>
    </ToastProvider>
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("SettingsProvider", () => {
  it("does not fetch on mount", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(
      <Harness>
        <Probe />
      </Harness>,
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByTestId("status")).toHaveTextContent("idle");
  });

  it("ensureLoaded fetches once", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ items: CREDENTIALS }));
    vi.stubGlobal("fetch", fetchMock);
    render(
      <Harness>
        <Probe />
      </Harness>,
    );
    await userEvent.click(screen.getByText("ensure"));
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("ready"));
    expect(screen.getByTestId("names")).toHaveTextContent("Alpha,Beta");
    await userEvent.click(screen.getByText("ensure"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("starts loaded from initialItems without fetching", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(
      <ToastProvider>
        <AuthProvider initialUser={TEST_USER}>
          <SettingsProvider initialItems={CREDENTIALS}>
            <Probe />
          </SettingsProvider>
        </AuthProvider>
      </ToastProvider>,
    );
    expect(screen.getByTestId("status")).toHaveTextContent("ready");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("goes to error status and toasts when loading fails, then retries", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ errors: ["Not found."] }, 404))
      .mockResolvedValueOnce(json({ items: CREDENTIALS }));
    vi.stubGlobal("fetch", fetchMock);
    render(
      <Harness>
        <Probe />
      </Harness>,
    );
    await userEvent.click(screen.getByText("ensure"));
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("error"));
    expect(screen.getByRole("alert")).toHaveTextContent("Not found.");
    await userEvent.click(screen.getByText("ensure"));
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("ready"));
  });

  it("adds, updates and removes items in state", async () => {
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        return Promise.resolve(json({ id: 3, projectName: "Gamma", projectUrl: "https://dev.azure.com/o/G", hasPat: true, patLast4: null }, 201));
      }
      if (init?.method === "PUT") {
        return Promise.resolve(json({ ...CREDENTIALS[0], projectName: "Alpha2" }));
      }
      if (init?.method === "DELETE") {
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      return Promise.resolve(json({ items: CREDENTIALS }));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(
      <Harness>
        <Probe />
      </Harness>,
    );
    await userEvent.click(screen.getByText("ensure"));
    await waitFor(() => expect(screen.getByTestId("names")).toHaveTextContent("Alpha,Beta"));
    await userEvent.click(screen.getByText("add"));
    await waitFor(() => expect(screen.getByTestId("names")).toHaveTextContent("Alpha,Beta,Gamma"));
    await userEvent.click(screen.getByText("update"));
    await waitFor(() => expect(screen.getByTestId("names")).toHaveTextContent("Alpha2,Beta,Gamma"));
    await userEvent.click(screen.getByText("remove"));
    await waitFor(() => expect(screen.getByTestId("names")).toHaveTextContent("Alpha2,Gamma"));
  });

  it("clears the state when the user signs out", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init?: RequestInit) =>
        Promise.resolve(init?.method === "POST" ? new Response(null, { status: 204 }) : json({ items: CREDENTIALS })),
      ),
    );
    render(
      <Harness>
        <Probe />
      </Harness>,
    );
    await userEvent.click(screen.getByText("ensure"));
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("ready"));
    await userEvent.click(screen.getByText("sign out"));
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("idle"));
    expect(screen.getByTestId("names")).toBeEmptyDOMElement();
  });

  it("opens and closes the Settings modal state without fetching", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(
      <Harness>
        <Probe />
      </Harness>,
    );
    expect(screen.getByTestId("open")).toHaveTextContent("false");
    await userEvent.click(screen.getByText("open settings"));
    expect(screen.getByTestId("open")).toHaveTextContent("true");
    await userEvent.click(screen.getByText("close settings"));
    expect(screen.getByTestId("open")).toHaveTextContent("false");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("useSettings outside the provider throws", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const swallow = (event: ErrorEvent) => event.preventDefault(); // jsdom reports the render error on window
    window.addEventListener("error", swallow);
    expect(() => render(<Probe />)).toThrow("useSettings must be used inside a SettingsProvider");
    window.removeEventListener("error", swallow);
    spy.mockRestore();
  });
});
