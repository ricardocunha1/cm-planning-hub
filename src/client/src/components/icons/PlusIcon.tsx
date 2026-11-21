const svgProps = {
  xmlns: "http://www.w3.org/2000/svg",
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": true,
  focusable: false,
} as const;

/** A plus sign: adding an item. */
export function PlusIcon({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg className={className} {...svgProps}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}
