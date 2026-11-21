import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdoCredential } from "./lib/settings/types";
import { renderApp } from "./test/renderApp";

// Settings (Azure DevOps PATs), full-app integration with fetch mocked at the network
// boundary only: lazy loading, add / edit / delete through the real modal, the PAT never
// leaking out of the password field, the CSRF header, and a mid-use 401.

const SECRET = "SECRET-PAT-0123456789abcdef";
const LIST = "/api/settings/ado-credentials";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

interface Call {
  method: string;
  url: string;
  headers: Headers;
  body: Record<string, unknown> | null;
}

/** In-memory stand-in for the settings endpoints; `calls` records every request. */
function stubServer(initial: AdoCredential[] = [], overrides: { list?: () => Response } = {}) {
  let items = [...initial];
  let nextId = 100;
  const calls: Call[] = [];
  const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({
      method,
      url,
      headers: new Headers(init?.headers as HeadersInit),
      body: typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null,
    });
    const body = calls[calls.length - 1].body;
    if (url === LIST && method === "GET") {
      return overrides.list ? overrides.list() : json({ items });
    }
    if (url === LIST && method === "POST") {
      const created = { id: nextId++, projectName: String(body?.projectName), projectUrl: String(body?.projectUrl), hasPat: true, patLast4: null };
      items = [...items, created];
      return json(created, 201);
    }
    const id = Number(url.slice(LIST.length + 1));
    if (method === "PUT") {
      const updated = { id, projectName: String(body?.projectName), projectUrl: String(body?.projectUrl), hasPat: true, patLast4: null };
      items = items.map((item) => (item.id === id ? updated : item));
      return json(updated);
    }
    if (method === "DELETE") {
      items = items.filter((item) => item.id !== id);
      return new Response(null, { status: 204 });
    }
    return json({ errors: ["unexpected request"] }, 500);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls, settingsCalls: () => calls.filter((call) => call.url.startsWith(LIST)) };
}

const ALPHA: AdoCredential = { id: 1, projectName: "Alpha", projectUrl: "https://dev.azure.com/org/Alpha", hasPat: true, patLast4: null };

async function openSettings(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Settings" }));
  return screen.findByRole("dialog", { name: "Settings" });
}

beforeEach(() => {
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe("settings flow through the app", () => {
  it("does not fetch settings before the modal is opened, then loads once", async () => {
    const server = stubServer([ALPHA]);
    const user = userEvent.setup();
    renderApp("/");
    await screen.findByRole("button", { name: "Settings" });
    expect(server.settingsCalls()).toHaveLength(0);

    const dialog = await openSettings(user);
    expect(await within(dialog).findByText("Alpha")).toBeInTheDocument();
    expect(server.settingsCalls().map((call) => call.method)).toEqual(["GET"]);

    // Closing and reopening does not fetch again.
    await user.click(within(dialog).getByRole("button", { name: "Close" }));
    await openSettings(user);
    expect(server.settingsCalls()).toHaveLength(1);
  });

  it("adds, edits without a PAT and deletes via confirm; the PAT never leaks and mutating calls carry the CSRF header", async () => {
    const server = stubServer();
    const user = userEvent.setup();
    renderApp("/");
    const dialog = await openSettings(user);
    expect(await within(dialog).findByText("No saved projects yet.")).toBeInTheDocument();

    // Add
    await user.click(within(dialog).getByRole("button", { name: "Add project" }));
    await user.type(within(dialog).getByLabelText("Project name"), "  Gamma  ");
    await user.type(within(dialog).getByLabelText("Project URL"), "https://dev.azure.com/org/Gamma/");
    const patInput = within(dialog).getByLabelText("Personal Access Token");
    expect(patInput).toHaveAttribute("type", "password");
    expect(patInput).toHaveAttribute("autocomplete", "off");
    await user.type(patInput, SECRET);
    // Typed value is only in the input's value, never as text.
    expect(document.body.textContent).not.toContain(SECRET);
    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    expect(await within(dialog).findByText("Gamma")).toBeInTheDocument();
    const post = server.settingsCalls().find((call) => call.method === "POST")!;
    expect(post.url).toBe(LIST);
    expect(post.body).toEqual({ projectName: "Gamma", projectUrl: "https://dev.azure.com/org/Gamma/", pat: SECRET });
    expect(post.headers.get("X-Requested-With")).toBe("planning-hub");
    expect(within(dialog).queryByLabelText("Personal Access Token")).not.toBeInTheDocument();
    expect(within(dialog).getAllByRole("img", { name: "Personal Access Token saved" }).length).toBeGreaterThan(0);
    expect(within(dialog).queryByText(/PAT saved/)).not.toBeInTheDocument();

    // Edit without PAT: body has no pat key.
    await user.click(within(dialog).getByRole("button", { name: "Edit Gamma" }));
    const nameInput = within(dialog).getByLabelText("Project name");
    expect(within(dialog).getByLabelText("Personal Access Token")).toHaveValue("");
    await user.clear(nameInput);
    await user.type(nameInput, "Gamma 2");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(await within(dialog).findByText("Gamma 2")).toBeInTheDocument();
    const put = server.settingsCalls().find((call) => call.method === "PUT")!;
    expect(put.url).toBe(`${LIST}/100`);
    expect(Object.keys(put.body!)).not.toContain("pat");
    expect(put.headers.get("X-Requested-With")).toBe("planning-hub");

    // Delete: cancel first, then confirm.
    await user.click(within(dialog).getByRole("button", { name: "Delete Gamma 2" }));
    const confirm = await screen.findByRole("dialog", { name: "Delete project?" });
    await user.click(within(confirm).getByRole("button", { name: "Cancel" }));
    expect(server.settingsCalls().some((call) => call.method === "DELETE")).toBe(false);
    await user.click(within(dialog).getByRole("button", { name: "Delete Gamma 2" }));
    await user.click(within(await screen.findByRole("dialog", { name: "Delete project?" })).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(within(dialog).queryByText("Gamma 2")).not.toBeInTheDocument());
    const del = server.settingsCalls().find((call) => call.method === "DELETE")!;
    expect(del.url).toBe(`${LIST}/100`);
    expect(del.headers.get("X-Requested-With")).toBe("planning-hub");

    // The PAT is in no URL, no storage, no DOM text, and only in the POST body.
    expect(server.calls.filter((call) => call.url.includes(SECRET))).toEqual([]);
    expect(server.calls.filter((call) => JSON.stringify(call.body ?? {}).includes(SECRET)).map((call) => call.method)).toEqual(["POST"]);
    expect(JSON.stringify({ ...window.localStorage })).not.toContain(SECRET);
    expect(JSON.stringify({ ...window.sessionStorage })).not.toContain(SECRET);
    expect(document.body.innerHTML).not.toContain(SECRET);
  });

  it("clears the typed PAT on Cancel and when the modal is closed and reopened", async () => {
    stubServer([ALPHA]);
    const user = userEvent.setup();
    renderApp("/");
    let dialog = await openSettings(user);
    await user.click(await within(dialog).findByRole("button", { name: "Edit Alpha" }));
    await user.type(within(dialog).getByLabelText("Personal Access Token"), SECRET);
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await user.click(within(dialog).getByRole("button", { name: "Edit Alpha" }));
    expect(within(dialog).getByLabelText("Personal Access Token")).toHaveValue("");

    await user.type(within(dialog).getByLabelText("Personal Access Token"), SECRET);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Settings" })).not.toBeInTheDocument());
    dialog = await openSettings(user);
    expect(within(dialog).queryByLabelText("Personal Access Token")).not.toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain(SECRET);
  });

  it("shows validation errors without any request and keeps server errors (and no PAT) in the toast", async () => {
    const server = stubServer([ALPHA]);
    const user = userEvent.setup();
    renderApp("/");
    const dialog = await openSettings(user);
    await user.click(await within(dialog).findByRole("button", { name: "Add project" }));
    await user.type(within(dialog).getByLabelText("Project URL"), "http://dev.azure.com/org/x");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Enter a project name.");
    expect(within(dialog).getByRole("alert")).toHaveTextContent("The URL must start with https://.");
    expect(within(dialog).getByRole("alert")).toHaveTextContent("Enter a Personal Access Token.");
    expect(server.settingsCalls().filter((call) => call.method !== "GET")).toHaveLength(0);

    // A 422 from the server is shown in a toast and the form stays open.
    vi.mocked(fetch).mockImplementation(async (_input, init) =>
      (init?.method ?? "GET") === "POST" ? json({ errors: ["That project is already saved."] }, 422) : json({ items: [ALPHA] }),
    );
    await user.clear(within(dialog).getByLabelText("Project URL"));
    await user.type(within(dialog).getByLabelText("Project name"), "Dup");
    await user.type(within(dialog).getByLabelText("Project URL"), "https://dev.azure.com/org/Alpha");
    await user.type(within(dialog).getByLabelText("Personal Access Token"), SECRET);
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    const toast = (await screen.findAllByRole("alert")).find((el) => el.textContent?.includes("already saved"))!;
    expect(toast).toHaveTextContent("Could not save the project");
    expect(document.body.textContent).not.toContain(SECRET);
    expect(within(dialog).getByLabelText("Project name")).toHaveValue("Dup");
  });

  it("does not submit twice on a double click while the request is pending", async () => {
    const server = stubServer();
    const user = userEvent.setup();
    renderApp("/");
    const dialog = await openSettings(user);
    await user.click(await within(dialog).findByRole("button", { name: "Add project" }));
    await user.type(within(dialog).getByLabelText("Project name"), "Dbl");
    await user.type(within(dialog).getByLabelText("Project URL"), "https://dev.azure.com/org/Dbl");
    await user.type(within(dialog).getByLabelText("Personal Access Token"), SECRET);
    await user.dblClick(within(dialog).getByRole("button", { name: "Save" }));
    await within(dialog).findByText("Dbl");
    expect(server.settingsCalls().filter((call) => call.method === "POST")).toHaveLength(1);
  });

  it("Esc closes only the confirm dialog while it is stacked on the settings modal", async () => {
    stubServer([ALPHA]);
    const user = userEvent.setup();
    renderApp("/");
    const dialog = await openSettings(user);
    await user.click(await within(dialog).findByRole("button", { name: "Delete Alpha" }));
    await screen.findByRole("dialog", { name: "Delete project?" });
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Delete project?" })).not.toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Settings" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Settings" })).not.toBeInTheDocument();
    // Focus returns to the gear.
    expect(screen.getByRole("button", { name: "Settings" })).toHaveFocus();
  });

  it("a failed list shows a toast and Retry loads it", async () => {
    let fail = true;
    stubServer([ALPHA], { list: () => (fail ? json({ errors: ["db down"] }, 500) : json({ items: [ALPHA] })) });
    const user = userEvent.setup();
    renderApp("/");
    const dialog = await openSettings(user);
    expect(await within(dialog).findByText("Could not load your saved projects.")).toBeInTheDocument();
    expect((await screen.findAllByRole("alert")).some((el) => el.textContent?.includes("db down"))).toBe(true);
    fail = false;
    await user.click(within(dialog).getByRole("button", { name: "Retry" }));
    expect(await within(dialog).findByText("Alpha")).toBeInTheDocument();
  });

  it("a 401 from the settings endpoint sends the user to /login", async () => {
    stubServer([], { list: () => json({ errors: ["Not authenticated."] }, 401) });
    const user = userEvent.setup();
    renderApp("/");
    await user.click(screen.getByRole("button", { name: "Settings" }));
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/login"));
    expect(screen.queryByRole("dialog", { name: "Settings" })).not.toBeInTheDocument();
  });

  it("a 401 on save sends the user to /login and the PAT is gone from the DOM", async () => {
    const server = stubServer();
    const user = userEvent.setup();
    renderApp("/");
    const dialog = await openSettings(user);
    await user.click(await within(dialog).findByRole("button", { name: "Add project" }));
    await user.type(within(dialog).getByLabelText("Project name"), "X");
    await user.type(within(dialog).getByLabelText("Project URL"), "https://dev.azure.com/org/X");
    await user.type(within(dialog).getByLabelText("Personal Access Token"), SECRET);
    vi.mocked(fetch).mockImplementation(async () => json({ errors: ["Not authenticated."] }, 401));
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/login"));
    expect(document.body.innerHTML).not.toContain(SECRET);
    expect(server.calls.length).toBeGreaterThan(0);
  });
});
