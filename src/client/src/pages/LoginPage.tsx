import { useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { SignInIcon } from "../components/icons/SignInIcon";
import { LOGIN_URL } from "../lib/auth/api";
import { HUB_NAME } from "../lib/tools";

/** Messages for the `?error=<code>` the server's OAuth callback redirects with. */
const ERROR_MESSAGES: Record<string, string> = {
  access_denied: "Sign-in was cancelled. Please try again.",
  domain_not_allowed: "Your account's email domain is not allowed to use this application.",
  email_not_verified: "Your Google account's email address is not verified.",
  state_mismatch: "The sign-in session expired or was invalid. Please try again.",
  invalid_claims: "Google did not return a valid identity for your account. Please try again.",
  login_failed: "Sign-in failed. Please try again or contact an administrator if it persists.",
};
const DEFAULT_ERROR = "Sign-in failed. Please try again.";

/** Public sign-in page (`/login`): welcome, what the hub is for, and the "Login with SSO" button . */
export function LoginPage() {
  const [params] = useSearchParams();
  const errorCode = params.get("error");

  useEffect(() => {
    document.title = `${HUB_NAME} – Login`;
  }, []);

  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-8">
      <div className="w-full max-w-md rounded-lg border border-line bg-surface p-8 text-center">
        <div className="mx-auto flex w-fit rounded-lg bg-white p-2 shadow-sm">
          <img src="/cmlogo-mark.png" alt="Critical Manufacturing" className="h-16 w-16" />
        </div>
        <h1 className="mt-5 text-2xl font-semibold text-fg">CM {HUB_NAME}</h1>
        <p className="mt-2 text-fg-muted">Estimate and plan your implementation projects</p>
        {errorCode !== null && (
          <p role="alert" className="mt-5 rounded border border-line bg-surface-raised px-3 py-2 text-sm text-fg">
            {ERROR_MESSAGES[errorCode] ?? DEFAULT_ERROR}
          </p>
        )}
        <button
          type="button"
          onClick={() => window.location.assign(LOGIN_URL)}
          className="mt-6 inline-flex items-center justify-center gap-3 rounded border border-line bg-surface-raised px-5 py-2.5 text-sm font-medium text-fg transition-colors hover:bg-surface-strong focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--cm-light-blue)]"
        >
          <SignInIcon className="h-5 w-5" />
          Login with SSO
        </button>
      </div>
    </main>
  );
}
