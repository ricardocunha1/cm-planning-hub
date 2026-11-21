type Listener = () => void;

const listeners = new Set<Listener>();

/**
 * Subscribes to "the session is gone" events (a 401 on an `/api` call). Lets the
 * plain `request()` helper tell the React auth store without importing React.
 * @returns the unsubscribe function.
 */
export function onUnauthorized(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Notifies every subscriber that the server answered 401 (session missing or expired). */
export function notifyUnauthorized(): void {
  for (const listener of [...listeners]) {
    listener();
  }
}
