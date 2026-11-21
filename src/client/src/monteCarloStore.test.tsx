import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { ForecastProvider, useForecast } from "./monteCarloStore";
import { adoSource, excelSource } from "./test/monteCarloFixtures";

describe("monteCarloStore", () => {
  it("starts without a data source and stores the one that is set", () => {
    const { result } = renderHook(() => useForecast(), { wrapper: ForecastProvider });
    expect(result.current.dataSource).toBeNull();

    const source = excelSource("history.xlsx");
    act(() => result.current.setDataSource(source));
    expect(result.current.dataSource).toBe(source);

    act(() => result.current.setDataSource(null));
    expect(result.current.dataSource).toBeNull();
  });

  it("starts from initialDataSource", () => {
    const wrapper = ({ children }: { children: ReactNode }) => (
      <ForecastProvider initialDataSource={adoSource}>{children}</ForecastProvider>
    );
    const { result } = renderHook(() => useForecast(), { wrapper });
    expect(result.current.dataSource).toEqual(adoSource);
  });

  it("throws outside a ForecastProvider", () => {
    vi.spyOn(console, "error").mockImplementation(() => {}); // React logs the render error
    const swallow = (event: ErrorEvent) => event.preventDefault(); // jsdom reports the render error on window
    window.addEventListener("error", swallow);
    expect(() => renderHook(() => useForecast())).toThrow("useForecast must be used within a ForecastProvider");
    window.removeEventListener("error", swallow);
    vi.restoreAllMocks();
  });
});
