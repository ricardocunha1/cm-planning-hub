import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appRoutes } from "./App";
import { ToastProvider } from "./components/Toast";
import { PLACEHOLDER } from "./lib/ado/url";
import { ADO_CONNECTION_KEY as MC_KEY } from "./lib/monteCarlo/constants";
import { ADO_CONNECTION_KEY as RP_KEY } from "./lib/releasePlan/constants";
import { ForecastProvider } from "./monteCarloStore";
import { makeConnectResponse } from "./test/adoFixtures";

function renderApp(path: string) {
  const router = createMemoryRouter(appRoutes, { initialEntries: [path] });
  return render(
    <ToastProvider>
      <ForecastProvider>
        <RouterProvider router={router} />
      </ForecastProvider>
    </ToastProvider>,
  );
}

const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "Content-Type": "application/json" } });
const PAT = "qa-switch-pat";
const TIMEOUT = 30_000;
const FIND = { timeout: 5_000 };
const ONPREM = "https://tfs-projects.cmf.criticalmanufacturing.com/ImplementationProjects/P";

const cases = [
  { name: "Release Plan", path: "/release-plan", button: /Create from Azure DevOps/, title: "Create from Azure DevOps", key: RP_KEY },
  { name: "Monte Carlo", path: "/monte-carlo", button: /Load from Azure DevOps/, title: "Load from Azure DevOps", key: MC_KEY },
];

describe.each(cases)("source switch clears the URL – $name (full app)", ({ path, button, title, key }) => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    window.localStorage.clear();
  });

  it("switching clears URL, keeps PAT, shows new placeholder; connect sends the new source", { timeout: TIMEOUT }, async () => {
    const fetchMock = vi.fn(async (i: RequestInfo | URL, _init: RequestInit = {}) =>
      String(i) === "/api/ado/connect" ? json(makeConnectResponse()) : json({ items: [], total: 0, page: 1, pageSize: 10 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    renderApp(path);
    await user.click(screen.getByRole("button", { name: button }));
    const dialog = screen.getByRole("dialog", { name: title });
    const url = within(dialog).getByLabelText("Project URL");
    const pat = within(dialog).getByLabelText("Personal Access Token");
    await user.type(url, "https://dev.azure.com/org/Proj");
    await user.type(pat, PAT);
    await user.click(within(dialog).getByRole("radio", { name: "On-Prem" }));
    expect(url).toHaveValue("");
    expect(url).toHaveAttribute("placeholder", PLACEHOLDER.onprem);
    expect(pat).toHaveValue(PAT);
    await user.type(url, ONPREM);
    await user.click(within(dialog).getByRole("radio", { name: "Collaboration Hub" }));
    expect(url).toHaveValue("");
    expect(url).toHaveAttribute("placeholder", PLACEHOLDER.cloud);
    await user.click(within(dialog).getByRole("radio", { name: "On-Prem" }));
    await user.type(url, ONPREM);
    await user.click(within(dialog).getByRole("button", { name: "Connect" }));
    await within(dialog).findByRole("tree", {}, FIND);
    const body = JSON.parse(String(fetchMock.mock.calls.find(([u]) => String(u) === "/api/ado/connect")?.[1]?.body));
    expect(body).toEqual({ source: "onprem", projectUrl: ONPREM, pat: PAT });
  });

  it("a remembered connection prefills on open; switching source clears it", { timeout: TIMEOUT }, async () => {
    window.localStorage.setItem(key, JSON.stringify({ source: "onprem", projectUrl: ONPREM }));
    vi.stubGlobal("fetch", vi.fn(async () => json({ items: [], total: 0, page: 1, pageSize: 10 })));
    const user = userEvent.setup();
    renderApp(path);
    await user.click(screen.getByRole("button", { name: button }));
    const dialog = screen.getByRole("dialog", { name: title });
    const url = within(dialog).getByLabelText("Project URL");
    expect(within(dialog).getByRole("radio", { name: "On-Prem" })).toBeChecked();
    expect(url).toHaveValue(ONPREM);
    await user.click(within(dialog).getByRole("radio", { name: "Collaboration Hub" }));
    expect(url).toHaveValue("");
    expect(url).toHaveAttribute("placeholder", PLACEHOLDER.cloud);
  });
});
