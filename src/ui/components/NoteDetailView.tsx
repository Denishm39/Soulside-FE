/**
 * Note detail — SOAP editor, autosave, status-driven actions, presence, and the
 * three-way merge on conflict.
 *
 * The editor is dirty-tracked per section. Edits feed the AutosaveEngine; its
 * state drives an inline "saved / saving / conflict" indicator so the user is
 * never unsure whether work is safe. A 409 opens the ConflictDialog with the
 * current draft (mine), the server head (theirs) and the common ancestor.
 * LOCKED notes render read-only with an Amend affordance.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useRuntime } from '../RuntimeContext.js';
import { useNote } from '../hooks.js';
import { ActionBar } from './ActionBar.js';
import { ConflictDialog } from './ConflictDialog.js';
import { VersionHistory } from './VersionHistory.js';
import { AutosaveEngine, type AutosaveState, type ConflictInfo, type SaveRequest } from '../../app/autosave.js';
import { isContentEditable, type UserActionType } from '../../domain/machine.js';
import { SOAP_SECTIONS, type NoteContent, type NoteSnapshot, type SoapSection } from '../../domain/types.js';
import type { Viewer } from '../../app/reconciler.js';

const SECTION_LABELS: Record<SoapSection, string> = {
  S: 'Subjective',
  O: 'Objective',
  A: 'Assessment',
  P: 'Plan',
};

export function NoteDetailView(): JSX.Element {
  const { id } = useParams<{ id: string }>();
  const runtime = useRuntime();
  const { data: note, isLoading, isError, error, refetch } = useNote(id);
  const actor = runtime.getActor();

  const [content, setContent] = useState<NoteContent | null>(null);
  const [autosave, setAutosave] = useState<AutosaveState | null>(null);
  const [conflict, setConflict] = useState<{ info: ConflictInfo; base: NoteContent; theirs: NoteContent } | null>(null);
  const [viewers, setViewers] = useState<Viewer[]>([]);
  const engineRef = useRef<AutosaveEngine | null>(null);

  // (Re)build the editor + autosave engine when the note changes.
  useEffect(() => {
    if (!note) return;
    const head = note.versions.find((v) => v.versionId === note.currentVersionId);
    setContent(head ? structuredClone(head.content) : { sections: { S: '', O: '', A: '', P: '' } });

    const engine = new AutosaveEngine({
      noteId: note.id,
      baseVersionId: note.currentVersionId,
      save: (req: SaveRequest) => runtime.api.saveVersion(req, actor),
    });
    engineRef.current = engine;
    const unsub = engine.subscribe(setAutosave);
    return () => {
      engine.dispose();
      unsub();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [note?.id, note?.currentVersionId]);

  // Real-time subscription for this note: presence, plus live status/version
  // pushes run through the reconciler and update the open note. Released on
  // unmount / note change (ref-counted), and presence emission is stopped.
  useEffect(() => {
    if (!id || !note) return;
    const { reconciler, subscriptions, backend } = runtime;

    reconciler.setLocalView(id, {
      actor,
      status: note.status,
      assignedReviewerId: note.assignedReviewerId,
      approvedAt: note.approvedAt,
      headVersionId: note.currentVersionId,
      editing: (engineRef.current?.getState().hasUnsavedChanges ?? false),
      saveInFlight: engineRef.current?.getState().status === 'saving',
    });

    const release = subscriptions.acquire(id);
    const off = backend.realtime.subscribe(id, (event) => {
      const effect = reconciler.ingest(event);
      switch (effect.kind) {
        case 'presence':
          setViewers(effect.viewers);
          break;
        case 'status':
        case 'version':
          void refetch(); // adopt the server's new state for the open note
          break;
        case 'supersede':
          void refetch(); // a version landed mid-edit; the merge is opened below
          break;
        default:
          break;
      }
    });
    const stopPresence = backend.simulatePresence(id);

    return () => {
      stopPresence();
      off();
      release();
      reconciler.removeLocalView(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, note?.id, runtime]);

  // Open the merge dialog when autosave reports a conflict.
  useEffect(() => {
    if (autosave?.status !== 'conflict' || !autosave.conflict || !note) return;
    void (async () => {
      const fresh = await refetch();
      const rec = fresh.data ?? note;
      const theirs = rec.versions.find((v) => v.versionId === autosave.conflict!.current.id)?.content;
      const base = autosave.conflict!.commonAncestor
        ? rec.versions.find((v) => v.versionId === autosave.conflict!.commonAncestor!.id)?.content
        : undefined;
      setConflict({
        info: autosave.conflict!,
        theirs: theirs ?? emptyContent(),
        base: base ?? emptyContent(),
      });
    })();
  }, [autosave?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  const snapshot: NoteSnapshot | null = useMemo(
    () =>
      note
        ? {
            id: note.id,
            status: note.status,
            assignedReviewerId: note.assignedReviewerId,
            currentVersionId: note.currentVersionId,
            approvedAt: note.approvedAt,
          }
        : null,
    [note],
  );

  if (isLoading) return <p className="state">Loading…</p>;
  if (isError) return <p className="state state--error" role="alert">Couldn’t load note: {error.message}</p>;
  if (!note || !snapshot || !content) return <p className="state">Not found.</p>;

  const editable = isContentEditable(snapshot, actor);
  const locked = note.status === 'LOCKED';

  const onSectionChange = (section: SoapSection, value: string): void => {
    const next: NoteContent = { sections: { ...content.sections, [section]: value } };
    setContent(next);
    engineRef.current?.change(next);
  };

  const onAction = async (type: UserActionType): Promise<void> => {
    let reason: string | undefined;
    if (type === 'reject') {
      reason = window.prompt('Reason for rejection?') ?? undefined;
      if (!reason) return;
    }
    const action = type === 'reject' ? { type, reason: reason as string } : { type };
    runtime.telemetry.track('note.action', { noteId: note.id, action: type, status: note.status });
    const result = await runtime.api.transition(note.id, action, actor);
    if (!result.ok) window.alert(result.reason ?? 'Action rejected by server');
    await refetch();
  };

  return (
    <article className="detail">
      <header className="detail-head">
        <h1>{note.patient.displayName}</h1>
        <span className={`status status--${note.status}`}>{note.status.replace(/_/g, ' ')}</span>
        <SaveIndicator state={autosave} />
        <Presence viewers={viewers} />
      </header>

      <ActionBar note={snapshot} actor={actor} now={Date.now()} onAction={(t) => void onAction(t)} />

      {locked && (
        <p className="locked-note" role="note">
          This note is locked after the 24-hour grace period. Start an amendment to make changes.
        </p>
      )}

      <div className="detail-body">
        <div className="soap">
          {SOAP_SECTIONS.map((s) => (
            <label key={s} className="soap-section">
              <span className="soap-label">{SECTION_LABELS[s]}</span>
              <textarea
                className="soap-input"
                value={content.sections[s]}
                readOnly={!editable}
                aria-readonly={!editable}
                onChange={(e) => onSectionChange(s, e.target.value)}
                rows={4}
              />
            </label>
          ))}
        </div>

        <VersionHistory versions={note.versions} currentVersionId={note.currentVersionId} />
      </div>

      {conflict && (
        <ConflictDialog
          base={conflict.base}
          mine={content}
          theirs={conflict.theirs}
          onResolve={(merged) => {
            engineRef.current?.resolveConflict(merged, conflict.info.current.id);
            setContent(merged);
            setConflict(null);
          }}
          onCancel={() => setConflict(null)}
        />
      )}
    </article>
  );
}

function SaveIndicator({ state }: { state: AutosaveState | null }): JSX.Element {
  const map: Record<string, string> = {
    idle: 'All changes saved',
    dirty: 'Editing…',
    saving: 'Saving…',
    retrying: 'Retrying…',
    conflict: 'Conflict — needs resolving',
    error: 'Save failed',
  };
  const status = state?.status ?? 'idle';
  return (
    <span className={`save-indicator save-indicator--${status}`} role="status" aria-live="polite">
      {map[status]}
    </span>
  );
}

function Presence({ viewers }: { viewers: Viewer[] }): JSX.Element | null {
  if (viewers.length === 0) return null;
  return (
    <span className="presence" aria-label={`${viewers.length} other viewers`}>
      {viewers.map((v) => (
        <span key={v.id} className="presence-dot" title={`${v.id} (${v.role})`} />
      ))}
    </span>
  );
}

function emptyContent(): NoteContent {
  return { sections: { S: '', O: '', A: '', P: '' } };
}

