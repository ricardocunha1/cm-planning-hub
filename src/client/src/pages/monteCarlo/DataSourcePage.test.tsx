import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useForecast } from "../../monteCarloStore";
import { ADO_CREDENTIALS, makeConnectResponse } from "../../test/adoFixtures";
import { makeSprintHistory, result, validation } from "../../test/monteCarloFixtures";
import { renderAt } from "../../test/render";
import { DataSourcePage } from "./DataSourcePage";

const adoCard = () => screen.getByRole("button", { name: /Load from Azure DevOps/ });
const excelCard = () => screen.getByRole("button", { name: /Import an Excel file/ });
const location = () => screen.getByTestId("location").textContent;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** Stubs `fetch` for `/api/ado/connect` and `/api/ado/sprint-history` (synthetic fixtures). */
function mockAdo(history: Response = json(makeSprintHistory())) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) =>
    String(input) === "/api/ado/connect" ? json(makeConnectResponse()) : history,
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** Runs the ADO modal: project, Connect, "Phase 1", Load sprint history. */
async function loadFromAdo(user: ReturnType<typeof userEvent.setup>) {
  await user.click(adoCard());
  const dialog = screen.getByRole("dialog", { name: "Load from Azure DevOps" });
  await user.selectOptions(within(dialog).getByLabelText("Project"), "Proj");
  await user.click(within(dialog).getByRole("button", { name: "Connect" }));
  await user.click(within(await screen.findByRole("tree", { name: "Iteration path" })).getByRole("treeitem", { name: /^Phase 1/ }));
  await user.click(within(dialog).getByRole("button", { name: "Load sprint history" }));
}

/** Stub of the input route that shows what the store holds after the navigation. */
function StoreProbe() {
  const { dataSource, validation: storedValidation, execution } = useForecast();
  return (
    <div>
      <p>input page</p>
      <p data-testid="source">{dataSource ? JSON.stringify(dataSource.kind === "excel" ? { excel: dataSource.file.name } : dataSource) : "null"}</p>
      <p data-testid="stale">{`${storedValidation === null}/${execution === null}`}</p>
    </div>
  );
}

describe("DataSourcePage", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    window.localStorage.clear();
  });

  it("renders inside the Monte Carlo layout as the Data Source step", () => {
    renderAt("/monte-carlo", <DataSourcePage />, { initialCredentials: ADO_CREDENTIALS });
    expect(document.title).toBe("Planning Hub – Monte Carlo – Data Source");
    expect(screen.getByRole("heading", { name: "Load sprint history" })).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Progress" }).querySelector('[aria-current="step"]')).toHaveTextContent("Input");
  });

  it("shows the Azure DevOps card enabled (no Coming soon badge)", () => {
    renderAt("/monte-carlo", <DataSourcePage />, { initialCredentials: ADO_CREDENTIALS });
    expect(adoCard().tagName).toBe("BUTTON");
    expect(adoCard()).toBeEnabled();
    expect(adoCard()).not.toHaveAttribute("aria-disabled");
    expect(adoCard()).toHaveAttribute("aria-haspopup", "dialog");
    expect(adoCard()).not.toHaveTextContent("Coming soon");
  });

  it("opens the Azure DevOps modal (iteration paths only) and Cancel returns focus to the card", async () => {
    const user = userEvent.setup();
    mockAdo();
    renderAt("/monte-carlo", <DataSourcePage />, { initialCredentials: ADO_CREDENTIALS });
    await user.click(adoCard());
    const dialog = screen.getByRole("dialog", { name: "Load from Azure DevOps" });
    expect(within(dialog).getByRole("button", { name: "Load sprint history" })).toBeDisabled();
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(adoCard()).toHaveFocus();
    expect(location()).toBe("/monte-carlo");
  });

  it("loads from Azure DevOps: stores the source, clears stale results, goes to the input form and toasts the warnings", async () => {
    const user = userEvent.setup();
    const warning = "The field Microsoft.VSTS.Scheduling.StoryPoints does not exist in this project; story points are 0.";
    const history = makeSprintHistory({ warnings: [warning, "Only the first 20000 work items were loaded; narrow the scope."] });
    const fetchMock = mockAdo(json(history));
    renderAt("/monte-carlo", <DataSourcePage />, {
      initialCredentials: ADO_CREDENTIALS,
      validation,
      execution: { result, sprintStartDate: "2026-01-05" },
      routes: { "/monte-carlo/input": <StoreProbe /> },
    });
    await loadFromAdo(user);

    await vi.waitFor(() => expect(location()).toBe("/monte-carlo/input"));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(JSON.parse(screen.getByTestId("source").textContent ?? "")).toEqual({
      kind: "azureDevOps",
      source: "cloud",
      projectUrl: history.projectUrl,
      project: "MES Core",
      iterationPath: "MES Core\\Release 11",
      fetchedAt: "2026-10-23T10:00:00Z",
      workItems: history.workItems,
    });
    expect(screen.getByTestId("stale")).toHaveTextContent("true/true");
    const toasts = screen.getAllByRole("status").map((el) => el.textContent);
    expect(toasts.some((t) => t?.includes(warning))).toBe(true);
    expect(toasts.some((t) => t?.includes("Only the first 20000 work items were loaded"))).toBe(true);

    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toBe("/api/ado/sprint-history");
    expect(JSON.parse(String(init.body))).toEqual({
      source: "cloud",
      projectUrl: "https://dev.azure.com/org/Proj",
      iterationPath: "Proj\\Phase 1",
    });
  });

  it("keeps the Azure DevOps modal open with the error inline when loading fails", async () => {
    const user = userEvent.setup();
    const message = "No resolved User Stories or Bugs were found under Iteration path: Proj\\Phase 1.";
    mockAdo(json({ errors: [message] }, 422));
    renderAt("/monte-carlo", <DataSourcePage />, { initialCredentials: ADO_CREDENTIALS });
    await loadFromAdo(user);
    expect(await within(screen.getByRole("dialog")).findByRole("alert")).toHaveTextContent(message);
    expect(location()).toBe("/monte-carlo");
  });

  it("opens the Import Excel modal from the Excel card", async () => {
    const user = userEvent.setup();
    renderAt("/monte-carlo", <DataSourcePage />, { initialCredentials: ADO_CREDENTIALS });
    expect(excelCard()).toHaveAttribute("aria-haspopup", "dialog");
    await user.click(excelCard());
    expect(screen.getByRole("dialog", { name: "Import an Excel file" })).toBeInTheDocument();
    expect(screen.getByLabelText("Sprint history file")).toHaveFocus();
    expect(location()).toBe("/monte-carlo");
  });

  it("opens the modal from the keyboard and Cancel returns focus to the card", async () => {
    const user = userEvent.setup();
    renderAt("/monte-carlo", <DataSourcePage />, { initialCredentials: ADO_CREDENTIALS });
    excelCard().focus();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(excelCard()).toHaveFocus();
    expect(location()).toBe("/monte-carlo");
  });

  it("stores the chosen file, clears stale results and goes to the input form", async () => {
    const user = userEvent.setup();
    renderAt("/monte-carlo", <DataSourcePage />, {
      initialCredentials: ADO_CREDENTIALS,
      validation,
      execution: { result, sprintStartDate: "2026-01-05" },
      routes: { "/monte-carlo/input": <StoreProbe /> },
    });
    await user.click(excelCard());
    await user.upload(screen.getByLabelText("Sprint history file"), new File(["xlsx"], "history.xlsx"));
    await user.click(screen.getByRole("button", { name: "Continue" }));

    expect(location()).toBe("/monte-carlo/input");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByTestId("source")).toHaveTextContent('{"excel":"history.xlsx"}');
    expect(screen.getByTestId("stale")).toHaveTextContent("true/true");
  });

  it("keeps the modal open and stays on the page for an invalid choice", async () => {
    const user = userEvent.setup();
    renderAt("/monte-carlo", <DataSourcePage />, { initialCredentials: ADO_CREDENTIALS });
    await user.click(excelCard());
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Select an .xlsx file.");
    expect(location()).toBe("/monte-carlo");
  });

  it("opens the How to Use help, which describes loading from Azure DevOps", async () => {
    const user = userEvent.setup();
    renderAt("/monte-carlo", <DataSourcePage />, { initialCredentials: ADO_CREDENTIALS });
    await user.click(screen.getByRole("button", { name: "How to Use" }));
    const dialog = screen.getByRole("dialog", { name: "How to Use This Application" });
    expect(within(dialog).queryByText(/coming soon/i)).not.toBeInTheDocument();
    expect(within(dialog).getByText(/Work Items \(Read\)/)).toBeInTheDocument();
    expect(within(dialog).getByText(/configured in/)).toBeInTheDocument();
    expect(within(dialog).getByText(/first screen lets you choose the data source/)).toBeInTheDocument();
  });
});
