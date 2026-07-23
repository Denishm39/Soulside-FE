/**
 * Three-way merge dialog — the single resolution surface reached from an
 * autosave 409, an offline-replay conflict, and a real-time supersede.
 *
 * Per SOAP section it shows mine / server / ancestor and lets the user choose a
 * side (or keep an auto-merged section). It is a focus-trapped modal with an
 * accessible label; Escape is intentionally NOT a dismiss, because losing the
 * dialog would risk losing the user's work — resolution is explicit.
 */

import { useEffect, useRef, useState } from 'react';
import { mergeContent, resolveSection, type ContentMerge, type Side } from '../../domain/merge.js';
import { SOAP_SECTIONS, type NoteContent, type SoapSection } from '../../domain/types.js';

const SECTION_LABELS: Record<SoapSection, string> = {
  S: 'Subjective',
  O: 'Objective',
  A: 'Assessment',
  P: 'Plan',
};

export function ConflictDialog({
  base,
  mine,
  theirs,
  onResolve,
  onCancel,
}: {
  base: NoteContent;
  mine: NoteContent;
  theirs: NoteContent;
  onResolve: (merged: NoteContent) => void;
  onCancel: () => void;
}): JSX.Element {
  const merge: ContentMerge = mergeContent(base, mine, theirs);
  const dialogRef = useRef<HTMLDivElement>(null);

  // Per-section side choice; defaults to "mine" for conflicted sections.
  const [choices, setChoices] = useState<Record<SoapSection, Side>>(() => {
    const init = {} as Record<SoapSection, Side>;
    for (const s of SOAP_SECTIONS) init[s] = 'mine';
    return init;
  });

  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  const build = (): NoteContent => {
    const sections = {} as Record<SoapSection, string>;
    for (const sm of merge.sections) {
      sections[sm.section] = sm.clean
        ? (sm.merged ?? mine.sections[sm.section])
        : resolveSection(
            sm,
            sm.chunks.filter((c) => c.type === 'conflict').map(() => choices[sm.section]),
          );
    }
    return { sections };
  };

  return (
    <div className="modal-backdrop" role="presentation">
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="conflict-title"
        ref={dialogRef}
        tabIndex={-1}
      >
        <h2 id="conflict-title">Resolve conflicting edits</h2>
        <p className="modal-sub">
          Someone else saved while you were editing. Choose which version to keep for each changed
          section. Nothing is discarded until you resolve.
        </p>

        {merge.sections.map((sm) => (
          <section key={sm.section} className="merge-section">
            <h3>
              {SECTION_LABELS[sm.section]}{' '}
              {sm.clean ? <span className="badge badge--ok">auto-merged</span> : <span className="badge badge--warn">conflict</span>}
            </h3>

            {sm.clean ? (
              <p className="merge-clean">{sm.merged}</p>
            ) : (
              <div className="merge-choices" role="radiogroup" aria-label={`${SECTION_LABELS[sm.section]} resolution`}>
                {(['mine', 'theirs', 'base'] as Side[]).map((side) => (
                  <label key={side} className={`merge-choice ${choices[sm.section] === side ? 'is-selected' : ''}`}>
                    <input
                      type="radio"
                      name={`choice-${sm.section}`}
                      checked={choices[sm.section] === side}
                      onChange={() => setChoices((c) => ({ ...c, [sm.section]: side }))}
                    />
                    <span className="merge-choice-label">
                      {side === 'mine' ? 'My version' : side === 'theirs' ? 'Their version' : 'Original'}
                    </span>
                    <span className="merge-choice-text">
                      {side === 'mine' ? mine.sections[sm.section] : side === 'theirs' ? theirs.sections[sm.section] : base.sections[sm.section]}
                    </span>
                  </label>
                ))}
              </div>
            )}
          </section>
        ))}

        <div className="modal-actions">
          <button type="button" className="btn-secondary" onClick={onCancel}>
            Keep editing
          </button>
          <button type="button" className="btn-primary" onClick={() => onResolve(build())}>
            Save resolved version
          </button>
        </div>
      </div>
    </div>
  );
}
