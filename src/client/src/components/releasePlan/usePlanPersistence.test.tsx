import { act, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AUTOSAVE_KEY } from "../../lib/releasePlan/autosavePreference";
import { ApiError } from "../../lib/monteCarlo/api";
import { updatePlan } from "../../lib/releasePlan/planApi";
import type { PlanDetail } from "../../lib/releasePlan/planTypes";
import type { ReleasePlan } from "../../lib/releasePlan/types";
import { samplePlan } from "../../test/releasePlanFixtures";
import { renderAt } from "../../test/render";
import { AUTOSAVE_DELAY_MS, usePlanPersistence, type PlanPersistence } from "./usePlanPersistence";

vi.mock("../../lib/releasePlan/planApi", () => ({ updatePlan: vi.fn() }));
const updateMock = vi.mocked(updatePlan);

let hook: PlanPersistence;
let change: (name: string) => void;

function Harness({ initial }: { initial: ReleasePlan }) {
  const [plan, setPlan] = useState(initial);
  change = (name) => setPlan((p) => ({ ...p, name }));
  hook = usePlanPersistence(7, plan);
  return <p data-testid="status">{hook.status}</p>;
}

const detail = (): PlanDetail => ({ id: 7, name: "x", projectType: "cloud", projectName: "P", createdAt: "", updatedAt: "", state: {} });

/** A PUT whose response the test resolves or rejects by hand. */
function deferred() {
  let resolve: (value: PlanDetail) => void = () => undefined;
  let reject: (reason: unknown) => void = () => undefined;
  const promise = new Promise<PlanDetail>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const status = () => screen.getByTestId("status").textContent;
const edit = (name: string) => act(() => change(name));
const advance = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));

function mount() {
  return renderAt("/board", <Harness initial={samplePlan()} />);
}

describe("usePlanPersistence", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    window.localStorage.clear();
    updateMock.mockReset();
    updateMock.mockResolvedValue(detail());
  });
  afterEach(() => {
    vi.useRealTimers();
    window.localStorage.clear();
  });

  it("starts saved, autosave on by default, and does not save the first plan", async () => {
    mount();
    expect(status()).toBe("saved");
    expect(hook.autosave).toBe(true);
    expect(hook.hasUnsaved()).toBe(false);
    await advance(AUTOSAVE_DELAY_MS * 2);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("saves {name, state} 3 s after a change, then reports saved", async () => {
    mount();
    edit("Renamed");
    expect(status()).toBe("dirty");
    expect(hook.hasUnsaved()).toBe(true);
    await advance(AUTOSAVE_DELAY_MS - 1);
    expect(updateMock).not.toHaveBeenCalled();
    await advance(1);
    expect(updateMock).toHaveBeenCalledTimes(1);
    const [id, body, signal] = updateMock.mock.calls[0];
    expect(id).toBe(7);
    expect(body.name).toBe("Renamed");
    expect(body.state).toEqual(expect.objectContaining({ name: "Renamed" }));
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(status()).toBe("saved");
  });

  it("coalesces changes made within the delay into one request with the latest state", async () => {
    mount();
    edit("One");
    await advance(2000);
    edit("Two");
    await advance(2000);
    edit("Three");
    await advance(AUTOSAVE_DELAY_MS - 1);
    expect(updateMock).not.toHaveBeenCalled();
    await advance(1);
    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(updateMock.mock.calls[0][1].name).toBe("Three");
  });

  it("with autosave off nothing is sent until saveNow", async () => {
    window.localStorage.setItem(AUTOSAVE_KEY, "off");
    mount();
    expect(hook.autosave).toBe(false);
    edit("Manual");
    await advance(AUTOSAVE_DELAY_MS * 3);
    expect(updateMock).not.toHaveBeenCalled();
    expect(status()).toBe("dirty");
    let ok = false;
    await act(async () => {
      ok = await hook.saveNow();
    });
    expect(ok).toBe(true);
    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(status()).toBe("saved");
  });

  it("turning autosave off cancels the pending save and remembers the choice; turning it on while unsaved schedules one", async () => {
    mount();
    edit("Changed");
    act(() => hook.setAutosave(false));
    expect(window.localStorage.getItem(AUTOSAVE_KEY)).toBe("off");
    await advance(AUTOSAVE_DELAY_MS * 2);
    expect(updateMock).not.toHaveBeenCalled();

    act(() => hook.setAutosave(true));
    expect(window.localStorage.getItem(AUTOSAVE_KEY)).toBe("on");
    await advance(AUTOSAVE_DELAY_MS - 1);
    expect(updateMock).not.toHaveBeenCalled();
    await advance(1);
    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(status()).toBe("saved");
  });

  it("turning autosave on with nothing unsaved sends nothing", async () => {
    window.localStorage.setItem(AUTOSAVE_KEY, "off");
    mount();
    act(() => hook.setAutosave(true));
    await advance(AUTOSAVE_DELAY_MS * 2);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("shows saving while the request is in flight", async () => {
    const pending = deferred();
    updateMock.mockReturnValueOnce(pending.promise);
    mount();
    edit("Slow");
    await advance(AUTOSAVE_DELAY_MS);
    expect(status()).toBe("saving");
    await act(async () => pending.resolve(detail()));
    expect(status()).toBe("saved");
  });

  it("is not saved when a newer change arrived during the request; that change is saved by its own debounce", async () => {
    const first = deferred();
    updateMock.mockReturnValueOnce(first.promise);
    mount();
    edit("First");
    await advance(AUTOSAVE_DELAY_MS);
    expect(status()).toBe("saving");
    edit("Second");
    await act(async () => first.resolve(detail()));
    expect(status()).toBe("dirty");
    expect(hook.hasUnsaved()).toBe(true);
    await advance(AUTOSAVE_DELAY_MS);
    expect(updateMock).toHaveBeenCalledTimes(2);
    expect(updateMock.mock.calls[1][1].name).toBe("Second");
    expect(status()).toBe("saved");
  });

  it("saveNow waits for the request in flight and then saves newer changes", async () => {
    const first = deferred();
    updateMock.mockReturnValueOnce(first.promise);
    mount();
    edit("First");
    await advance(AUTOSAVE_DELAY_MS);
    edit("Second");
    let result: Promise<boolean> = Promise.resolve(false);
    act(() => {
      result = hook.saveNow();
    });
    expect(updateMock).toHaveBeenCalledTimes(1);
    await act(async () => first.resolve(detail()));
    await expect(result).resolves.toBe(true);
    expect(updateMock).toHaveBeenCalledTimes(2);
    expect(updateMock.mock.calls[1][1].name).toBe("Second");
    expect(status()).toBe("saved");
  });

  it("a failed save sets error and toasts the server message; there is no automatic retry, the next change retries", async () => {
    updateMock.mockRejectedValueOnce(new ApiError(["Plan name is required."], 422));
    mount();
    edit("Bad");
    await advance(AUTOSAVE_DELAY_MS);
    expect(status()).toBe("error");
    expect(hook.hasUnsaved()).toBe(true);
    expect(screen.getByRole("alert")).toHaveTextContent("Plan name is required.");
    await advance(AUTOSAVE_DELAY_MS * 3);
    expect(updateMock).toHaveBeenCalledTimes(1);

    edit("Good");
    await advance(AUTOSAVE_DELAY_MS);
    expect(updateMock).toHaveBeenCalledTimes(2);
    expect(status()).toBe("saved");
  });

  it("saveNow after a failure retries and resolves false when it fails again", async () => {
    window.localStorage.setItem(AUTOSAVE_KEY, "off");
    updateMock.mockRejectedValue(new ApiError(["The release plan database is unavailable."], 503));
    mount();
    edit("x");
    let ok = true;
    await act(async () => {
      ok = await hook.saveNow();
    });
    expect(ok).toBe(false);
    expect(status()).toBe("error");
    updateMock.mockResolvedValue(detail());
    await act(async () => {
      ok = await hook.saveNow();
    });
    expect(ok).toBe(true);
    expect(updateMock).toHaveBeenCalledTimes(2);
    expect(status()).toBe("saved");
  });

  it("a 404 toasts that the plan no longer exists and goes to the list without being blocked", async () => {
    updateMock.mockRejectedValueOnce(new ApiError(["Release plan not found: 7."], 404));
    mount();
    edit("Gone");
    await advance(AUTOSAVE_DELAY_MS);
    expect(screen.getByRole("alert")).toHaveTextContent("This release plan no longer exists");
    expect(screen.getByTestId("location")).toHaveTextContent("/release-plan");
    expect(hook.hasUnsaved()).toBe(false);
  });

  it("aborts the request in flight and cancels the pending save on unmount", async () => {
    const pending = deferred();
    updateMock.mockReturnValueOnce(pending.promise);
    const first = mount();
    edit("In flight");
    await advance(AUTOSAVE_DELAY_MS);
    const signal = updateMock.mock.calls[0][2];
    first.unmount();
    expect(signal?.aborted).toBe(true);

  });

  it("does not send a pending autosave after unmount", async () => {
    const view = mount();
    edit("Pending");
    view.unmount();
    await advance(AUTOSAVE_DELAY_MS * 2);
    expect(updateMock).not.toHaveBeenCalled();
  });
});
