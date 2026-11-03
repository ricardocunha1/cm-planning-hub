/** Longest plan name the server accepts. */
export const PLAN_NAME_MAX = 200;

export const PLAN_NAME_REQUIRED = "Plan name is required.";
export const PLAN_NAME_TOO_LONG = `Plan name must be at most ${PLAN_NAME_MAX} characters.`;

/** Inline error for a plan name (checked after trimming, with the server's wording), or `null` when valid. */
export function validatePlanName(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) {
    return PLAN_NAME_REQUIRED;
  }
  return trimmed.length > PLAN_NAME_MAX ? PLAN_NAME_TOO_LONG : null;
}
