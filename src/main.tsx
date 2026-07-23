/**
 * Entry point. Builds the runtime once, provides it plus the query client, and
 * mounts the app. Session-boundary telemetry flushes are wired here.
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from './App.js';
import { RuntimeProvider } from './ui/RuntimeContext.js';
import { createRuntime } from './app/runtime.js';
import './ui/styles.css';

const runtime = createRuntime({ seed: 1, count: 5000 });

// Rehydrate any writes queued in a previous session, and drain parked telemetry.
void runtime.writeQueue.hydrate().then(() => runtime.writeQueue.replay());
void runtime.telemetry.drainParked();

// Never lose telemetry on unload; flush on tab hide too (a session boundary).
window.addEventListener('pagehide', () => runtime.telemetry.flushOnUnload());
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') runtime.telemetry.flushOnBoundary();
});

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 5_000, retry: 1 } },
});

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('root element missing');

createRoot(rootEl).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RuntimeProvider runtime={runtime}>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </RuntimeProvider>
    </QueryClientProvider>
  </StrictMode>,
);
