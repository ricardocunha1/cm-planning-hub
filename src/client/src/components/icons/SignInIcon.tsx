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

/** A door with an arrow entering it: signing in to the hub. */
export function SignInIcon({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg className={className} {...svgProps}>
      <path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3" />
      <path d="M10 8l4 4-4 4" />
      <path d="M14 12H4" />
    </svg>
  );
}
