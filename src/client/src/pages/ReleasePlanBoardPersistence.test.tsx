import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AUTOSAVE_KEY } from "../lib/releasePlan/autosavePreference";
import { disableAutosave, planDetail, stubPlanServer } from "../test/planServer";
import { samplePlan } from "../test/releasePlanFixtures";
import { renderAt } from "../test/render";
import { BOARD_PLAN_ID, BOARD_TEST_TIMEOUT_MS, renderBoard } from "../test/renderBoard";
import { useReleasePlan } from "../releasePlanStore";
import { ReleasePlanBoardPage } from "./ReleasePlanBoardPage";

function StoreProbe() {
  const { plan, planId } = useReleasePlan();
  return <p data-testid="store">{`${planId ?? "none"}/${plan ? plan.name : "none"}`}</p>;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const location = () => screen.getByTestId("location").textContent;
const status = () => screen.getByTestId("save-status");
const toastTexts = () => screen.queryAllByRole("alert").map((a) => a.textContent ?? "");
const OPEN_TITLE = "Could not open the release plan";

/** The board page at `/release-plan/<entry>` with an empty store, so it has to load the plan. */
const renderEmpty = (entry: string) => renderAt("/release-plan/:id", <ReleasePlanBoardPage />, { initialEntry: `/release-plan/${entry}` });

/** Edits the plan name through the toolbar (one change). */
async function rename(user: ReturnType<typeof userEvent.setup>, name: string) {
  const input = screen.getByLabelText("Plan name");
  await user.clear(input);
  await user.type(input, `${name}{Enter}`);
}

const sidebarLink = (name: string) => within(screen.getByRole("navigation", { name: "Hub navigation" })).getByRole("link", { name });

beforeEach(() => window.localStorage.clear());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe("ReleasePlanBoardPage loading", { timeout: BOARD_TEST_TIMEOUT_MS }, () => {
  it("fetches the plan by id, normalizes its state and shows the board as saved", async () => {
    const { fetchMock } = stubPlanServer(samplePlan(), { id: 5 });
    renderEmpty("5");
    expect(screen.getByRole("status")).toHaveTextContent("Loading release plan");
    expect(await screen.findByLabelText("Plan name")).toHaveValue("Sample Release Plan");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/plan/5");
    expect(status()).toHaveTextContent("Saved");
  });

  it("skips the fetch when the store already holds that id", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    renderBoard(samplePlan());
    expect(screen.getByLabelText("Plan name")).toHaveValue("Sample Release Plan");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fetches when the store holds a different plan id", async () => {
    const { fetchMock } = stubPlanServer(samplePlan({ name: "From server" }), { id: 2 });
    renderAt("/release-plan/:id", <ReleasePlanBoardPage />, { initialPlan: samplePlan({ name: "Other" }), initialPlanId: 1, initialEntry: "/release-plan/2" });
    expect(await screen.findByLabelText("Plan name")).toHaveValue("From server");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a 404 toasts 'Release plan not found' and goes to the list", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ errors: ["Release plan not found: 9."] }, 404)));
    renderEmpty("9");
    await waitFor(() => expect(location()).toBe("/release-plan"));
    expect(toastTexts()).toEqual([`${OPEN_TITLE}Release plan not found`]);
  });

  it("a non-numeric id toasts 'Release plan not found' without calling the server", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    renderEmpty("abc");
    await waitFor(() => expect(location()).toBe("/release-plan"));
    expect(toastTexts()).toEqual([`${OPEN_TITLE}Release plan not found`]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("an unreadable state toasts 'This release plan could not be read' and goes to the list", async () => {
    stubPlanServer({ schema: "something else" });
    renderEmpty("1");
    await waitFor(() => expect(location()).toBe("/release-plan"));
    expect(toastTexts()).toEqual([`${OPEN_TITLE}This release plan could not be read`]);
  });

  it("another error shows its message with a Retry that loads the plan", async () => {
    const user = userEvent.setup();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ errors: ["The release plan database is unavailable."] }, 503))
      .mockResolvedValue(json(planDetail(3, samplePlan())));
    vi.stubGlobal("fetch", fetchMock);
    renderEmpty("3");
    expect(await screen.findByRole("alert")).toHaveTextContent("The release plan database is unavailable.");
    expect(location()).toBe("/release-plan/3");
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByLabelText("Plan name")).toHaveValue("Sample Release Plan");
  });

  it("clears the plan from the store when leaving the board", async () => {
    const user = userEvent.setup();
    renderAt("/release-plan/:id", <ReleasePlanBoardPage />, {
      initialPlan: samplePlan(),
      initialPlanId: 1,
      initialEntry: "/release-plan/1",
      routes: { "/monte-carlo": <StoreProbe /> },
    });
    await user.click(sidebarLink("Monte Carlo"));
    expect(screen.getByTestId("store")).toHaveTextContent("none/none");
  });

  it("still opens a plan already in the store under StrictMode's mount/unmount/mount", async () => {
    configure({ reactStrictMode: true });
    try {
      stubPlanServer(samplePlan({ name: "From server" }), { id: BOARD_PLAN_ID });
      renderBoard(samplePlan({ name: "In store" }));
      // The simulated unmount cleared the store, so the page reloads the plan from the server.
      expect(await screen.findByLabelText("Plan name")).toHaveValue("From server");
    } finally {
      configure({ reactStrictMode: false });
    }
  });

  it("aborts the request when the page unmounts", () => {
    let signal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init?: RequestInit) => {
        signal = init?.signal ?? undefined;
        return new Promise<Response>(() => undefined);
      }),
    );
    const view = renderEmpty("1");
    expect(signal?.aborted).toBe(false);
    view.unmount();
    expect(signal?.aborted).toBe(true);
  });
});

describe("ReleasePlanBoardPage saving", { timeout: BOARD_TEST_TIMEOUT_MS }, () => {
  it("autosaves 3 s after a change (PUT to the plan's id)", async () => {
    const { puts, fetchMock } = stubPlanServer(samplePlan(), { id: BOARD_PLAN_ID });
    const user = userEvent.setup();
    renderBoard(samplePlan());
    await rename(user, "Renamed");
    expect(status()).toHaveTextContent("Unsaved changes");
    await waitFor(() => expect(puts).toHaveLength(1), { timeout: 5000 });
    expect(puts[0].name).toBe("Renamed");
    expect(fetchMock.mock.calls[0][0]).toBe(`/api/plan/${BOARD_PLAN_ID}`);
    await waitFor(() => expect(status()).toHaveTextContent("Saved"));
  });

  it("with autosave off the Save button saves", async () => {
    disableAutosave();
    const { puts } = stubPlanServer(samplePlan(), { id: BOARD_PLAN_ID });
    const user = userEvent.setup();
    renderBoard(samplePlan());
    expect(screen.getByRole("switch", { name: "Autosave" })).toHaveAttribute("aria-checked", "false");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    await rename(user, "Manual");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(status()).toHaveTextContent("Saved"));
    expect(puts.map((p) => p.name)).toEqual(["Manual"]);
  });

  it("the Autosave switch stores the preference", async () => {
    const user = userEvent.setup();
    renderBoard(samplePlan());
    await user.click(screen.getByRole("switch", { name: "Autosave" }));
    expect(window.localStorage.getItem(AUTOSAVE_KEY)).toBe("off");
    expect(screen.getByRole("switch", { name: "Autosave" })).toHaveAttribute("aria-checked", "false");
  });
});

describe("ReleasePlanBoardPage unsaved-changes guard", { timeout: BOARD_TEST_TIMEOUT_MS }, () => {
  beforeEach(() => disableAutosave());

  it("does not block navigation when everything is saved", async () => {
    const user = userEvent.setup();
    renderBoard(samplePlan());
    await user.click(sidebarLink("Monte Carlo"));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(location()).toBe("/monte-carlo");
  });

  it("Cancel keeps the board and its changes", async () => {
    const user = userEvent.setup();
    renderBoard(samplePlan());
    await rename(user, "Edited");
    await user.click(sidebarLink("Monte Carlo"));
    const dialog = screen.getByRole("dialog", { name: "Unsaved changes" });
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(location()).toBe(`/release-plan/${BOARD_PLAN_ID}`);
    expect(screen.getByLabelText("Plan name")).toHaveValue("Edited");
  });

  it("Discard leaves without saving", async () => {
    const { puts } = stubPlanServer(samplePlan(), { id: BOARD_PLAN_ID });
    const user = userEvent.setup();
    renderBoard(samplePlan());
    await rename(user, "Edited");
    await user.click(sidebarLink("Monte Carlo"));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Discard" }));
    expect(location()).toBe("/monte-carlo");
    expect(puts).toHaveLength(0);
  });

  it("Save saves, then leaves", async () => {
    const { puts } = stubPlanServer(samplePlan(), { id: BOARD_PLAN_ID });
    const user = userEvent.setup();
    renderBoard(samplePlan());
    await rename(user, "Edited");
    await user.click(sidebarLink("Monte Carlo"));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(location()).toBe("/monte-carlo"));
    expect(puts.map((p) => p.name)).toEqual(["Edited"]);
  });

  it("a failed Save keeps the dialog open with the error, and Save works again afterwards", async () => {
    let fail = true;
    const puts: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        puts.push(String(init?.body));
        return fail ? json({ errors: ["The release plan database is unavailable."] }, 503) : json(planDetail(BOARD_PLAN_ID, {}));
      }),
    );
    const user = userEvent.setup();
    renderBoard(samplePlan());
    await rename(user, "Edited");
    await user.click(sidebarLink("Monte Carlo"));
    const dialog = screen.getByRole("dialog", { name: "Unsaved changes" });
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(await within(dialog).findByText(/Save failed\. Try again/)).toBeInTheDocument();
    expect(location()).toBe(`/release-plan/${BOARD_PLAN_ID}`);
    expect(status()).toHaveTextContent("Save failed");

    fail = false;
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(location()).toBe("/monte-carlo"));
    expect(puts).toHaveLength(2);
  });
});

describe("ReleasePlanBoardPage beforeunload", { timeout: BOARD_TEST_TIMEOUT_MS }, () => {
  beforeEach(() => disableAutosave());

  const unload = () => {
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  };

  it("is prompted only while there are unsaved changes", async () => {
    stubPlanServer(samplePlan(), { id: BOARD_PLAN_ID });
    const user = userEvent.setup();
    renderBoard(samplePlan());
    expect(unload()).toBe(false);
    await rename(user, "Edited");
    expect(unload()).toBe(true);
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(status()).toHaveTextContent("Saved"));
    expect(unload()).toBe(false);
  });

  it("removes the listener when the board unmounts", async () => {
    const user = userEvent.setup();
    const view = renderBoard(samplePlan());
    await rename(user, "Edited");
    expect(unload()).toBe(true);
    view.unmount();
    expect(unload()).toBe(false);
  });
});
