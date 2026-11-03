import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, Outlet, RouterProvider, useLocation, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appRoutes } from "./App";
import { ToastProvider } from "./components/Toast";
import { ForecastProvider } from "./monteCarloStore";
import { result, validation } from "./test/monteCarloFixtures";

// Full-app integration for the Import Excel modal on the Monte Carlo data
// source page and the data source card on the input form: real routes, pages,
// store and api.ts; only `fetch` and the Plotly chart are mocked.
vi.mock("./components/monteCarlo/HistogramChart", () => ({
  default: ({ histogram }: { histogram: { labels: string[] } }) => (
    <div data-testid="histogram">{histogram.labels.length} buckets</div>
  ),
}));

/** Shows the current path and lets a test "type a URL" (in-app navigation, store kept). */
function RouterProbe() {
  const navigate = useNavigate();
  return (
    <div>
      <div data-testid="location">{useLocation().pathname}</div>
      <button type="button" data-testid="go-confirm" onClick={() => navigate("/monte-carlo/confirm")} />
      <button type="button" data-testid="go-results" onClick={() => navigate("/monte-carlo/results")} />
      <button type="button" data-testid="go-input" onClick={() => navigate("/monte-carlo/input")} />
      <button type="button" data-testid="go-back" onClick={() => navigate(-1)} />
    </div>
  );
}

function renderApp(path = "/monte-carlo") {
  const router = createMemoryRouter(
    [
      {
        element: (
          <>
            <Outlet />
            <RouterProbe />
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

const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const xlsx = (name: string) => new File([`content of ${name}`], name, { type: XLSX_TYPE });

const fetchMock = vi.fn<typeof fetch>();
const FLOW_TIMEOUT_MS = 20_000;
const FIND = { timeout: 5_000 };

const location = () => screen.getByTestId("location").textContent;
const excelCard = () => screen.getByRole("button", { name: /Import an Excel file/ });
const modal = () => screen.getByRole("dialog", { name: "Import an Excel file" });
const fileInput = () => within(modal()).getByLabelText("Sprint history file");
const modalContinue = () => within(modal()).getByRole("button", { name: "Continue" });
const sourceCard = () => screen.getByRole("region", { name: "Data source: Excel file" });

/** Opens the modal, chooses `file` and continues (lands on the input form). */
async function chooseFile(user: ReturnType<typeof userEvent.setup>, file: File) {
  await user.click(excelCard());
  await user.upload(fileInput(), file);
  await user.click(modalContinue());
}

async function fillAndSubmit(user: ReturnType<typeof userEvent.setup>, { skip = false } = {}) {
  await user.type(screen.getByLabelText(/Target Value/), "100");
  fireEvent.change(screen.getByLabelText(/Sprint Start Date/), { target: { value: "2026-01-05" } });
  if (skip) {
    await user.click(screen.getByLabelText(/Skip Historical Sprint Validation/));
  }
  fireEvent.submit(screen.getByRole("button", { name: "Continue" }).closest("form")!);
}

function validateBody(callIndex = 0): FormData {
  const [url, init] = fetchMock.mock.calls[callIndex];
  expect(url).toBe("/api/validate");
  expect(init?.method).toBe("POST");
  expect(init?.body).toBeInstanceOf(FormData);
  return init?.body as FormData;
}

describe("Monte Carlo – Import Excel modal and data source card (full app)", () => {
  beforeEach(() => {
    vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("opens a modal dialog focused on the file input; Esc closes it, restores focus and stays put with no API calls", async () => {
    const user = userEvent.setup();
    renderApp();

    await user.click(excelCard());
    const dialog = modal();
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(fileInput()).toHaveFocus();
    expect(fileInput()).toHaveAttribute("accept", ".xlsx");
    expect(within(dialog).getByText("No file selected.")).toBeInTheDocument();

    await user.upload(fileInput(), xlsx("A.xlsx"));
    await user.keyboard("{Escape}");

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await waitFor(() => expect(excelCard()).toHaveFocus());
    expect(location()).toBe("/monte-carlo");
    // Nothing was stored: the input form still redirects back.
    await user.click(screen.getByTestId("go-input"));
    expect(location()).toBe("/monte-carlo");
    expect(fetchMock).not.toHaveBeenCalled();
  }, FLOW_TIMEOUT_MS);

  it.each([
    ["Cancel", async (user: ReturnType<typeof userEvent.setup>) => user.click(within(modal()).getByRole("button", { name: "Cancel" }))],
    ["backdrop", async (user: ReturnType<typeof userEvent.setup>) => user.click(screen.getByTestId("import-excel-backdrop"))],
  ])("closes on %s without choosing a source", async (_label, close) => {
    const user = userEvent.setup();
    renderApp();

    await user.click(excelCard());
    await user.upload(fileInput(), xlsx("A.xlsx"));
    await close(user);

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(location()).toBe("/monte-carlo");
    await user.click(screen.getByTestId("go-input"));
    expect(location()).toBe("/monte-carlo");
    expect(fetchMock).not.toHaveBeenCalled();
  }, FLOW_TIMEOUT_MS);

  it("reopening the modal resets the previously chosen file", async () => {
    const user = userEvent.setup();
    renderApp();

    await user.click(excelCard());
    await user.upload(fileInput(), xlsx("A.xlsx"));
    expect(within(modal()).getByText("A.xlsx")).toBeInTheDocument();
    await user.keyboard("{Escape}");

    await user.click(excelCard());
    expect(within(modal()).getByText("No file selected.")).toBeInTheDocument();
    await user.click(modalContinue());
    expect(within(modal()).getByRole("alert")).toHaveTextContent("Select an .xlsx file.");
    expect(location()).toBe("/monte-carlo");
  }, FLOW_TIMEOUT_MS);

  it("keeps the modal open with an inline error for no file or a non-.xlsx file, then accepts an .XLSX file", async () => {
    // applyAccept: false so the .csv reaches the input (a user can pick "All files").
    const user = userEvent.setup({ applyAccept: false });
    renderApp();

    await user.click(excelCard());
    await user.click(modalContinue());
    expect(within(modal()).getByRole("alert")).toHaveTextContent("Select an .xlsx file.");
    expect(fileInput()).toHaveAttribute("aria-invalid", "true");
    expect(fileInput()).toHaveAccessibleDescription("Select an .xlsx file.");

    await user.upload(fileInput(), new File(["a,b"], "history.csv", { type: "text/csv" }));
    // Choosing another file clears the error until Continue is pressed again.
    expect(within(modal()).queryByRole("alert")).not.toBeInTheDocument();
    await user.click(modalContinue());
    expect(within(modal()).getByRole("alert")).toHaveTextContent("Select an .xlsx file.");
    expect(location()).toBe("/monte-carlo");

    await user.upload(fileInput(), xlsx("UPPER.XLSX"));
    await user.click(modalContinue());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(location()).toBe("/monte-carlo/input");
    expect(sourceCard()).toHaveTextContent("UPPER.XLSX");
    expect(fetchMock).not.toHaveBeenCalled();
  }, FLOW_TIMEOUT_MS);

  it("traps Tab inside the modal", async () => {
    const user = userEvent.setup();
    renderApp();

    await user.click(excelCard());
    const dialog = modal();
    for (let i = 0; i < 6; i++) {
      await user.tab();
      expect(dialog).toContainElement(document.activeElement as HTMLElement);
    }
    for (let i = 0; i < 6; i++) {
      await user.tab({ shift: true });
      expect(dialog).toContainElement(document.activeElement as HTMLElement);
    }
  }, FLOW_TIMEOUT_MS);

  it("the input form has no file input and sends the chosen File as sprint_history_file with the unchanged fields", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(validation));
    const user = userEvent.setup();
    renderApp();

    const chosen = xlsx("Sprint_History.xlsx");
    await chooseFile(user, chosen);
    expect(document.querySelector('input[type="file"]')).toBeNull();
    expect(sourceCard()).toHaveTextContent("Sprint_History.xlsx");

    await fillAndSubmit(user);
    await screen.findByRole("button", { name: "Confirm and Run Simulation" }, FIND);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = validateBody();
    expect(body.get("sprint_history_file")).toBe(chosen);
    expect(body.getAll("sprint_history_file")).toHaveLength(1);
    expect(body.has("skip_validation")).toBe(false);
    expect(Object.fromEntries([...body.entries()].filter(([key]) => key !== "sprint_history_file"))).toEqual({
      target_type: "Items Resolved",
      target_value: "100",
      num_simulations: "10000",
      sprint_start_date: "2026-01-05",
      sprint_length: "10",
      exclude_latest_sprints: "0",
      team_capacity_factor: "1.0",
    });
  }, FLOW_TIMEOUT_MS);

  it("file A → form → Change → file B: the card shows B and the submit (skip validation) sends B", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(validation)).mockResolvedValueOnce(jsonResponse(result));
    const user = userEvent.setup();
    renderApp();

    await chooseFile(user, xlsx("A.xlsx"));
    expect(sourceCard()).toHaveTextContent("A.xlsx");

    await user.click(screen.getByRole("link", { name: "Change data source" }));
    expect(location()).toBe("/monte-carlo");
    // The modal opens fresh, not with A pre-selected.
    await user.click(excelCard());
    expect(within(modal()).getByText("No file selected.")).toBeInTheDocument();
    await user.keyboard("{Escape}");

    const fileB = xlsx("B.xlsx");
    await chooseFile(user, fileB);
    expect(sourceCard()).toHaveTextContent("B.xlsx");
    expect(sourceCard()).not.toHaveTextContent("A.xlsx");

    await fillAndSubmit(user, { skip: true });
    expect(await screen.findByText("Calendar View", undefined, FIND)).toBeInTheDocument();
    expect(location()).toBe("/monte-carlo/results");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const body = validateBody(0);
    expect(body.get("sprint_history_file")).toBe(fileB);
    expect(body.get("skip_validation")).toBe("on");
    expect(fetchMock.mock.calls[1][0]).toBe("/api/simulate");
  }, FLOW_TIMEOUT_MS);

  it("choosing a new file drops the previous validation and execution (no stale confirm/results)", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(validation)).mockResolvedValueOnce(jsonResponse(result));
    const user = userEvent.setup();
    renderApp();

    await chooseFile(user, xlsx("A.xlsx"));
    await fillAndSubmit(user);
    await user.click(await screen.findByRole("button", { name: "Confirm and Run Simulation" }, FIND));
    await screen.findByText("Calendar View", undefined, FIND);

    // Results for A are reachable in-app until a new file is chosen.
    await user.click(screen.getByTestId("go-confirm"));
    expect(location()).toBe("/monte-carlo/confirm");

    await user.click(within(screen.getByRole("navigation", { name: "Hub navigation" })).getByRole("link", { name: "Monte Carlo" }));
    expect(location()).toBe("/monte-carlo");
    await chooseFile(user, xlsx("B.xlsx"));
    expect(location()).toBe("/monte-carlo/input");

    await user.click(screen.getByTestId("go-confirm"));
    expect(location()).toBe("/monte-carlo");
    await user.click(screen.getByTestId("go-results"));
    expect(location()).toBe("/monte-carlo");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  }, FLOW_TIMEOUT_MS);

  it("cancelling the modal after Change keeps the previous file (and its form route) intact", async () => {
    const user = userEvent.setup();
    renderApp();

    await chooseFile(user, xlsx("A.xlsx"));
    await user.click(screen.getByRole("link", { name: "Change data source" }));
    await user.click(excelCard());
    await user.upload(fileInput(), xlsx("B.xlsx"));
    await user.click(within(modal()).getByRole("button", { name: "Cancel" }));

    await user.click(screen.getByTestId("go-input"));
    expect(location()).toBe("/monte-carlo/input");
    expect(sourceCard()).toHaveTextContent("A.xlsx");
    expect(fetchMock).not.toHaveBeenCalled();
  }, FLOW_TIMEOUT_MS);

  it("a 422 for the chosen file shows the server message as a toast and keeps the card and the form", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ errors: ["The uploaded file could not be read as an Excel workbook."] }, 422),
    );
    const user = userEvent.setup();
    renderApp();

    await chooseFile(user, xlsx("broken.xlsx"));
    await fillAndSubmit(user);

    expect(await screen.findByRole("alert", undefined, FIND)).toHaveTextContent(
      "The uploaded file could not be read as an Excel workbook.",
    );
    expect(location()).toBe("/monte-carlo/input");
    expect(sourceCard()).toHaveTextContent("broken.xlsx");
    expect(screen.getByLabelText(/Target Value/)).toHaveValue(100);
  }, FLOW_TIMEOUT_MS);
});
