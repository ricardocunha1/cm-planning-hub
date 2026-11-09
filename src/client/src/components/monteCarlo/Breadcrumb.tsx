// Port of _breadcrumb.html.
const STEPS: [number, string][] = [
  [1, "Input"],
  [2, "Validation"],
  [3, "Execution & Results"],
];

export function Breadcrumb({ currentStep }: { currentStep: number }) {
  return (
    <nav aria-label="Progress">
      <ol className="flex items-center justify-center gap-2 text-sm">
        {STEPS.map(([stepNumber, stepLabel], index) => {
          const active = stepNumber === currentStep;
          return (
            <li key={stepNumber} className="flex items-center gap-2" aria-current={active ? "step" : undefined}>
              <div className="flex items-center gap-2">
                <span
                  className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
                    active ? "" : "bg-surface-raised text-fg-subtle"
                  }`}
                  style={active ? { backgroundColor: "var(--cm-light-blue)", color: "#04101d" } : undefined}
                >
                  {stepNumber}
                </span>
                <span className={active ? "font-semibold text-accent-blue" : "text-fg-subtle"}>{stepLabel}</span>
              </div>
              {index < STEPS.length - 1 && (
                <span className="w-10 border-t border-dashed border-fg-muted/70" />
                )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
