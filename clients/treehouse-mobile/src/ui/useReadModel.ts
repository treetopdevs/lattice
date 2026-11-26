import { useMemo, useSyncExternalStore } from "react";
import type { DependencyList } from "react";
import type { ReadModels } from "../session/session";
import { readModelSource } from "./read_model_source";
import { useSession } from "./SessionProvider";

/**
 * One read model of the current session, or null before a session is open (M1a.7). `select` should return a
 * model object the session already built (e.g. `(m) => m.threads`), never a new one: the session does the
 * projection work when frames arrive, so rendering only picks. `deps` lists what `select` closes over (a
 * route param); the source is rebuilt only when the session or a dep changes.
 */
export function useReadModel<T>(select: (m: ReadModels) => T, deps: DependencyList = []): T | null {
  const { session } = useSession();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const source = useMemo(() => readModelSource(session, select), [session, ...deps]);
  return useSyncExternalStore(source.subscribe, source.getSnapshot);
}
