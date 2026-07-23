/**
 * App shell — routing, the workspace chrome, and the role switcher used to
 * demo how affordances change with (role, status, ownership).
 */

import { NavLink, Route, Routes } from 'react-router-dom';
import { useState } from 'react';
import { useRuntime } from './ui/RuntimeContext.js';
import { NotesListView } from './ui/components/NotesListView.js';
import { NoteDetailView } from './ui/components/NoteDetailView.js';
import { ConnectivityBanner } from './ui/components/ConnectivityBanner.js';
import { ROLES, type Role } from './domain/types.js';

export function App(): JSX.Element {
  const runtime = useRuntime();
  const [role, setRoleState] = useState<Role>(runtime.getActor().role);

  return (
    <div className="app">
      <a className="skip-link" href="#main">Skip to content</a>
      <header className="app-bar">
        <NavLink to="/" className="brand">
          Soulside <span>Clinical Notes</span>
        </NavLink>
        <label className="role-switch">
          <span className="sr-only">Acting role</span>
          Acting as{' '}
          <select
            value={role}
            onChange={(e) => {
              const next = e.target.value as Role;
              runtime.setRole(next);
              setRoleState(next);
            }}
          >
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </label>
      </header>

      <ConnectivityBanner />

      <main id="main" className="app-main">
        <Routes>
          <Route path="/" element={<NotesListView />} />
          <Route path="/notes/:id" element={<NoteDetailView />} />
          <Route path="*" element={<p className="state">Page not found.</p>} />
        </Routes>
      </main>
    </div>
  );
}
