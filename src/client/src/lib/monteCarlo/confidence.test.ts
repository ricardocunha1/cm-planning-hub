import { describe, expect, it } from "vitest";
import { CONFIDENCE_COLORS, CONFIDENCE_TEXT_COLORS, confidenceColor, confidenceTextColor } from "./confidence";

describe("confidence colors", () => {
  it("uses the brand colors for fills and borders, with a light-blue fallback", () => {
    expect(confidenceColor(50)).toBe("#60C5B5");
    expect(confidenceColor(99)).toBe("#4E98D1");
  });

  it("keeps the brand colors as dark-theme text", () => {
    expect(CONFIDENCE_TEXT_COLORS.dark).toBe(CONFIDENCE_COLORS);
    expect(confidenceTextColor(70, "dark")).toBe("#EBC160");
    expect(confidenceTextColor(99, "dark")).toBe("#4E98D1");
  });

  it("uses darker text shades in the light theme for every level", () => {
    expect(Object.keys(CONFIDENCE_TEXT_COLORS.light)).toEqual(Object.keys(CONFIDENCE_COLORS));
    expect(confidenceTextColor(50, "light")).toBe("#1D7A6B");
    expect(confidenceTextColor(70, "light")).toBe("#8A6514");
    expect(confidenceTextColor(85, "light")).toBe("#A4531F");
    expect(confidenceTextColor(95, "light")).toBe("#B64234");
    expect(confidenceTextColor(99, "light")).toBe("#1F68A0");
  });
});
