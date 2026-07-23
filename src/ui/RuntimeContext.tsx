/**
 * Runtime context — makes the composition root available to the tree.
 */

import { createContext, useContext, type ReactNode } from 'react';
import type { Runtime } from '../app/runtime.js';

const RuntimeContext = createContext<Runtime | null>(null);

export function RuntimeProvider({ runtime, children }: { runtime: Runtime; children: ReactNode }): JSX.Element {
  return <RuntimeContext.Provider value={runtime}>{children}</RuntimeContext.Provider>;
}

export function useRuntime(): Runtime {
  const runtime = useContext(RuntimeContext);
  if (!runtime) throw new Error('useRuntime must be used within a RuntimeProvider');
  return runtime;
}
