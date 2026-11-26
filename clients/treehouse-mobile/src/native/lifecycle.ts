// Lifecycle (03, M1a.7): foreground starts the link and syncs; background stops it and closes the sockets.
// No background work is scheduled. The binder takes React Native's AppState (or a stand-in with the same
// shape, for Core tests) so this file imports nothing native itself.

/** The slice of React Native's AppState the binder uses (`AppState.currentState`, the "change" event). */
export interface AppStateLike {
  currentState: string | null | undefined;
  addEventListener(type: "change", listener: (state: string) => void): { remove(): void };
}

export interface LifecycleTarget {
  foreground(): Promise<unknown>;
  background(): Promise<unknown>;
}

/**
 * Bind app state changes to the target. `active` foregrounds and `background` backgrounds; `inactive` (iOS
 * transitions, the app switcher) does nothing. Transitions run one at a time in arrival order, so the link
 * never starts while a stop is still closing it, and a repeated state collapses into one transition. A failing
 * transition does not stop the next. The state at bind time counts as applied: the app session's open already
 * went online for an active launch. Returns the unbinder, with `reconcile()`: call it after a new session is
 * installed, so a session that opened (and went online) while the app was already in the background is
 * stopped, queued behind any transition still running.
 */
export type LifecycleBinding = (() => void) & { reconcile(): void };

export function bindLifecycle(appState: AppStateLike, target: LifecycleTarget): LifecycleBinding {
  let applied: "active" | "background" | null =
    appState.currentState === "active" ? "active" : appState.currentState === "background" ? "background" : null;
  let queue: Promise<void> = Promise.resolve();
  let bound = true;

  const run = (next: "active" | "background") => {
    queue = queue.then(async () => {
      if (!bound) return;
      try {
        await (next === "active" ? target.foreground() : target.background());
      } catch {
        // The session reports link failures in its read models; the next transition still runs.
      }
    });
  };

  const subscription = appState.addEventListener("change", (state) => {
    const next = state === "active" ? "active" : state === "background" ? "background" : null;
    if (!next || next === applied) return;
    applied = next;
    run(next);
  });

  const unbind = () => {
    bound = false;
    subscription.remove();
  };
  return Object.assign(unbind, {
    reconcile() {
      // Only background needs re-applying: an installed session's open already went online.
      if (applied === "background") run("background");
    },
  });
}
