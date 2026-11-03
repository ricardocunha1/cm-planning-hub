import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReleasePlanProvider, useReleasePlan } from "./releasePlanStore";
import { samplePlan } from "./test/releasePlanFixtures";

let api: ReturnType<typeof useReleasePlan> | null = null;
function Probe() {
  api = useReleasePlan();
  return <p data-testid="name">{api.plan?.name ?? "none"}</p>;
}

const current = () => {
  if (!api) {
    throw new Error("no store");
  }
  return api;
};

const LEGACY_KEY = "cmPlanningHub.releasePlan.v1";

describe("ReleasePlanProvider", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    window.localStorage.clear();
  });

  it("throws outside a provider", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    // jsdom also reports the render error as a window "error" event; keep the output clean.
    const silence = (event: ErrorEvent) => event.preventDefault();
    window.addEventListener("error", silence);
    try {
      expect(() => render(<Probe />)).toThrow("useReleasePlan must be used within a ReleasePlanProvider");
    } finally {
      window.removeEventListener("error", silence);
    }
  });

  it("starts empty, and with initialPlan / initialPlanId when given", () => {
    const { unmount } = render(
      <ReleasePlanProvider>
        <Probe />
      </ReleasePlanProvider>,
    );
    expect(screen.getByTestId("name")).toHaveTextContent("none");
    expect(current().planId).toBeNull();
    unmount();

    render(
      <ReleasePlanProvider initialPlan={samplePlan({ name: "Given" })} initialPlanId={4}>
        <Probe />
      </ReleasePlanProvider>,
    );
    expect(screen.getByTestId("name")).toHaveTextContent("Given");
    expect(current().planId).toBe(4);
  });

  it("applies dispatched actions", () => {
    render(
      <ReleasePlanProvider initialPlan={samplePlan()}>
        <Probe />
      </ReleasePlanProvider>,
    );
    act(() => current().dispatch({ type: "rename", name: "Renamed" }));
    expect(screen.getByTestId("name")).toHaveTextContent("Renamed");
  });

  it("loadPlan sets the plan and its server id; clearPlan removes both", () => {
    render(
      <ReleasePlanProvider>
        <Probe />
      </ReleasePlanProvider>,
    );
    act(() => current().loadPlan(12, samplePlan({ name: "Saved" })));
    expect(screen.getByTestId("name")).toHaveTextContent("Saved");
    expect(current().planId).toBe(12);
    act(() => current().clearPlan());
    expect(screen.getByTestId("name")).toHaveTextContent("none");
    expect(current().planId).toBeNull();
  });

  it("does not save the plan to localStorage", () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    render(
      <ReleasePlanProvider initialPlan={samplePlan()}>
        <Probe />
      </ReleasePlanProvider>,
    );
    act(() => current().dispatch({ type: "rename", name: "Renamed" }));
    expect(setItem).not.toHaveBeenCalled();
  });

  it("removes the legacy localStorage autosave key on mount", () => {
    window.localStorage.setItem(LEGACY_KEY, "{}");
    window.localStorage.setItem("other", "kept");
    render(
      <ReleasePlanProvider>
        <Probe />
      </ReleasePlanProvider>,
    );
    expect(window.localStorage.getItem(LEGACY_KEY)).toBeNull();
    expect(window.localStorage.getItem("other")).toBe("kept");
  });

  it("survives unavailable localStorage", () => {
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new Error("denied");
    });
    render(
      <ReleasePlanProvider>
        <Probe />
      </ReleasePlanProvider>,
    );
    expect(screen.getByTestId("name")).toHaveTextContent("none");
  });
});
