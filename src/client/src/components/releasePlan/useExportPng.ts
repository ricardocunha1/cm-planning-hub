import { useCallback, useRef, useState } from "react";
import logoUrl from "../../assets/cmlogo.svg";
import { PALETTES } from "../../lib/releasePlan/constants";
import { downloadBlob, fileBase } from "../../lib/releasePlan/exportFile";
import { computeBoardLayout, type BoardOrientation } from "../../lib/releasePlan/layout";
import { drawBoardPng, PNG_HEAD, pngScale, type PngLogo } from "../../lib/releasePlan/png";
import type { ReleasePlan } from "../../lib/releasePlan/types";
import { useTheme } from "../../themeStore";
import { useToast } from "../Toast";

/** Error shown when the board exceeds the canvas limits even at scale 1. */
export const PNG_TOO_LARGE = "The board is too large to export as PNG.";
/** Error shown when the canvas has no 2D context or produced no blob. */
export const PNG_FAILED = "Could not export the PNG.";
/** How long the logo may take to load before the PNG is drawn without it. */
export const LOGO_TIMEOUT_MS = 3000;

/** Loads the CM logo; resolves `null` on error or after {@link LOGO_TIMEOUT_MS}. */
function loadLogo(): Promise<PngLogo | null> {
  return new Promise((resolve) => {
    const img = new Image();
    const timer = setTimeout(() => resolve(null), LOGO_TIMEOUT_MS);
    img.onload = () => {
      clearTimeout(timer);
      resolve({ image: img, width: img.naturalWidth, height: img.naturalHeight });
    };
    img.onerror = () => {
      clearTimeout(timer);
      resolve(null);
    };
    img.src = logoUrl;
  });
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
}

/**
 * Board "Export PNG": draws `plan` on a canvas with {@link drawBoardPng} and
 * downloads it as `<fileBase>.png`, then toasts "PNG exported". The CM logo is
 * optional (a load failure just leaves it out). A board too large for the
 * canvas limits, a missing 2D context, a `null` blob or a drawing error show an error toast and
 * download nothing. `exporting` is true while an export runs; further calls
 * are ignored meanwhile. `orientation` (default `standard`) picks the layout
 * drawn, so the image matches the board shown; the colors follow the active theme.
 */
export function useExportPng(plan: ReleasePlan, orientation: BoardOrientation = "standard"): { exporting: boolean; exportPng: () => Promise<void> } {
  const { showError, showInfo } = useToast();
  const { theme } = useTheme();
  const [exporting, setExporting] = useState(false);
  const running = useRef(false);

  const exportPng = useCallback(async () => {
    if (running.current) {
      return;
    }
    running.current = true;
    setExporting(true);
    try {
      const now = new Date();
      const layout = computeBoardLayout(plan, orientation);
      const scale = pngScale(layout.width, layout.height + PNG_HEAD);
      if (scale === null) {
        showError([PNG_TOO_LARGE]);
        return;
      }
      const logo = await loadLogo();
      const canvas = document.createElement("canvas");
      canvas.width = Math.floor(layout.width * scale);
      canvas.height = Math.floor((layout.height + PNG_HEAD) * scale);
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        showError([PNG_FAILED]);
        return;
      }
      drawBoardPng(ctx, plan, layout, { scale, now, logo, palette: PALETTES[theme] });
      const blob = await canvasToBlob(canvas);
      if (!blob) {
        showError([PNG_FAILED]);
        return;
      }
      downloadBlob(blob, `${fileBase(plan.name, now)}.png`);
      showInfo("PNG exported");
    } catch {
      showError([PNG_FAILED]);
    } finally {
      running.current = false;
      setExporting(false);
    }
  }, [plan, orientation, theme, showError, showInfo]);

  return { exporting, exportPng };
}
