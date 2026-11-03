import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listPlans } from "../lib/releasePlan/planApi";
import { useReleasePlan } from "../releasePlanStore";
import { makeBacklog, makeConnectResponse } from "../test/adoFixtures";
import { renderAt } from "../test/render";
import { ReleasePlanHomePage } from "./ReleasePlanHomePage";

vi.mock("../lib/releasePlan/planApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/releasePlan/planApi")>()),
  listPlans: vi.fn(),
}));

const adoCard = () => screen.getByRole("button", { name: /Create from Azure DevOps/ });
const location = () => screen.getByTestId("location").textContent;

/** Board stub that shows the store's plan name, Epic titles and server id. */
function BoardStub() {
  const { plan, planId } = useReleasePlan();
  return (
    <>
      <p>board: {plan?.name ?? "none"}</p>
      <p data-testid="board-id">{String(planId)}</p>
      <p data-testid="board-epics">{plan?.epics.map((e) => e.title).join(" | ")}</p>
    </>
  );
}

const routes = { "/release-plan/:id": <BoardStub /> };

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** Stubs `fetch` for the ADO routes (fixtures) and `POST /api/plan` (201, id 42). */
function mockServer(backlog = makeBacklog(), plan?: () => Response) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    if (url === "/api/ado/connect") return json(makeConnectResponse());
    if (url === "/api/ado/backlog") return json(backlog);
    if (url === "/api/plan") {
      if (plan) return plan();
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      return json({ id: 42, ...body, createdAt: "2026-11-03T10:00:00Z", updatedAt: "2026-11-03T10:00:00Z" }, 201);
    }
    throw new Error(`unexpected ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** Runs the ADO modal: Collaboration Hub, URL, PAT, Connect, "Team A", then (optionally renamed) Create board. */
async function createFromAdo(user: ReturnType<typeof userEvent.setup>, name?: string) {
  await user.click(adoCard());
  const dialog = screen.getByRole("dialog", { name: "Create from Azure DevOps" });
  await user.click(within(dialog).getByRole("radio", { name: "Collaboration Hub" }));
  await user.type(within(dialog).getByLabelText("Project URL"), "https://dev.azure.com/org/Proj");
  await user.type(within(dialog).getByLabelText("Personal Access Token"), "pat-value");
  await user.click(within(dialog).getByRole("button", { name: "Connect" }));
  await user.click(within(await screen.findByRole("tree", { name: "Area path" })).getByRole("treeitem", { name: /^Team A/ }));
  if (name !== undefined) {
    await user.clear(within(dialog).getByLabelText("Plan name"));
    await user.type(within(dialog).getByLabelText("Plan name"), name);
  }
  await user.click(within(dialog).getByRole("button", { name: "Create board" }));
}

describe("ReleasePlanHomePage", () => {
  beforeEach(() => {
    vi.mocked(listPlans).mockReset();
    vi.mocked(listPlans).mockResolvedValue({
      items: [
        {
          id: 3,
          name: "Saved one",
          projectType: "cloud",
          projectName: "Proj",
          createdAt: "2026-11-01T08:00:00Z",
          updatedAt: "2026-11-02T08:00:00Z",
        },
      ],
      total: 1,
      page: 1,
      pageSize: 10,
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    window.localStorage.clear();
  });

  it("renders inside the Release Plan layout with its title", async () => {
    renderAt("/release-plan", <ReleasePlanHomePage />);
    expect(screen.queryByRole("heading", { name: "Release Plan" })).not.toBeInTheDocument();
    expect(document.title).toBe("Planning Hub – Release Plan");
    await screen.findByRole("table");
  });

  it("shows the Azure DevOps card and the saved plans list, with no JSON import or Continue section", async () => {
    renderAt("/release-plan", <ReleasePlanHomePage />);
    expect(adoCard()).toBeEnabled();
    expect(screen.getByRole("heading", { name: "Saved release plans" })).toBeInTheDocument();
    expect(await screen.findByRole("link", { name: "Saved one" })).toHaveAttribute("href", "/release-plan/3");
    expect(screen.queryByRole("button", { name: /JSON/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Continue last board" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Last board" })).not.toBeInTheDocument();
  });

  it("opens and closes the Azure DevOps modal from its card", async () => {
    const user = userEvent.setup();
    renderAt("/release-plan", <ReleasePlanHomePage />);
    await user.click(adoCard());
    expect(screen.getByRole("dialog", { name: "Create from Azure DevOps" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(location()).toBe("/release-plan");
  });

  it("creates a plan: stores it with its id, opens /release-plan/<id> and toasts 'Plan created' and the warnings", async () => {
    const user = userEvent.setup();
    const warning = "Neither Custom.EstimatedSize nor Custom.FeatureSize exists in this project; sizes are empty.";
    const fetchMock = mockServer(makeBacklog({ warnings: [warning] }));
    renderAt("/release-plan", <ReleasePlanHomePage />, { routes });
    await createFromAdo(user);
    expect(await screen.findByText("board: Proj – Feature Release Plan")).toBeInTheDocument();
    expect(screen.getByTestId("board-id")).toHaveTextContent("42");
    expect(screen.getByTestId("board-epics")).toHaveTextContent("Wave 1 | Wave 2 | Features without an Epic");
    expect(location()).toBe("/release-plan/42");
    const toasts = screen.getAllByRole("status").map((el) => el.textContent);
    expect(toasts.some((t) => t?.includes("Plan created: Proj – Feature Release Plan"))).toBe(true);
    expect(toasts.some((t) => t?.includes(warning))).toBe(true);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.map((c) => String(c[0]))).toEqual(["/api/ado/connect", "/api/ado/backlog", "/api/plan"]);
  });

  it("uses the name typed in the modal", async () => {
    const user = userEvent.setup();
    mockServer();
    renderAt("/release-plan", <ReleasePlanHomePage />, { routes });
    await createFromAdo(user, "Custom name");
    expect(await screen.findByText("board: Custom name")).toBeInTheDocument();
    expect(screen.getAllByRole("status").some((el) => el.textContent?.includes("Plan created: Custom name"))).toBe(true);
  });

  it("keeps the modal open with the inline error when saving fails", async () => {
    const user = userEvent.setup();
    mockServer(makeBacklog(), () => json({ errors: ["The release plan database is unavailable."] }, 503));
    renderAt("/release-plan", <ReleasePlanHomePage />, { routes });
    await createFromAdo(user);
    const dialog = await screen.findByRole("dialog", { name: "Create from Azure DevOps" });
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("The release plan database is unavailable.");
    expect(location()).toBe("/release-plan");
  });
});
