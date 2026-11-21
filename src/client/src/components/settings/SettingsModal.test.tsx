import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CREDENTIALS } from "../../test/settingsFixtures";
import { SignedIn } from "../../test/SignedIn";
import { NAME_REQUIRED, SettingsModal } from "./SettingsModal";
import { CLOUD_SHAPE, HTTPS_REQUIRED, ONPREM_SHAPE, PAT_REQUIRED, URL_REQUIRED } from "../../lib/ado/url";

const SECRET = "super-secret-pat-123";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

/** Fetch stub serving the list, and 2xx answers for writes unless `failWrites` is set. */
function stubApi({ items = CREDENTIALS, failWrites = false }: { items?: typeof CREDENTIALS; failWrites?: boolean } = {}) {
  const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method === "GET") {
      return Promise.resolve(json({ items }));
    }
    if (failWrites) {
      return Promise.resolve(json({ errors: ["Server said no."] }, 422));
    }
    if (method === "DELETE") {
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    const body = JSON.parse(init?.body as string) as { projectName: string; projectUrl: string };
    return Promise.resolve(json({ id: method === "POST" ? 9 : 1, projectName: body.projectName, projectUrl: body.projectUrl, hasPat: true }, method === "POST" ? 201 : 200));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function writes(fetchMock: ReturnType<typeof stubApi>) {
  return fetchMock.mock.calls.filter(([, init]) => (init?.method ?? "GET") !== "GET");
}

function renderModal(onClose = vi.fn(), open = true) {
  const view = render(
    <SignedIn>
      <SettingsModal open={open} onClose={onClose} />
    </SignedIn>,
  );
  return { onClose, ...view };
}

afterEach(() => vi.unstubAllGlobals());

describe("SettingsModal", () => {
  it("renders nothing and does not fetch while closed", () => {
    const fetchMock = stubApi();
    renderModal(vi.fn(), false);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("is a labelled modal dialog that loads the list lazily when it opens", async () => {
    const fetchMock = stubApi();
    renderModal();
    const dialog = screen.getByRole("dialog", { name: "Settings" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(await screen.findByText("Alpha")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/settings/ado-credentials");
  });

  it("closes with Close, Esc and a backdrop click", async () => {
    stubApi();
    const { onClose } = renderModal();
    await screen.findByText("Alpha");
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    await userEvent.keyboard("{Escape}");
    await userEvent.click(screen.getByTestId("settings-backdrop"));
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it("shows an empty state", async () => {
    stubApi({ items: [] });
    renderModal();
    expect(await screen.findByText("No saved projects yet.")).toBeInTheDocument();
  });

  it("lists name, URL and a masked indicator, never a PAT value", async () => {
    stubApi();
    renderModal();
    await screen.findByText("Alpha");
    expect(screen.getByText("https://dev.azure.com/org/Alpha")).toBeInTheDocument();
    expect(screen.getAllByText("PAT saved")).toHaveLength(2);
    expect(screen.getAllByText("••••••••")).toHaveLength(2);
    expect(screen.queryByDisplayValue(/./)).not.toBeInTheDocument();
  });

  it("shows an error state with Retry when the list cannot be loaded", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ errors: ["Not found."] }, 404))
      .mockResolvedValueOnce(json({ items: CREDENTIALS }));
    vi.stubGlobal("fetch", fetchMock);
    renderModal();
    expect(await screen.findByText("Could not load your saved projects.")).toBeInTheDocument();
    expect(screen.getAllByRole("alert")[0]).toHaveTextContent("Not found.");
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Alpha")).toBeInTheDocument();
  });

  describe("add", () => {
    async function openAdd() {
      await screen.findByText("Alpha");
      await userEvent.click(screen.getByRole("button", { name: "Add project" }));
    }

    it("uses a password PAT input that opts out of password managers", async () => {
      stubApi();
      renderModal();
      await openAdd();
      const pat = screen.getByLabelText("Personal Access Token");
      expect(pat).toHaveAttribute("type", "password");
      expect(pat).toHaveAttribute("autocomplete", "off");
      expect(pat).toHaveAttribute("data-1p-ignore", "true");
      expect(pat).toHaveAttribute("data-lpignore", "true");
      expect(pat).toHaveAttribute("data-form-type", "other");
      expect(screen.queryByText(/Leave blank/)).not.toBeInTheDocument();
    });

    it("requires name, URL and PAT", async () => {
      const fetchMock = stubApi();
      renderModal();
      await openAdd();
      await userEvent.click(screen.getByRole("button", { name: "Save" }));
      const alert = screen.getByRole("alert");
      expect(alert).toHaveTextContent(NAME_REQUIRED);
      expect(alert).toHaveTextContent(URL_REQUIRED);
      expect(alert).toHaveTextContent(PAT_REQUIRED);
      expect(screen.getByLabelText("Project name")).toHaveAttribute("aria-invalid", "true");
      expect(writes(fetchMock)).toHaveLength(0);
    });

    it("rejects a URL that is not https or has the wrong shape", async () => {
      const fetchMock = stubApi();
      renderModal();
      await openAdd();
      await userEvent.type(screen.getByLabelText("Project name"), "Gamma");
      await userEvent.type(screen.getByLabelText("Personal Access Token"), SECRET);
      await userEvent.type(screen.getByLabelText("Project URL"), "http://dev.azure.com/o/p");
      await userEvent.click(screen.getByRole("button", { name: "Save" }));
      expect(screen.getByRole("alert")).toHaveTextContent(HTTPS_REQUIRED);
      await userEvent.clear(screen.getByLabelText("Project URL"));
      await userEvent.type(screen.getByLabelText("Project URL"), "https://dev.azure.com/onlyorg");
      await userEvent.click(screen.getByRole("button", { name: "Save" }));
      expect(screen.getByRole("alert")).toHaveTextContent(CLOUD_SHAPE);
      await userEvent.clear(screen.getByLabelText("Project URL"));
      await userEvent.type(screen.getByLabelText("Project URL"), "https://tfs.example.com/only");
      await userEvent.click(screen.getByRole("button", { name: "Save" }));
      expect(screen.getByRole("alert")).toHaveTextContent(ONPREM_SHAPE);
      expect(writes(fetchMock)).toHaveLength(0);
    });

    it("POSTs name, URL and PAT, then shows the item, clears the form and never renders the PAT", async () => {
      const fetchMock = stubApi();
      renderModal();
      await openAdd();
      await userEvent.type(screen.getByLabelText("Project name"), "  Gamma ");
      await userEvent.type(screen.getByLabelText("Project URL"), "https://dev.azure.com/o/Gamma");
      await userEvent.type(screen.getByLabelText("Personal Access Token"), SECRET);
      await userEvent.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() => expect(screen.queryByRole("form", { name: "Add project" })).not.toBeInTheDocument());
      const [url, init] = writes(fetchMock)[0];
      expect(url).toBe("/api/settings/ado-credentials");
      expect(init?.method).toBe("POST");
      expect(JSON.parse(init?.body as string)).toEqual({ projectName: "Gamma", projectUrl: "https://dev.azure.com/o/Gamma", pat: SECRET });
      expect(await screen.findByText("Gamma")).toBeInTheDocument();
      expect(document.body.innerHTML).not.toContain(SECRET);
      // A new form starts with an empty PAT.
      await userEvent.click(screen.getByRole("button", { name: "Add project" }));
      expect(screen.getByLabelText("Personal Access Token")).toHaveValue("");
    });

    it("keeps the form and toasts the server errors when saving fails", async () => {
      stubApi({ failWrites: true });
      renderModal();
      await openAdd();
      await userEvent.type(screen.getByLabelText("Project name"), "Gamma");
      await userEvent.type(screen.getByLabelText("Project URL"), "https://dev.azure.com/o/Gamma");
      await userEvent.type(screen.getByLabelText("Personal Access Token"), SECRET);
      await userEvent.click(screen.getByRole("button", { name: "Save" }));
      expect(await screen.findByText("Server said no.")).toBeInTheDocument();
      expect(screen.getByRole("form", { name: "Add project" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
    });

    it("disables Save while the request is pending", async () => {
      let resolve: (response: Response) => void = () => undefined;
      vi.stubGlobal(
        "fetch",
        vi.fn((_url: string, init?: RequestInit) =>
          (init?.method ?? "GET") === "GET"
            ? Promise.resolve(json({ items: CREDENTIALS }))
            : new Promise<Response>((r) => {
                resolve = r;
              }),
        ),
      );
      renderModal();
      await openAdd();
      await userEvent.type(screen.getByLabelText("Project name"), "Gamma");
      await userEvent.type(screen.getByLabelText("Project URL"), "https://dev.azure.com/o/Gamma");
      await userEvent.type(screen.getByLabelText("Personal Access Token"), SECRET);
      await userEvent.click(screen.getByRole("button", { name: "Save" }));
      expect(await screen.findByRole("button", { name: "Saving…" })).toBeDisabled();
      resolve(json({ id: 9, projectName: "Gamma", projectUrl: "https://dev.azure.com/o/Gamma", hasPat: true }, 201));
      await waitFor(() => expect(screen.queryByRole("form")).not.toBeInTheDocument());
    });

    it("Cancel closes the form and drops the typed PAT", async () => {
      stubApi();
      renderModal();
      await openAdd();
      await userEvent.type(screen.getByLabelText("Personal Access Token"), SECRET);
      await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
      expect(screen.queryByRole("form")).not.toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: "Add project" }));
      expect(screen.getByLabelText("Personal Access Token")).toHaveValue("");
    });
  });

  describe("edit", () => {
    async function openEdit() {
      await screen.findByText("Alpha");
      await userEvent.click(screen.getByRole("button", { name: "Edit Alpha" }));
    }

    it("prefills name and URL, leaves the PAT empty and explains that blank keeps it", async () => {
      stubApi();
      renderModal();
      await openEdit();
      expect(screen.getByLabelText("Project name")).toHaveValue("Alpha");
      expect(screen.getByLabelText("Project URL")).toHaveValue("https://dev.azure.com/org/Alpha");
      expect(screen.getByLabelText("Personal Access Token")).toHaveValue("");
      expect(screen.getByText(/Leave blank to keep the saved PAT/)).toBeInTheDocument();
    });

    it("PUTs without `pat` when the PAT is left blank", async () => {
      const fetchMock = stubApi();
      renderModal();
      await openEdit();
      await userEvent.clear(screen.getByLabelText("Project name"));
      await userEvent.type(screen.getByLabelText("Project name"), "Alpha renamed");
      await userEvent.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() => expect(screen.queryByRole("form")).not.toBeInTheDocument());
      const [url, init] = writes(fetchMock)[0];
      expect(url).toBe("/api/settings/ado-credentials/1");
      expect(init?.method).toBe("PUT");
      const body = JSON.parse(init?.body as string) as Record<string, unknown>;
      expect(body).toEqual({ projectName: "Alpha renamed", projectUrl: "https://dev.azure.com/org/Alpha" });
      expect("pat" in body).toBe(false);
      expect(await screen.findByText("Alpha renamed")).toBeInTheDocument();
    });

    it("PUTs the new PAT when one is typed", async () => {
      const fetchMock = stubApi();
      renderModal();
      await openEdit();
      await userEvent.type(screen.getByLabelText("Personal Access Token"), SECRET);
      await userEvent.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() => expect(writes(fetchMock)).toHaveLength(1));
      expect(JSON.parse(writes(fetchMock)[0][1]?.body as string)).toMatchObject({ pat: SECRET });
      await waitFor(() => expect(screen.queryByRole("form")).not.toBeInTheDocument());
      expect(document.body.innerHTML).not.toContain(SECRET);
    });

    it("still validates name and URL", async () => {
      stubApi();
      renderModal();
      await openEdit();
      await userEvent.clear(screen.getByLabelText("Project name"));
      await userEvent.clear(screen.getByLabelText("Project URL"));
      await userEvent.click(screen.getByRole("button", { name: "Save" }));
      const alert = screen.getByRole("alert");
      expect(alert).toHaveTextContent(NAME_REQUIRED);
      expect(alert).toHaveTextContent(URL_REQUIRED);
      expect(alert).not.toHaveTextContent(PAT_REQUIRED);
    });
  });

  describe("delete", () => {
    it("asks for confirmation (stacked over the modal) and DELETEs the entry", async () => {
      const fetchMock = stubApi();
      renderModal();
      await screen.findByText("Alpha");
      await userEvent.click(screen.getByRole("button", { name: "Delete Alpha" }));
      const confirm = screen.getByRole("dialog", { name: "Delete project?" });
      expect(confirm.parentElement).toHaveClass("z-[60]");
      await userEvent.click(within(confirm).getByRole("button", { name: "Delete" }));
      await waitFor(() => expect(screen.queryByText("Alpha")).not.toBeInTheDocument());
      const [url, init] = writes(fetchMock)[0];
      expect(url).toBe("/api/settings/ado-credentials/1");
      expect(init?.method).toBe("DELETE");
      expect(screen.getByText("Beta")).toBeInTheDocument();
    });

    it("Esc cancels only the confirmation, and nothing is deleted", async () => {
      const fetchMock = stubApi();
      const { onClose } = renderModal();
      await screen.findByText("Alpha");
      await userEvent.click(screen.getByRole("button", { name: "Delete Alpha" }));
      await userEvent.keyboard("{Escape}");
      expect(screen.queryByRole("dialog", { name: "Delete project?" })).not.toBeInTheDocument();
      expect(onClose).not.toHaveBeenCalled();
      expect(screen.getByText("Alpha")).toBeInTheDocument();
      expect(writes(fetchMock)).toHaveLength(0);
    });

    it("toasts the error when deleting fails and keeps the entry", async () => {
      stubApi({ failWrites: true });
      renderModal();
      await screen.findByText("Alpha");
      await userEvent.click(screen.getByRole("button", { name: "Delete Alpha" }));
      await userEvent.click(within(screen.getByRole("dialog", { name: "Delete project?" })).getByRole("button", { name: "Delete" }));
      expect(await screen.findByText("Server said no.")).toBeInTheDocument();
      expect(screen.getByText("Alpha")).toBeInTheDocument();
    });
  });
});
