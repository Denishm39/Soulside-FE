/**
 * Version history sidebar with a diff between any two versions.
 *
 * Lists the note's versions newest-first and lets the reviewer pick any two to
 * compare. The diff is word-level per SOAP section, rendered with semantic
 * ins/del (see DiffView) so changes are conveyed to assistive tech, not by
 * colour alone. Defaults to comparing the head against its parent.
 */

import { useState } from 'react';
import { DiffView } from './DiffView.js';
import { SOAP_SECTIONS, type NoteVersion, type SoapSection } from '../../domain/types.js';

const SECTION_LABELS: Record<SoapSection, string> = {
  S: 'Subjective',
  O: 'Objective',
  A: 'Assessment',
  P: 'Plan',
};

export function VersionHistory({
  versions,
  currentVersionId,
}: {
  versions: NoteVersion[];
  currentVersionId: string;
}): JSX.Element {
  // Newest first for display.
  const ordered = [...versions].sort((a, b) => b.revisionNumber - a.revisionNumber);
  const head = ordered.find((v) => v.versionId === currentVersionId) ?? ordered[0];
  const parentId = head?.parentVersionId ?? ordered[1]?.versionId ?? head?.versionId ?? '';

  // Compare (from = older, to = newer). Default: head's parent -> head.
  const [fromId, setFromId] = useState<string>(parentId);
  const [toId, setToId] = useState<string>(head?.versionId ?? '');

  const byId = new Map(versions.map((v) => [v.versionId, v]));
  const from = byId.get(fromId);
  const to = byId.get(toId);

  return (
    <aside className="version-history" aria-label="Version history">
      <h2 className="vh-title">Version history</h2>

      <ol className="vh-list">
        {ordered.map((v) => (
          <li key={v.versionId} className={`vh-item ${v.versionId === currentVersionId ? 'is-head' : ''}`}>
            <span className="vh-rev">rev {v.revisionNumber}</span>
            <span className="vh-meta">
              {v.authorRole.toLowerCase()} · {new Date(v.createdAt).toLocaleString()}
            </span>
            {v.versionId === currentVersionId && <span className="badge badge--ok">head</span>}
          </li>
        ))}
      </ol>

      <div className="vh-compare">
        <label>
          <span className="sr-only">Compare from version</span>
          <select value={fromId} onChange={(e) => setFromId(e.target.value)} aria-label="Compare from version">
            {ordered.map((v) => (
              <option key={v.versionId} value={v.versionId}>
                rev {v.revisionNumber}
              </option>
            ))}
          </select>
        </label>
        <span aria-hidden="true">→</span>
        <label>
          <span className="sr-only">Compare to version</span>
          <select value={toId} onChange={(e) => setToId(e.target.value)} aria-label="Compare to version">
            {ordered.map((v) => (
              <option key={v.versionId} value={v.versionId}>
                rev {v.revisionNumber}
              </option>
            ))}
          </select>
        </label>
      </div>

      {from && to ? (
        from.versionId === to.versionId ? (
          <p className="vh-hint">Pick two different versions to see a diff.</p>
        ) : (
          <div className="vh-diff">
            {SOAP_SECTIONS.map((s) => (
              <section key={s}>
                <h3 className="vh-section-label">{SECTION_LABELS[s]}</h3>
                <DiffView before={from.content.sections[s]} after={to.content.sections[s]} />
              </section>
            ))}
          </div>
        )
      ) : (
        <p className="vh-hint">No versions to compare.</p>
      )}
    </aside>
  );
}
