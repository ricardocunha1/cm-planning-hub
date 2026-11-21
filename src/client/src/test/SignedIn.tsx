import type { ReactNode } from "react";
import { AuthProvider } from "../authStore";
import { ToastProvider } from "../components/Toast";
import type { AuthUser } from "../lib/auth/types";
import type { AdoCredential } from "../lib/settings/types";
import { SettingsProvider } from "../settingsStore";
import { TEST_USER } from "./authFixtures";

/** Toast + auth + settings providers for component tests that render outside `renderAt`: signed in as `user` (default `TEST_USER`; `null` = anonymous). */
export function SignedIn({
  user = TEST_USER,
  credentials,
  children,
}: {
  user?: AuthUser | null;
  /** Starts the settings store already loaded with these credentials (default: unfetched). */
  credentials?: AdoCredential[];
  children: ReactNode;
}) {
  return (
    <ToastProvider>
      <AuthProvider initialUser={user}>
        <SettingsProvider initialItems={credentials}>{children}</SettingsProvider>
      </AuthProvider>
    </ToastProvider>
  );
}
