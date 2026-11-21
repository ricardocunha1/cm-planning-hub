import type { AuthUser } from "../lib/auth/types";

/** The signed-in user the test helpers (`renderAt`, `renderApp`) start with. */
export const TEST_USER: AuthUser = { id: 1, name: "Test User", email: "test.user@example.com", pictureUrl: null };
