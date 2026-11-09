// QA integration tests for the light/dark theme (plans/light-theme.md, Phase 2).
// The real App routes and pages, real themeStore/themePreference and jsdom localStorage. A "page load" runs the
// real pre-render script from index.html (as the browser does before React), then mounts the app; a "reload" is an
// unmount, the <html> attributes cleared, the script run again and a fresh mount. Only the boundaries jsdom lacks
// are stubbed: window.matchMedia (test/theme.ts), window.scrollTo, Plotly (records its layout) and the canvas.
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Layout as PlotlyLayout } from "plotly.js";
import { createMemoryRouter, Outlet, RouterProvider, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import indexHtml from "../index.html?raw";
import { appRoutes } from "./App";
import { CHART_COLORS } from "./components/monteCarlo/HistogramChart";
import { ToastProvider } from "./components/Toast";
import { CONFIDENCE_COLORS, CONFIDENCE_TEXT_COLORS } from "./lib/monteCarlo/confidence";
import { PALETTES } from "./lib/releasePlan/constants";
import { THEME_KEY } from "./lib/themePreference";
import { ForecastProvider } from "./monteCarloStore";
import { FakeImage, RecordingContext, stubCanvas } from "./test/canvas";
import { result } from "./test/monteCarloFixtures";
import { BOARD_TEST_TIMEOUT_MS } from "./test/renderBoard";
import { renderAt } from "./test/render";
import { resetTheme, stubMatchMedia } from "./test/theme";
import { ResultsPage } from "./pages/monteCarlo/ResultsPage";

const plotLayouts: Partial<PlotlyLayout>[] = [];

vi.mock("plotly.js-basic-dist-min", () => ({ default: {} }));
vi.mock("react-plotly.js/factory", () => ({
  default: () =>
    function PlotStub({ layout }: { layout: Partial<PlotlyLayout> }) {
      plotLayouts.push(layout);
      return <div data-testid="plot" />;
    },
}));

vi.mock("./lib/releasePlan/planApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./lib/releasePlan/planApi")>();
  const { samplePlan } = await import("./test/releasePlanFixtures");
  return {
    ...actual,
    getPlan: vi.fn(async (id: number) => ({
      id,
      name: "Sample",
      projectType: "onprem",
      projectName: "Project",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      state: samplePlan(),
    })),
  };
});

const FLOW_TIMEOUT_MS = 20_000;

/** The inline (non-module) script of index.html, i.e. the pre-render theme script. */
function preRenderScript(): string {
  const scripts = [...indexHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  if (scripts.length !== 1) {
    throw new Error(`expected exactly one inline script in index.html, found ${scripts.length}`);
  }
  return scripts[0];
}

/** What the browser does before React: runs the index.html script on a fresh <html>. */
function pageLoad(): void {
  delete document.documentElement.dataset.theme;
  document.documentElement.style.colorScheme = "";
  new Function(preRenderScript())();
}

function LocationProbe() {
  return <div data-testid="location">{useLocation().pathname}</div>;
}

function renderApp(path = "/") {
  pageLoad();
  // The real route table (a data router), with the location probe added around its layout.
  const router = createMemoryRouter(
    [
      {
        element: (
          <>
            <Outlet />
            <LocationProbe />
          </>
        ),
        children: appRoutes,
      },
    ],
    { initialEntries: [path] },
  );
  return render(
    <ToastProvider>
      <ForecastProvider>
        <RouterProvider router={router} />
      </ForecastProvider>
    </ToastProvider>,
  );
}

const html = () => document.documentElement;
const location = () => screen.getByTestId("location").textContent;
const header = () => screen.getByRole("banner");
const toLight = () => within(header()).getByRole("button", { name: "Switch to light theme" });
const toDark = () => within(header()).getByRole("button", { name: "Switch to dark theme" });
const nav = () => screen.getByRole("navigation", { name: "Hub navigation" });

function expectTheme(theme: "light" | "dark") {
  expect(html().dataset.theme).toBe(theme);
  expect(html().style.colorScheme).toBe(theme);
  // The toggle names the action, i.e. the other theme.
  expect(within(header()).getByRole("button", { name: theme === "dark" ? "Switch to light theme" : "Switch to dark theme" })).toBeInTheDocument();
}

beforeEach(() => {
  resetTheme();
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetTheme();
});

describe("Theme – full app", () => {
  it(
    "the header toggle is on every page; the choice persists across navigation and a reload",
    async () => {
      stubMatchMedia(false);
      const user = userEvent.setup();
      const first = renderApp("/");
      expectTheme("dark");
      expect(window.localStorage.getItem(THEME_KEY)).toBeNull();

      await user.click(toLight());
      expectTheme("light");
      expect(window.localStorage.getItem(THEME_KEY)).toBe("light");

      // Each page mounts its own Layout: the toggle is there and reflects the light theme.
      await user.click(within(nav()).getByRole("link", { name: "Monte Carlo" }));
      expect(location()).toBe("/monte-carlo");
      expectTheme("light");
      await user.click(within(nav()).getByRole("link", { name: "Release Plan" }));
      expect(location()).toBe("/release-plan");
      expectTheme("light");

      // Toggle back from another page, then reload: dark is restored from storage.
      await user.click(toDark());
      expectTheme("dark");
      expect(window.localStorage.getItem(THEME_KEY)).toBe("dark");
      first.unmount();

      renderApp("/release-plan");
      expectTheme("dark");
    },
    FLOW_TIMEOUT_MS,
  );

  it("first visit follows the OS light preference without storing a choice", () => {
    stubMatchMedia(true);
    renderApp("/");
    expectTheme("light");
    expect(window.localStorage.getItem(THEME_KEY)).toBeNull();
  });

  it("first visit without matchMedia support falls back to dark", () => {
    renderApp("/");
    expectTheme("dark");
  });

  it("a stored explicit choice beats the OS preference on load (both directions)", () => {
    stubMatchMedia(true);
    window.localStorage.setItem(THEME_KEY, "dark");
    const first = renderApp("/");
    expectTheme("dark");
    first.unmount();

    stubMatchMedia(false);
    window.localStorage.setItem(THEME_KEY, "light");
    renderApp("/monte-carlo");
    expectTheme("light");
  });

  it("an invalid stored value is ignored in favour of the OS preference", () => {
    stubMatchMedia(true);
    window.localStorage.setItem(THEME_KEY, "sepia");
    renderApp("/");
    expectTheme("light");
  });

  it("follows a live OS change only until the user toggles", async () => {
    const os = stubMatchMedia(false);
    const user = userEvent.setup();
    renderApp("/");
    expectTheme("dark");

    act(() => os.setPrefersLight(true));
    expectTheme("light");
    act(() => os.setPrefersLight(false));
    expectTheme("dark");

    await user.click(toLight());
    act(() => os.setPrefersLight(false));
    expectTheme("light");
    act(() => os.setPrefersLight(true));
    act(() => os.setPrefersLight(false));
    expectTheme("light");
  });

  it("the toggle is keyboard operable and has a tooltip matching its accessible name", async () => {
    stubMatchMedia(false);
    const user = userEvent.setup();
    renderApp("/");
    const button = toLight();
    expect(button).toHaveAttribute("type", "button");
    expect(button).toHaveAttribute("title", "Switch to light theme");
    button.focus();
    await user.keyboard("{Enter}");
    expectTheme("light");
    expect(toDark()).toHaveFocus();
    await user.keyboard(" ");
    expectTheme("dark");
  });

  it("the shell uses theme tokens, not hard-coded dark neutrals, on every top-level page", async () => {
    stubMatchMedia(false);
    const user = userEvent.setup();
    renderApp("/");
    const hardCodedDark = /\b(bg|text|border)-(slate|gray|zinc|neutral)-(700|800|900|950)\b/;
    const check = () => {
      const offenders = [...document.body.querySelectorAll<HTMLElement>("main *, aside, aside *")]
        .map((el) => el.getAttribute("class") ?? "")
        .filter((c) => hardCodedDark.test(c) && !/\btext-slate-950\b/.test(c));
      expect(offenders).toEqual([]);
    };
    check();
    await user.click(within(nav()).getByRole("link", { name: "Monte Carlo" }));
    check();
    await user.click(within(nav()).getByRole("link", { name: "Release Plan" }));
    check();
  });
});

describe("Theme – Monte Carlo results", () => {
  beforeEach(() => {
    plotLayouts.length = 0;
  });

  it("the histogram follows the theme loaded on start and re-colors when the header toggle is used", async () => {
    stubMatchMedia(false);
    window.localStorage.setItem(THEME_KEY, "light");
    pageLoad();
    const user = userEvent.setup();
    renderAt("/monte-carlo/results", <ResultsPage />, { execution: { result, sprintStartDate: "2026-01-05" } });

    await screen.findByTestId("plot");
    expect(plotLayouts.at(-1)).toMatchObject({
      paper_bgcolor: CHART_COLORS.light.background,
      plot_bgcolor: CHART_COLORS.light.background,
      font: { color: CHART_COLORS.light.font },
    });

    await user.click(toDark());
    expect(plotLayouts.at(-1)).toMatchObject({
      paper_bgcolor: CHART_COLORS.dark.background,
      plot_bgcolor: CHART_COLORS.dark.background,
      font: { color: CHART_COLORS.dark.font },
    });
    // Dark is the original look.
    expect(CHART_COLORS.dark).toEqual({ background: "#0f172a", font: "#e2e8f0" });
  });
});

describe("Theme – Monte Carlo result colors", () => {
  beforeEach(() => {
    plotLayouts.length = 0;
  });

  /** jsdom normalises inline colors to rgb(r, g, b). */
  const rgb = (hex: string) => {
    const n = parseInt(hex.slice(1), 16);
    return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
  };
  const levels = result.rows.map((r) => r.confidence);

  function expectResultColors(theme: "light" | "dark") {
    for (const level of levels) {
      const card = screen.getByTestId(`card-p${level}`);
      const [label, count] = card.querySelectorAll("p");
      // Text uses the readable per-theme color; the top border keeps the brand color in both themes.
      expect({ level, label: label.style.color, count: count.style.color }).toEqual({
        level,
        label: rgb(CONFIDENCE_TEXT_COLORS[theme][level]),
        count: rgb(CONFIDENCE_TEXT_COLORS[theme][level]),
      });
      expect(card.style.borderTop).toContain(rgb(CONFIDENCE_COLORS[level]));
    }
    const layout = plotLayouts.at(-1)!;
    const annotations = (layout.annotations ?? []) as Array<{ text: string; font: { color: string } }>;
    const shapes = (layout.shapes ?? []) as Array<{ line: { color: string } }>;
    expect(annotations.map((a) => [a.text, a.font.color])).toEqual(levels.map((l) => [`P${l}`, CONFIDENCE_TEXT_COLORS[theme][l]]));
    expect(shapes.map((sh) => sh.line.color)).toEqual(levels.map((l) => CONFIDENCE_COLORS[l]));
  }

  it("cards and chart labels use readable light colors, switch back to the brand colors in dark, and calendar cells stay brand", async () => {
    stubMatchMedia(true);
    pageLoad();
    const user = userEvent.setup();
    renderAt("/monte-carlo/results", <ResultsPage />, { execution: { result, sprintStartDate: "2026-01-05" } });
    await screen.findByTestId("plot");
    expectTheme("light");
    expectResultColors("light");
    const calendarFills = () =>
      new Set(
        [...document.querySelectorAll<HTMLElement>("span.text-slate-950")].map((el) => el.style.backgroundColor),
      );
    const lightFills = calendarFills();
    expect(lightFills.size).toBeGreaterThan(0);
    for (const fill of lightFills) {
      expect(Object.values(CONFIDENCE_COLORS).map(rgb)).toContain(fill);
    }

    await user.click(toDark());
    expectTheme("dark");
    expectResultColors("dark");
    expect(calendarFills()).toEqual(lightFills);
  });
});

describe("Theme – Release Plan PNG export", { timeout: BOARD_TEST_TIMEOUT_MS }, () => {
  const original = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };

  beforeEach(() => {
    vi.stubGlobal("Image", FakeImage);
    FakeImage.reset();
    Object.assign(URL, { createObjectURL: () => "blob:png", revokeObjectURL: () => undefined });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  });

  afterEach(() => {
    FakeImage.reset();
    Object.assign(URL, { createObjectURL: original.create, revokeObjectURL: original.revoke });
  });

  /** fillStyle of the first fillRect (the full-image background) and of the board-name text. */
  function backgroundAndInk(ctx: RecordingContext) {
    const background = ctx.ops("fillRect")[0]?.fillStyle;
    const bandName = ctx.calls.find((c) => c.op === "fillText" && c.args[0] === "MVP")?.fillStyle;
    return { background, bandName };
  }

  it(
    "exports with the active theme's palette, switching after the header toggle (board through the real app)",
    async () => {
      stubMatchMedia(true); // first visit, OS light
      const user = userEvent.setup();
      renderApp("/release-plan/1");
      expectTheme("light");
      await screen.findByRole("button", { name: "Export PNG" }); // the board loads from the (mocked) server

      const lightCtx = new RecordingContext();
      stubCanvas({ context: lightCtx, blob: new Blob(["png"], { type: "image/png" }) });
      await user.click(screen.getByRole("button", { name: "Export PNG" }));
      expect(await screen.findByText("PNG exported")).toBeInTheDocument();
      expect(backgroundAndInk(lightCtx)).toEqual({ background: PALETTES.light.panel, bandName: PALETTES.light.ink });
      // The header strip stays brand blue.
      expect(lightCtx.ops("fillRect")[1]?.fillStyle).toBe(PALETTES.light.navy);

      await user.click(toDark());
      const darkCtx = new RecordingContext();
      stubCanvas({ context: darkCtx, blob: new Blob(["png"], { type: "image/png" }) });
      await user.click(screen.getByRole("button", { name: "Export PNG" }));
      await vi.waitFor(() => expect(darkCtx.ops("fillRect").length).toBeGreaterThan(0));
      await vi.waitFor(() => expect(backgroundAndInk(darkCtx).bandName).toBeDefined());
      expect(backgroundAndInk(darkCtx)).toEqual({ background: PALETTES.dark.panel, bandName: PALETTES.dark.ink });
    },
    FLOW_TIMEOUT_MS,
  );
});
