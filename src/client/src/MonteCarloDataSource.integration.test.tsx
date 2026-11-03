import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, Outlet, RouterProvider, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appRoutes } from "./App";
import { ToastProvider } from "./components/Toast";
import { ForecastProvider } from "./monteCarloStore";
import { result, validation } from "./test/monteCarloFixtures";

// Full-app integration for the Monte Carlo data source selection step
// (`/monte-carlo`) in front of the Excel form (`/monte-carlo/input`): real
// routes, pages, store and api.ts; only `fetch` and the Plotly chart are mocked.
vi.mock("./components/monteCarlo/HistogramChart", () => ({
  default: ({ histogram }: { histogram: { labels: string[] } }) => (
    <div data-testid="histogram">{histogram.labels.length} buckets</div>
  ),
}));

function LocationProbe() {
  return <div data-testid="location">{useLocation().pathname}</div>;
}

function renderApp(path = "/") {
  const router = createMemoryRouter(
    [
      {
        element: (
          <>
            <Outlet />
            <LocationProbe />
          </>
        ),
        children: appRoutes,
      },
    ],
    { initialEntries: [path] },
  );
  return render(
    <ToastProvider>
      <ForecastProvider>
        <RouterProvider router={router} />
      </ForecastProvider>
    </ToastProvider>,
  );
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const fetchMock = vi.fn<typeof fetch>();
const FLOW_TIMEOUT_MS = 20_000;
const FIND = { timeout: 5_000 };

const location = () => screen.getByTestId("location").textContent;
const adoCard = () => screen.getByRole("button", { name: /Load from Azure DevOps/ });
const excelCard = () => screen.getByRole("button", { name: /Import an Excel file/ });
const sidebarMonteCarlo = () =>
  within(screen.getByRole("navigation", { name: "Hub navigation" })).getByRole("link", { name: "Monte Carlo" });

/** In the open Import Excel modal: choose the file and Continue (lands on the input form). */
async function chooseFileInModal(user: ReturnType<typeof userEvent.setup>) {
  await user.upload(
    screen.getByLabelText("Sprint history file"),
    new File(["xlsx"], "Sprint_History.xlsx", {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    }),
  );
  await user.click(screen.getByRole("button", { name: "Continue" }));
}

async function fillInputAndSubmit(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText(/Target Value/), "100");
  fireEvent.change(screen.getByLabelText(/Sprint Start Date/), { target: { value: "2026-01-05" } });
  fireEvent.submit(screen.getByRole("button", { name: "Continue" }).closest("form")!);
}

describe("Monte Carlo – data source selection (full app)", () => {
  beforeEach(() => {
    vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("lands on the selection page from the hub home card, with both sources and step 1 active", async () => {
    const user = userEvent.setup();
    renderApp("/");

    await user.click(screen.getByRole("link", { name: "Open Monte Carlo" }));
    expect(location()).toBe("/monte-carlo");
    expect(document.title).toBe("Planning Hub – Monte Carlo – Data Source");
    expect(screen.getByRole("heading", { name: "Load sprint history" })).toBeInTheDocument();
    expect(sidebarMonteCarlo()).toHaveAttribute("aria-current", "page");
    const progress = screen.getByRole("navigation", { name: "Progress" });
    expect(progress.querySelector('[aria-current="step"]')).toHaveTextContent("Input");
    expect(adoCard()).toBeInTheDocument();
    expect(excelCard()).toHaveAttribute("aria-haspopup", "dialog");
    // No form on the selection page and no API traffic.
    expect(screen.queryByLabelText(/Target Value/)).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  }, FLOW_TIMEOUT_MS);

  it("makes the Azure DevOps card reachable by Tab; Enter opens its modal, Cancel closes it, no API calls", async () => {
    const user = userEvent.setup();
    renderApp("/monte-carlo");

    const ado = adoCard();
    expect(ado).not.toHaveAttribute("aria-disabled");
    expect(ado).toHaveAttribute("aria-haspopup", "dialog");
    expect(ado).not.toHaveTextContent("Coming soon");

    // Walk the whole tab order once: both cards are reachable.
    const visited: Element[] = [];
    for (let i = 0; i < 40; i++) {
      await user.tab();
      const el = document.activeElement;
      if (!el || el === document.body || visited.includes(el)) break;
      visited.push(el);
    }
    expect(visited).toContain(excelCard());
    expect(visited).toContain(ado);

    ado.focus();
    await user.keyboard("{Enter}");
    const dialog = screen.getByRole("dialog", { name: "Load from Azure DevOps" });
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));

    expect(location()).toBe("/monte-carlo");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  }, FLOW_TIMEOUT_MS);

  it("opens the Excel modal from the keyboard (Tab to the card, Enter) and continues to the form", async () => {
    const user = userEvent.setup();
    renderApp("/monte-carlo");

    for (let i = 0; i < 40 && document.activeElement !== excelCard(); i++) {
      await user.tab();
    }
    expect(excelCard()).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("dialog", { name: "Import an Excel file" })).toBeInTheDocument();
    await chooseFileInModal(user);

    expect(location()).toBe("/monte-carlo/input");
    expect(document.title).toBe("Planning Hub – Monte Carlo – Data Input");
    expect(screen.getByRole("region", { name: "Data source: Excel file" })).toHaveTextContent("Sprint_History.xlsx");
  }, FLOW_TIMEOUT_MS);

  it("redirects a deep link to /monte-carlo/input without a source; the card's 'Change' link goes back", async () => {
    const user = userEvent.setup();
    renderApp("/monte-carlo/input");
    expect(location()).toBe("/monte-carlo");

    await user.click(excelCard());
    await chooseFileInModal(user);
    expect(location()).toBe("/monte-carlo/input");
    expect(document.title).toBe("Planning Hub – Monte Carlo – Data Input");
    expect(screen.getByRole("button", { name: "Continue" })).toBeInTheDocument();

    const back = screen.getByRole("link", { name: /Change data source/ });
    expect(back).toHaveAttribute("href", "/monte-carlo");
    await user.click(back);

    expect(location()).toBe("/monte-carlo");
    expect(document.title).toBe("Planning Hub – Monte Carlo – Data Source");
    expect(adoCard()).toBeInTheDocument();

    // And forward again: the form is shown with its defaults.
    await user.click(excelCard());
    await chooseFileInModal(user);
    expect(location()).toBe("/monte-carlo/input");
    expect(screen.getByLabelText(/Target Type/)).toHaveValue("Items Resolved");
    expect(screen.getByLabelText(/Number of Simulations/)).toHaveValue(10000);
    expect(fetchMock).not.toHaveBeenCalled();
  }, FLOW_TIMEOUT_MS);

  it("runs the full Excel flow selection → input → confirm → results with the same API calls as before", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(validation)).mockResolvedValueOnce(jsonResponse(result));
    const user = userEvent.setup();
    renderApp("/monte-carlo");

    await user.click(excelCard());
    await chooseFileInModal(user);
    await fillInputAndSubmit(user);

    await user.click(await screen.findByRole("button", { name: "Confirm and Run Simulation" }, FIND));
    expect(await screen.findByText("Calendar View", undefined, FIND)).toBeInTheDocument();
    expect(location()).toBe("/monte-carlo/results");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/validate");
    expect(fetchMock.mock.calls[1][0]).toBe("/api/simulate");
    expect(JSON.parse(fetchMock.mock.calls[1][1]?.body as string)).toEqual({
      summary: validation.summary,
      params: validation.params,
    });

    // Sidebar Monte Carlo from the results returns to the selection page.
    await user.click(sidebarMonteCarlo());
    expect(location()).toBe("/monte-carlo");
    expect(screen.getByRole("heading", { name: "Load sprint history" })).toBeInTheDocument();
  }, FLOW_TIMEOUT_MS);

  it("shows the validate 422 toast on /monte-carlo/input after coming from the selection page", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ errors: ["A Sprint History Excel file is required."] }, 422));
    const user = userEvent.setup();
    renderApp("/monte-carlo");

    await user.click(excelCard());
    await chooseFileInModal(user);
    await fillInputAndSubmit(user);

    expect(await screen.findByRole("alert", undefined, FIND)).toHaveTextContent("A Sprint History Excel file is required.");
    expect(location()).toBe("/monte-carlo/input");
    // Values entered are kept.
    expect(screen.getByLabelText(/Target Value/)).toHaveValue(100);
  }, FLOW_TIMEOUT_MS);

  it.each(["/monte-carlo/confirm", "/monte-carlo/results"])(
    "a reload of %s (empty store) lands on the data source selection page",
    (path) => {
      renderApp(path);
      expect(location()).toBe("/monte-carlo");
      expect(screen.getByRole("heading", { name: "Load sprint history" })).toBeInTheDocument();
      expect(document.title).toBe("Planning Hub – Monte Carlo – Data Source");
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("opens How to Use on the selection page with the Azure DevOps note; Esc closes and restores focus", async () => {
    const user = userEvent.setup();
    renderApp("/monte-carlo");

    const helpButton = screen.getByRole("button", { name: "How to Use" });
    await user.click(helpButton);
    const dialog = screen.getByRole("dialog", { name: "How to Use This Application" });
    expect(within(dialog).getByText(/first screen lets you choose the data source/)).toBeInTheDocument();
    expect(within(dialog).getByText(/Work Items \(Read\)/)).toBeInTheDocument();
    expect(within(dialog).queryByText(/coming soon/i)).not.toBeInTheDocument();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await waitFor(() => expect(helpButton).toHaveFocus());
    expect(location()).toBe("/monte-carlo");
    expect(fetchMock).not.toHaveBeenCalled();
  }, FLOW_TIMEOUT_MS);
});
