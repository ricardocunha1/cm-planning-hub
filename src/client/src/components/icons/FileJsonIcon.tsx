const svgProps = {
  xmlns: "http://www.w3.org/2000/svg",
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.6,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": true,
  focusable: false,
} as const;

/** Document-with-braces icon (JSON file). */
export function FileJsonIcon({ className = "h-5 w-5" }: { className?: string }) {
  return (
    <svg className={className} {...svgProps}>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5" />
      <path d="M10 12c-1 0-1 .6-1 1.2v.6c0 .6-.4 1.2-1 1.2.6 0 1 .6 1 1.2v.6c0 .6 0 1.2 1 1.2" />
      <path d="M14 12c1 0 1 .6 1 1.2v.6c0 .6.4 1.2 1 1.2-.6 0-1 .6-1 1.2v.6c0 .6 0 1.2-1 1.2" />
    </svg>
  );
}
