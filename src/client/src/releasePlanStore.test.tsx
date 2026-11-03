import { act, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { PlanStorage } from "./lib/releasePlan/storage";
import { ReleasePlanProvider, useReleasePlan } from "./releasePlanStore";
import { samplePlan } from "./test/releasePlanFixtures";

let api: ReturnType<typeof useReleasePlan> | null = null;
function Probe() {
  api = useReleasePlan();
  return <p data-testid="name">{api.plan?.name ?? "none"}</p>;
}

function mockStorage(saved = samplePlan()) {
  return { load: vi.fn<PlanStorage["load"]>(() => saved), save: vi.fn<PlanStorage["save"]>() };
}

const current = () => {
  if (!api) {
    throw new Error("no store");
  }
  return api;
};

describe("ReleasePlanProvider", () => {
  it("throws outside a provider", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    // jsdom also reports the render error as a window "error" event; keep the output clean.
    const silence = (event: ErrorEvent) => event.preventDefault();
    window.addEventListener("error", silence);
    try {
      expect(() => render(<Probe />)).toThrow("useReleasePlan must be used within a ReleasePlanProvider");
    } finally {
      window.removeEventListener("error", silence);
      vi.restoreAllMocks();
    }
  });

  it("hydrates from storage, flags the restore and hands out the notice once", () => {
    const storage = mockStorage();
    render(
      <ReleasePlanProvider storage={storage}>
        <Probe />
      </ReleasePlanProvider>,
    );
    expect(screen.getByTestId("name")).toHaveTextContent("Sample Release Plan");
    expect(current().restoredFromStorage).toBe(true);
    expect(current().consumeRestoredNotice()).toBe(true);
    expect(current().consumeRestoredNotice()).toBe(false);
  });

  it("saves after each change", () => {
    const storage = mockStorage();
    render(
      <ReleasePlanProvider storage={storage}>
        <Probe />
      </ReleasePlanProvider>,
    );
    act(() => current().dispatch({ type: "rename", name: "Renamed" }));
    expect(screen.getByTestId("name")).toHaveTextContent("Renamed");
    expect(storage.save).toHaveBeenLastCalledWith(expect.objectContaining({ name: "Renamed" }));
  });

  it("replacePlan swaps the plan and clears the restored notice", () => {
    const storage = mockStorage();
    render(
      <ReleasePlanProvider storage={storage}>
        <Probe />
      </ReleasePlanProvider>,
    );
    act(() => current().replacePlan(samplePlan({ name: "Fresh" })));
    expect(screen.getByTestId("name")).toHaveTextContent("Fresh");
    expect(current().consumeRestoredNotice()).toBe(false);
  });

  it("starts empty with nothing saved, and uses initialPlan without loading storage", () => {
    const empty: PlanStorage = { load: () => null, save: () => undefined };
    const { unmount } = render(
      <ReleasePlanProvider storage={empty}>
        <Probe />
      </ReleasePlanProvider>,
    );
    expect(screen.getByTestId("name")).toHaveTextContent("none");
    expect(current().restoredFromStorage).toBe(false);
    unmount();

    const storage = mockStorage();
    render(
      <ReleasePlanProvider storage={storage} initialPlan={samplePlan({ name: "Given" })}>
        <Probe />
      </ReleasePlanProvider>,
    );
    expect(screen.getByTestId("name")).toHaveTextContent("Given");
    expect(storage.load).not.toHaveBeenCalled();
    expect(current().restoredFromStorage).toBe(false);
  });

  it("works in memory with storage disabled", () => {
    render(
      <ReleasePlanProvider storage={null}>
        <Probe />
      </ReleasePlanProvider>,
    );
    act(() => current().replacePlan(samplePlan()));
    expect(screen.getByTestId("name")).toHaveTextContent("Sample Release Plan");
  });

  it("loadPlan sets the plan and its server id; replacePlan clears the id", () => {
    render(
      <ReleasePlanProvider initialPlan={null} storage={null}>
        <Probe />
      </ReleasePlanProvider>,
    );
    expect(current().planId).toBeNull();
    act(() => current().loadPlan(12, samplePlan({ name: "Saved" })));
    expect(screen.getByTestId("name")).toHaveTextContent("Saved");
    expect(current().planId).toBe(12);
    act(() => current().replacePlan(samplePlan({ name: "Other" })));
    expect(screen.getByTestId("name")).toHaveTextContent("Other");
    expect(current().planId).toBeNull();
  });
});
