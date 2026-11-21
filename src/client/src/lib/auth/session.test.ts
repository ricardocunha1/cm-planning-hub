import { describe, expect, it, vi } from "vitest";
import { notifyUnauthorized, onUnauthorized } from "./session";

describe("unauthorized notifier", () => {
  it("calls every subscriber until it unsubscribes", () => {
    const a = vi.fn();
    const b = vi.fn();
    const offA = onUnauthorized(a);
    const offB = onUnauthorized(b);
    notifyUnauthorized();
    offA();
    notifyUnauthorized();
    offB();
    notifyUnauthorized();
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(2);
  });
});
