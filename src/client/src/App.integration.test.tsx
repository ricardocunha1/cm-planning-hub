import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { ToastProvider } from "./components/Toast";
import { ForecastProvider } from "./monteCarloStore";
import { result, validation } from "./test/monteCarloFixtures";

// Full-app integration: real App routes, real pages, real api.ts; only the
// network (`fetch`) and the Plotly chart (needs a real browser) are mocked.
vi.mock("./components/monteCarlo/HistogramChart", () => ({
  default: ({ histogram }: { histogram: { labels: string[] } }) => (
    <div data-testid="histogram">{histogram.labels.length} buckets</div>
  ),
}));

function LocationProbe() {
  return <div data-testid="location">{useLocation().pathname}</div>;
}

function renderApp(path = "/") {
  return render(
    <ToastProvider>
      <ForecastProvider>
        <MemoryRouter initialEntries={[path]}>
          <App />
          <LocationProbe />
        </MemoryRouter>
      </ForecastProvider>
    </ToastProvider>,
  );
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const fetchMock = vi.fn<typeof fetch>();

// The multi-page flows below run several renders, an upload, typing and two
// mocked fetches. Under a loaded full-suite run (many files in parallel) they
// took 2.3-3.4s and occasionally exceeded Vitest's 5s default, so give them
// headroom; `findBy` waits get the same treatment instead of the 1s default.
const FLOW_TIMEOUT_MS = 20_000;
const FIND = { timeout: 5_000 };

function sidebarMonteCarlo() {
  // Each page renders its own Layout, so re-query after every navigation.
  const nav = screen.getByRole("navigation", { name: "Hub navigation" });
  return within(nav).getByRole("link", { name: "Monte Carlo" });
}

function location() {
  return screen.getByTestId("location").textContent;
}

/** On the data source page: Excel card → choose the file in the modal → Continue (lands on the input form). */
async function chooseExcelFile(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: /Import an Excel file/ }));
  await user.upload(
    screen.getByLabelText("Sprint history file"),
    new File(["xlsx"], "Sprint_History.xlsx", {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    }),
  );
  await user.click(screen.getByRole("button", { name: "Continue" }));
}

async function fillInputAndSubmit(user: ReturnType<typeof userEvent.setup>, { skip }: { skip: boolean }) {
  await user.type(screen.getByLabelText(/Target Value/), "100");
  fireEvent.change(screen.getByLabelText(/Sprint Start Date/), { target: { value: "2026-01-05" } });
  if (skip) {
    await user.click(screen.getByLabelText(/Skip Historical Sprint Validation/));
  }
  // Submit the form directly (bypasses the browser's `required` checks).
  fireEvent.submit(screen.getByRole("button", { name: "Continue" }).closest("form")!);
}

describe("Planning Hub – full app flow", () => {
  beforeEach(() => {
    vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("goes home → sidebar Monte Carlo → input → confirm → results under /monte-carlo", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(validation))
      .mockResolvedValueOnce(jsonResponse(result));
    const user = userEvent.setup();
    renderApp("/");

    // Home: hub title, tool card, no Help button.
    expect(document.title).toBe("Planning Hub");
    expect(screen.getByRole("heading", { level: 1, name: "Planning Hub" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "How to Use" })).not.toBeInTheDocument();

    // Sidebar → Monte Carlo.
    expect(sidebarMonteCarlo()).not.toHaveAttribute("aria-current");
    await user.click(sidebarMonteCarlo());
    expect(location()).toBe("/monte-carlo");
    expect(sidebarMonteCarlo()).toHaveAttribute("aria-current", "page");
    expect(document.title).toBe("Planning Hub – Monte Carlo – Data Source");

    // Data source choice → Excel upload form.
    await chooseExcelFile(user);
    expect(location()).toBe("/monte-carlo/input");
    expect(sidebarMonteCarlo()).toHaveAttribute("aria-current", "page");
    expect(document.title).toBe("Planning Hub – Monte Carlo – Data Input");

    await fillInputAndSubmit(user, { skip: false });

    expect(await screen.findByRole("button", { name: "Confirm and Run Simulation" }, FIND)).toBeInTheDocument();
    expect(location()).toBe("/monte-carlo/confirm");
    // Layout sets the title in a passive effect, which can run just after the
    // fetch-driven commit that findBy observed; wait for it like Results does.
    await waitFor(() => expect(document.title).toBe("Planning Hub – Monte Carlo – Confirm Sprint Data"), FIND);
    expect(screen.getByText("Sprint 1")).toBeInTheDocument();

    const [validateUrl, validateInit] = fetchMock.mock.calls[0];
    expect(validateUrl).toBe("/api/validate");
    expect(validateInit?.method).toBe("POST");
    const form = validateInit?.body as FormData;
    expect(form.get("target_value")).toBe("100");
    expect(form.get("sprint_start_date")).toBe("2026-01-05");
    expect(form.has("skip_validation")).toBe(false);
    expect((form.get("sprint_history_file") as File).name).toBe("Sprint_History.xlsx");

    await user.click(screen.getByRole("button", { name: "Confirm and Run Simulation" }));

    expect(await screen.findByText("Calendar View", undefined, FIND)).toBeInTheDocument();
    expect(location()).toBe("/monte-carlo/results");
    await waitFor(() => expect(document.title).toBe("Planning Hub – Monte Carlo – Results"), FIND);
    expect(sidebarMonteCarlo()).toHaveAttribute("aria-current", "page");

    const [simulateUrl, simulateInit] = fetchMock.mock.calls[1];
    expect(simulateUrl).toBe("/api/simulate");
    expect(JSON.parse(simulateInit?.body as string)).toEqual({ summary: validation.summary, params: validation.params });
  }, FLOW_TIMEOUT_MS);

  it("skips validation straight from input to /monte-carlo/results", async () => {
    const skipped = { ...validation, params: { ...validation.params, skip_validation: true } };
    fetchMock.mockResolvedValueOnce(jsonResponse(skipped)).mockResolvedValueOnce(jsonResponse(result));
    const user = userEvent.setup();
    renderApp("/");

    await user.click(screen.getByRole("link", { name: "Open Monte Carlo" }));
    expect(location()).toBe("/monte-carlo");
    await chooseExcelFile(user);
    expect(location()).toBe("/monte-carlo/input");

    await fillInputAndSubmit(user, { skip: true });

    expect(await screen.findByText("Calendar View", undefined, FIND)).toBeInTheDocument();
    expect(location()).toBe("/monte-carlo/results");
    expect((fetchMock.mock.calls[0][1]?.body as FormData).get("skip_validation")).toBe("on");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  }, FLOW_TIMEOUT_MS);

  it("shows a 422 {errors} from /api/validate as a toast and stays on /monte-carlo/input", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ errors: ["Could not read Excel file: File is not a zip file"] }, 422));
    const user = userEvent.setup();
    renderApp("/monte-carlo");
    await chooseExcelFile(user);

    await fillInputAndSubmit(user, { skip: false });

    const alert = await screen.findByRole("alert", undefined, FIND);
    expect(alert).toHaveTextContent("Could not read Excel file: File is not a zip file");
    expect(location()).toBe("/monte-carlo/input");
  }, FLOW_TIMEOUT_MS);

  it("shows a simulate failure as a toast and stays on /monte-carlo/confirm", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(validation))
      .mockResolvedValueOnce(jsonResponse({ errors: ["The sampling pool is empty."] }, 422));
    const user = userEvent.setup();
    renderApp("/monte-carlo");
    await chooseExcelFile(user);

    await fillInputAndSubmit(user, { skip: false });
    await user.click(await screen.findByRole("button", { name: "Confirm and Run Simulation" }, FIND));

    const alert = await screen.findByRole("alert", undefined, FIND);
    expect(alert).toHaveTextContent("The sampling pool is empty.");
    expect(location()).toBe("/monte-carlo/confirm");
  }, FLOW_TIMEOUT_MS);

  it("opens the Help modal from every Monte Carlo step", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(validation)).mockResolvedValueOnce(jsonResponse(result));
    const user = userEvent.setup();
    renderApp("/monte-carlo");
    await chooseExcelFile(user);

    async function openAndCloseHelp() {
      await user.click(screen.getByRole("button", { name: "How to Use" }));
      expect(screen.getByRole("dialog", { name: "How to Use This Application" })).toBeInTheDocument();
      await user.keyboard("{Escape}");
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    }

    await openAndCloseHelp();
    await fillInputAndSubmit(user, { skip: false });
    await screen.findByRole("button", { name: "Confirm and Run Simulation" }, FIND);
    await openAndCloseHelp();
    await user.click(screen.getByRole("button", { name: "Confirm and Run Simulation" }));
    await screen.findByText("Calendar View", undefined, FIND);
    await openAndCloseHelp();
  }, FLOW_TIMEOUT_MS);

  it("returns to the hub home from the header logo and from unknown paths", async () => {
    const user = userEvent.setup();
    renderApp("/no/such/page");
    expect(location()).toBe("/");

    await user.click(screen.getByRole("link", { name: "Open Monte Carlo" }));
    expect(location()).toBe("/monte-carlo");

    await user.click(screen.getByRole("link", { name: "Planning Hub home" }));
    expect(location()).toBe("/");
    expect(screen.getByRole("link", { name: "Monte Carlo" })).not.toHaveAttribute("aria-current");
  });

  it("goes home → Release Plan card → /release-plan → opens the Azure DevOps modal", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(jsonResponse({ items: [], total: 0, page: 1, pageSize: 10 }));
    renderApp("/");

    // Home: both tool cards, Release Plan not active yet.
    expect(screen.getByRole("link", { name: "Open Monte Carlo" })).toBeInTheDocument();
    const nav = () => screen.getByRole("navigation", { name: "Hub navigation" });
    expect(within(nav()).getByRole("link", { name: "Release Plan" })).not.toHaveAttribute("aria-current");

    await user.click(screen.getByRole("link", { name: "Open Release Plan" }));
    expect(location()).toBe("/release-plan");
    expect(document.title).toBe("Planning Hub – Release Plan");
    expect(screen.queryByRole("heading", { name: "Release Plan" })).not.toBeInTheDocument();
    expect(within(nav()).getByRole("link", { name: "Release Plan" })).toHaveAttribute("aria-current", "page");
    expect(within(nav()).getByRole("link", { name: "Monte Carlo" })).not.toHaveAttribute("aria-current");
    // Monte Carlo's Help lives only in its own view header.
    expect(screen.queryByRole("button", { name: "How to Use" })).not.toBeInTheDocument();

    // The Azure DevOps card opens the connection modal; Cancel closes it.
    const adoCard = screen.getByRole("button", { name: /Create from Azure DevOps/ });
    expect(adoCard).not.toHaveAttribute("aria-disabled");
    await user.click(adoCard);
    const adoDialog = screen.getByRole("dialog", { name: "Create from Azure DevOps" });
    await user.click(within(adoDialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(location()).toBe("/release-plan");

    // Esc closes the modal and focus returns to the card; reopening starts clean.
    await user.click(adoCard);
    expect(screen.getByRole("dialog", { name: "Create from Azure DevOps" })).toHaveAttribute("aria-modal", "true");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(adoCard).toHaveFocus();
    await user.click(adoCard);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    // Only the saved-plans list is requested; no ADO traffic without a Connect.
    expect(fetchMock.mock.calls.every(([url]) => String(url).startsWith("/api/plan"))).toBe(true);
  }, FLOW_TIMEOUT_MS);

  it("switches between the tools from the sidebar", async () => {
    const user = userEvent.setup();
    renderApp("/monte-carlo");
    const navLink = (name: string) =>
      within(screen.getByRole("navigation", { name: "Hub navigation" })).getByRole("link", { name });

    await user.click(navLink("Release Plan"));
    expect(location()).toBe("/release-plan");
    expect(document.title).toBe("Planning Hub – Release Plan");
    expect(navLink("Release Plan")).toHaveAttribute("aria-current", "page");

    await user.click(navLink("Monte Carlo"));
    expect(location()).toBe("/monte-carlo");
    expect(document.title).toBe("Planning Hub – Monte Carlo – Data Source");
    expect(navLink("Monte Carlo")).toHaveAttribute("aria-current", "page");
    expect(navLink("Release Plan")).not.toHaveAttribute("aria-current");
  }, FLOW_TIMEOUT_MS);

  it.each(["/monte-carlo/confirm", "/monte-carlo/results"])("redirects %s without data to /monte-carlo", (path) => {
    renderApp(path);
    expect(location()).toBe("/monte-carlo");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["/confirm", "/results"])("redirects the legacy route %s to the hub home", (path) => {
    renderApp(path);
    expect(location()).toBe("/");
  });
});
