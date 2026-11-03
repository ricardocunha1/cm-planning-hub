import { describe, expect, it } from "vitest";
import { PLAN_NAME_MAX, PLAN_NAME_REQUIRED, PLAN_NAME_TOO_LONG, validatePlanName } from "./planName";

describe("validatePlanName", () => {
  it("rejects empty and blank names", () => {
    expect(validatePlanName("")).toBe(PLAN_NAME_REQUIRED);
    expect(validatePlanName("   ")).toBe(PLAN_NAME_REQUIRED);
  });

  it("accepts 1 to 200 characters after trimming", () => {
    expect(validatePlanName("a")).toBeNull();
    expect(validatePlanName(` ${"a".repeat(PLAN_NAME_MAX)} `)).toBeNull();
  });

  it("rejects more than 200 characters", () => {
    expect(validatePlanName("a".repeat(PLAN_NAME_MAX + 1))).toBe(PLAN_NAME_TOO_LONG);
  });
});
