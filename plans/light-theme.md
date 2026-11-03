# Light Theme

Add a light theme to the Planning Hub client alongside the existing look, which
becomes the dark theme. Client-only (`src/client`); no server or API changes.

## For Future Agents
As work proceeds: mark checkboxes `- [x]` as items complete; when a phase is done,
set its status to `Complete` and write its **Phase Summary** (what was done, key
decisions, anything needed to continue with zero context); run the phase's
**Verification Plan** and record the result before moving on. When all phases are
done, fill in **Final Recap** and **Deployment Plan**.

## Key decisions (agreed with the user, 2026-11-03)

- **Current look = dark theme.** It must look the same as before in dark mode.
- **Default theme:** first visit follows the OS (`prefers-color-scheme`); once the
  user toggles, the explicit choice is persisted in localStorage and wins.
- **Toggle:** sun/moon icon button in the global header, top-right, on every page.
  Accessible name reflects the action (e.g. "Switch to light theme").
- **Exports follow the active theme:** the Monte Carlo histogram (Plotly) and the
  Release Plan PNG export use light colors in light mode.
- **No flash of the wrong theme:** the theme is applied before React renders
  (inline script in `index.html` or equivalent).
- CM brand colors (`--cm-*`) stay the same in both themes; only neutral
  surfaces/text/borders (and the Release Plan board palette) change. Text on
  colored buttons, badges and chips must keep sufficient contrast in both themes.

## Phase 1: Develop (frontend-developer)
Status: Complete

- [x] Theme preference module (`src/lib/themePreference.ts`, modeled on
      `sidebarPreference.ts`): load/save with try/catch, OS fallback.
- [x] Theme state shared by the app (context/hook), applying the theme to
      `document.documentElement` (e.g. `data-theme` + `color-scheme`).
- [x] Pre-render theme script in `index.html`; `body` classes no longer hard-code dark.
- [x] Theme-aware neutral colors: replace hard-coded `slate-*`/`white`/`black`
      usage with theme-aware tokens (CSS variables in `index.css` exposed via
      `tailwind.config.js`), covering hub shell, Monte Carlo and Release Plan.
- [x] Release Plan board: light values for the variables in `releasePlan.css`.
- [x] `HistogramChart.tsx`: Plotly paper/plot/font colors from the active theme.
- [x] PNG export (`lib/releasePlan/png.ts`, `PALETTE` in `constants.ts`): a light
      palette, chosen from the active theme.
- [x] Header toggle button in `Layout.tsx`.
- [x] Unit tests: preference module, theme hook/context, toggle, histogram and
      PNG palette selection.

### Verification Plan
- `python3 -m compileall -q src/server/app` → no output
- `python3 -m pytest src/server -q` → 738 passed, 1 skipped (baseline, unchanged)
- `cd src/client && npm run build && npm test -- --run` → build OK, all tests pass
  (baseline: 76 files / 823 tests)
- `git diff --stat` → changes only in `src/client`, `plans/`, docs

### Phase Summary
Done by `frontend-developer` (2 rounds). Theme = `data-theme` + `color-scheme` on
`<html>`, applied pre-render by an inline script in `index.html` (storage and
matchMedia read in separate try/catch; key `cmPlanningHub.theme.v1` duplicated in
`lib/themePreference.ts`). `src/themeStore.ts` is a `useSyncExternalStore` store
(`useTheme()`), no provider; it follows live OS changes until an explicit choice.
Neutral colors are RGB-channel tokens (`--ui-*`: canvas, surface[-raised/-overlay/
-strong], line[-strong/-bold], fg[-soft/-muted/-subtle/-faint/-dim], accent-blue/
-teal, danger) in `index.css` + `tailwind.config.js`; dark values = old slate
values. Release Plan: `[data-theme="light"] .rp` overrides in `releasePlan.css`,
new `--sel-bg/--sel-ink`, `--drop-gold`, chips via `--chip-c` + `color-mix`; the
PNG uses `PALETTES[theme]` (mirrors the CSS). Monte Carlo: histogram uses
`CHART_COLORS[theme]`; confidence-level *text* uses `confidenceTextColor(level,
theme)` (darker shades in light), while borders/lines/calendar cells keep the brand
colors. Intentionally unchanged: brand-blue header and info toast, error toast,
brand buttons, modal backdrops, PNG header strip.
Verification: compileall OK; server 738 passed / 1 skipped; client build OK.

## Phase 2: QA (qa-engineer)
Status: Complete

- [x] Review against these key decisions, `specs/` and best practices.
- [x] Integration tests: theme persists across navigation/reload, OS fallback,
      no hard-coded dark classes left in shared shell components.
- [x] Report Blocker / Major / Minor findings; fix loop (≤3 cycles).

### Verification Plan
- Same commands as Phase 1, all passing.

### Phase Summary
Done by `qa-engineer` (2 rounds). Round 1 found 2 Majors (confidence-color text
unreadable on white; pre-render script picked dark when storage throws) plus
contrast Minors; all fixed in fix cycle 1, round 2 PASS. Integration tests:
`src/Theme.integration.test.tsx` (real App + router + real index.html script) and
`src/ThemeSources.integration.test.ts` (script vs module matrix, token/palette
sync, contrast checks), helper `src/test/readSource.ts`. Docker smoke OK.
Open Minors: `.addgap` "+" low contrast in light until hover; toasts stay dark;
no cross-tab `storage` sync; white on `--cm-light-blue` buttons ~3:1 (pre-existing).
Not verified in a real browser (paint, no-flash timing, `color-mix`, PNG look).
Verification: client 85 files / 915 tests pass.

## Final Recap
Light theme added to the client with a header toggle, OS-based default and
persisted choice; dark theme unchanged. Tests: 823 → 915 client tests.

## Deployment Plan
Client-only change; no config or Helm changes. Ship with the normal **Deploy**
workflow (both images rebuilt with the shared tag).
