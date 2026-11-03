// Port of _field_help.html's info_icon macro.
export function InfoIcon({ text }: { text: string }) {
  return (
    <span className="relative inline-flex group align-middle">
      <svg className="h-4 w-4 text-fg-subtle cursor-help" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
        <path fillRule="evenodd" d="M18 10A8 8 0 11 2 10a8 8 0 0116 0zM11 6a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h.01a1 1 0 100-2V10a1 1 0 00-1-1H9z" clipRule="evenodd" />
      </svg>
      <span className="pointer-events-none absolute left-1/2 -translate-x-1/2 bottom-full mb-2 hidden group-hover:block w-56 rounded bg-surface-raised border border-line-strong px-2 py-1 text-xs font-normal text-fg-soft shadow-lg z-10">
        {text}
      </span>
    </span>
  );
}
