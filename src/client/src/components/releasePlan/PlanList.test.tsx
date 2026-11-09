import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../lib/monteCarlo/api";
import { deletePlan, listPlans } from "../../lib/releasePlan/planApi";
import type { PlanListResponse, PlanSummary } from "../../lib/releasePlan/planTypes";
import { renderAt } from "../../test/render";
import { PlanList } from "./PlanList";

vi.mock("../../lib/releasePlan/planApi", () => ({
  listPlans: vi.fn(),
  deletePlan: vi.fn(),
}));

const listMock = vi.mocked(listPlans);
const deleteMock = vi.mocked(deletePlan);

const summary = (id: number, over: Partial<PlanSummary> = {}): PlanSummary => ({
  id,
  name: `Plan ${id}`,
  projectType: "onprem",
  projectName: "Proj",
  createdAt: "2026-11-01T08:00:00Z",
  updatedAt: "2026-11-03T10:15:00Z",
  ...over,
});

const response = (items: PlanSummary[], total = items.length, page = 1): PlanListResponse => ({ items, total, page, pageSize: 10 });

const renderList = () => renderAt("/release-plan", <PlanList />);

beforeEach(() => {
  listMock.mockReset();
  deleteMock.mockReset();
});

describe("PlanList", () => {
  it("shows a loading state, then the rows with link, project label and dates", async () => {
    listMock.mockResolvedValue(
      response([summary(1), summary(2, { projectType: "cloud", projectName: "Hub", name: "Second" })]),
    );
    renderList();
    expect(screen.getByRole("heading", { name: "Saved release plans" })).toBeInTheDocument();
    expect(screen.getByText(/Loading saved release plans/)).toBeInTheDocument();
    const table = await screen.findByRole("table");
    const rows = within(table).getAllByRole("row");
    expect(rows).toHaveLength(3);
    expect(within(table).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Name", "Project", "Created On", "Last modified", "Actions"]);
    expect(within(rows[1]).getByRole("link", { name: "Plan 1" })).toHaveAttribute("href", "/release-plan/1");
    expect(within(rows[1]).getByText("On Prem · Proj")).toBeInTheDocument();
    expect(within(rows[1]).getByText(new Date("2026-11-01T08:00:00Z").toLocaleString())).toBeInTheDocument();
    expect(within(rows[1]).getByText(new Date("2026-11-03T10:15:00Z").toLocaleString())).toBeInTheDocument();
    expect(within(rows[2]).getByRole("link", { name: "Second" })).toHaveAttribute("href", "/release-plan/2");
    expect(within(rows[2]).getByText("Collaboration Hub · Hub")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete Second" })).toBeInTheDocument();
    expect(listMock).toHaveBeenCalledWith(1, expect.any(AbortSignal));
  });

  it("hides the pager when everything fits on one page", async () => {
    listMock.mockResolvedValue(response([summary(1)], 10));
    renderList();
    await screen.findByRole("table");
    expect(screen.queryByRole("button", { name: "Next" })).not.toBeInTheDocument();
    expect(screen.queryByText(/Page 1 of/)).not.toBeInTheDocument();
  });

  it("pages with Previous / Next and shows Page X of Y", async () => {
    const user = userEvent.setup();
    listMock.mockImplementation(async (page) => response([summary(page * 10)], 25, page));
    renderList();
    expect(await screen.findByText("Page 1 of 3")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByRole("link", { name: "Plan 20" })).toBeInTheDocument();
    expect(screen.getByText("Page 2 of 3")).toBeInTheDocument();
    expect(listMock).toHaveBeenLastCalledWith(2, expect.any(AbortSignal));
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByText("Page 3 of 3")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Previous" }));
    expect(await screen.findByText("Page 2 of 3")).toBeInTheDocument();
  });

  it("aborts the previous page request when the page changes and ignores its response", async () => {
    const user = userEvent.setup();
    const signals: AbortSignal[] = [];
    const resolvers: Array<(r: PlanListResponse) => void> = [];
    listMock.mockImplementation((page, signal) => {
      if (signal) signals.push(signal);
      if (page === 1) return Promise.resolve(response([summary(1)], 25, 1));
      return new Promise<PlanListResponse>((resolve) => resolvers.push(resolve));
    });
    renderList();
    await screen.findByRole("link", { name: "Plan 1" });
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(signals[1].aborted).toBe(false);
    expect(signals[0].aborted).toBe(true);
    resolvers[0](response([summary(20)], 25, 2));
    expect(await screen.findByRole("link", { name: "Plan 20" })).toBeInTheDocument();
  });

  it("ignores a response that arrives after the request was aborted by unmount", async () => {
    let signal: AbortSignal | undefined;
    let resolve: (r: PlanListResponse) => void = () => undefined;
    listMock.mockImplementation((_page, s) => {
      signal = s;
      return new Promise<PlanListResponse>((r) => (resolve = r));
    });
    const view = renderList();
    expect(signal?.aborted).toBe(false);
    view.unmount();
    expect(signal?.aborted).toBe(true);
    resolve(response([summary(1)]));
  });

  it("shows the empty state", async () => {
    listMock.mockResolvedValue(response([]));
    renderList();
    expect(await screen.findByText("No saved release plans yet. Create one from Azure DevOps.")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("shows the error with Retry, which refetches", async () => {
    const user = userEvent.setup();
    listMock.mockRejectedValueOnce(new ApiError(["The release plan database is unavailable."], 503));
    listMock.mockResolvedValueOnce(response([summary(1)]));
    renderList();
    expect(await screen.findByRole("alert")).toHaveTextContent("The release plan database is unavailable.");
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("link", { name: "Plan 1" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(listMock).toHaveBeenCalledTimes(2);
  });

  it("Cancel in the delete dialog deletes nothing", async () => {
    const user = userEvent.setup();
    listMock.mockResolvedValue(response([summary(1)]));
    renderList();
    await user.click(await screen.findByRole("button", { name: "Delete Plan 1" }));
    const dialog = screen.getByRole("dialog", { name: "Delete release plan" });
    expect(dialog).toHaveTextContent("Delete Plan 1? This cannot be undone.");
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it("deletes after confirmation, toasts and refetches the page", async () => {
    const user = userEvent.setup();
    listMock.mockResolvedValueOnce(response([summary(1), summary(2)])).mockResolvedValueOnce(response([summary(2)]));
    deleteMock.mockResolvedValue(undefined);
    renderList();
    await user.click(await screen.findByRole("button", { name: "Delete Plan 1" }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(screen.queryByRole("link", { name: "Plan 1" })).not.toBeInTheDocument());
    expect(deleteMock).toHaveBeenCalledWith(1);
    expect(screen.getAllByRole("status").some((s) => s.textContent?.includes("Plan deleted: Plan 1"))).toBe(true);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(listMock).toHaveBeenCalledTimes(2);
    expect(listMock).toHaveBeenLastCalledWith(1, expect.any(AbortSignal));
  });

  it("goes back one page when the delete empties the current page", async () => {
    const user = userEvent.setup();
    listMock.mockImplementation(async (page) => (page === 1 ? response([summary(1)], 11, 1) : response([summary(11)], 11, 2)));
    deleteMock.mockResolvedValue(undefined);
    renderList();
    await user.click(await screen.findByRole("button", { name: "Next" }));
    await user.click(await screen.findByRole("button", { name: "Delete Plan 11" }));
    listMock.mockImplementation(async (page) => response([summary(1)], 10, page));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(listMock).toHaveBeenLastCalledWith(1, expect.any(AbortSignal)));
    expect(await screen.findByRole("link", { name: "Plan 1" })).toBeInTheDocument();
  });

  it("shows an error toast with the server message when the delete fails, and refetches the list", async () => {
    const user = userEvent.setup();
    listMock.mockResolvedValue(response([summary(1)]));
    deleteMock.mockRejectedValue(new ApiError(["Release plan not found: 1."], 404));
    renderList();
    await user.click(await screen.findByRole("button", { name: "Delete Plan 1" }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Release plan not found: 1.");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Plan 1" })).toBeInTheDocument();
    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(2));
  });

  it("moves to the last page when a page past the end comes back empty although plans exist", async () => {
    const user = userEvent.setup();
    listMock.mockImplementation(async (page) => response([summary(1)], 45, page));
    renderList();
    await user.click(await screen.findByRole("button", { name: "Next" }));
    // Rows were deleted elsewhere: only one page is left, so page 2 is past the end.
    listMock.mockImplementation(async (page) => (page === 1 ? response([summary(7)], 5, 1) : response([], 5, page)));
    await user.click(await screen.findByRole("button", { name: "Next" }));
    expect(await screen.findByRole("link", { name: "Plan 7" })).toBeInTheDocument();
    expect(screen.queryByText(/No saved release plans yet/)).not.toBeInTheDocument();
    expect(listMock).toHaveBeenLastCalledWith(1, expect.any(AbortSignal));
  });
});
