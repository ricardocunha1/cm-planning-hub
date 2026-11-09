import type { CSSProperties } from "react";
import type { Milestone } from "../../lib/releasePlan/types";

/** Inline style carrying the `--chip-c` custom property, which `CSSProperties` does not type. */
type ChipStyle = CSSProperties & { "--chip-c": string };

/**
 * Milestone name in its color (text via the `--chip-c` variable, darkened in the light theme for contrast;
 * border and `color + "2e"` background); a gold "Unplanned" chip when `milestone` is null.
 */
export function MilestoneChip({ milestone, label }: { milestone: Milestone | null; label?: string }) {
  if (!milestone) {
    return <span className="chip none">{label ?? "Unplanned"}</span>;
  }
  const style: ChipStyle = { background: `${milestone.color}2e`, borderColor: milestone.color, "--chip-c": milestone.color };
  return (
    <span className="chip" style={style}>
      {label ?? milestone.name}
    </span>
  );
}
