import type { ServerResponse } from "node:http";

type Cleanup = () => void;

interface LifecycleState {
  closed: boolean;
  activeCleanup?: Cleanup;
  closeListener: () => void;
  finishListener: () => void;
}

const lifecycles = new WeakMap<ServerResponse, LifecycleState>();

/**
 * Keep one downstream close/finish listener for all upstream retry attempts.
 * A retry replaces the active cleanup callback instead of adding another
 * listener to the same ServerResponse.
 */
export const registerResponseAttempt = (res: ServerResponse, cleanup: Cleanup): { readonly closed: boolean } => {
  const existing = lifecycles.get(res);
  if (existing) {
    if (!existing.closed) existing.activeCleanup = cleanup;
    else cleanup();
    return { get closed() { return existing.closed; } };
  }

  const state: LifecycleState = {
    closed: false,
    activeCleanup: cleanup,
    closeListener: () => {
      if (state.closed) return;
      state.closed = true;
      const activeCleanup = state.activeCleanup;
      state.activeCleanup = undefined;
      activeCleanup?.();
    },
    finishListener: () => {
      if (state.closed) return;
      state.closed = true;
      state.activeCleanup = undefined;
      res.removeListener("close", state.closeListener);
    },
  };
  lifecycles.set(res, state);
  res.once("close", state.closeListener);
  res.once("finish", state.finishListener);
  return { get closed() { return state.closed; } };
};
