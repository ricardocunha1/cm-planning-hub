import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "./components/Toast";
import type { AuthUser } from "./lib/auth/types";
import { SettingsProvider, useSettings } from "./settingsStore";

// The real AuthProvider can only change user through the Google login redirect, so the auth
// hook is replaced by a controllable one; the settings store, API client and fetch path are real.
const auth = vi.hoisted(() => ({ user: null as AuthUser | null }));
vi.mock("./authStore", () => ({ useAuth: () => ({ user: auth.user }) }));

const A: AuthUser = { id: 1, name: "A", email: "a@example.com", pictureUrl: null };
const B: AuthUser = { id: 2, name: "B", email: "b@example.com", pictureUrl: null };
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const cred = (id: number, projectName: string) => ({ id, projectName, projectUrl: `https://dev.azure.com/o/${projectName}`, hasPat: true, patLast4: null });

function Probe() {
  const { items, status, ensureLoaded } = useSettings();
  return (
    <div>
      <button onClick={() => void ensureLoaded()}>load</button>
      <p data-testid="status">{status}</p>
      <ul>
        {items.map((item) => (
          <li key={item.id}>{item.projectName}</li>
        ))}
      </ul>
    </div>
  );
}
// A fresh element each time, so a rerender is not bailed out of.
const tree = () => (
  <ToastProvider>
    <SettingsProvider>
      <Probe />
    </SettingsProvider>
  </ToastProvider>
);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("settings store when the signed-in user changes", () => {
  it("shows nothing of the previous user after sign-out and sign-in as someone else", async () => {
    auth.user = A;
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockImplementation(async () => json({ items: [cred(auth.user === A ? 1 : 9, auth.user === A ? "AlphaOnly" : "BetaOnly")] })));
    const user = userEvent.setup();
    const view = render(tree());
    await user.click(screen.getByText("load"));
    expect(await screen.findByText("AlphaOnly")).toBeInTheDocument();

    auth.user = null; // signed out
    view.rerender(tree());
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("idle"));
    expect(screen.queryByText("AlphaOnly")).not.toBeInTheDocument();

    auth.user = B;
    view.rerender(tree());
    expect(screen.queryByText("AlphaOnly")).not.toBeInTheDocument();
    await user.click(screen.getByText("load"));
    expect(await screen.findByText("BetaOnly")).toBeInTheDocument();
    expect(screen.queryByText("AlphaOnly")).not.toBeInTheDocument();
  });

  it("ignores a response that arrives after the user changed", async () => {
    auth.user = A;
    let resolveA: (response: Response) => void = () => {};
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockImplementationOnce(() => new Promise<Response>((resolve) => (resolveA = resolve))),
    );
    const user = userEvent.setup();
    const view = render(tree());
    await user.click(screen.getByText("load"));
    expect(screen.getByTestId("status")).toHaveTextContent("loading");

    auth.user = B;
    view.rerender(tree());
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("idle"));
    await act(async () => {
      resolveA(json({ items: [cred(1, "AlphaOnly")] }));
    });
    expect(screen.queryByText("AlphaOnly")).not.toBeInTheDocument();
    expect(screen.getByTestId("status")).toHaveTextContent("idle");
  });
});
