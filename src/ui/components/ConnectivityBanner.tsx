/**
 * Non-modal connectivity status. Always inline, never blocks the UI. Uses an
 * aria-live region so screen readers are told when the state changes, and
 * spells out queued-write depth so the user is never uncertain whether their
 * last edit was saved.
 */

import { useEffect, useState } from 'react';
import { useRuntime } from '../RuntimeContext.js';
import type { Connectivity } from '../../app/connectivity.js';

export function ConnectivityBanner(): JSX.Element | null {
  const { connectivity, writeQueue } = useRuntime();
  const [state, setState] = useState<Connectivity>(connectivity.get());
  const [depth, setDepth] = useState(writeQueue.depth);

  useEffect(() => connectivity.subscribe(setState), [connectivity]);
  useEffect(() => writeQueue.subscribe((s) => setDepth(s.depth)), [writeQueue]);

  if (state === 'online' && depth === 0) return null; // nothing to say when all is well

  const label =
    state === 'offline'
      ? `Offline — ${depth} edit${depth === 1 ? '' : 's'} queued, will sync when you reconnect`
      : state === 'unstable'
        ? 'Connection unstable — retrying'
        : depth > 0
          ? `Syncing ${depth} queued edit${depth === 1 ? '' : 's'}…`
          : 'Online';

  return (
    <div className={`connectivity connectivity--${state}`} role="status" aria-live="polite">
      {label}
    </div>
  );
}
