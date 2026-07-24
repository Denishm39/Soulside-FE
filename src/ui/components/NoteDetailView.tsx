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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useRuntime } from '../RuntimeContext.js';
import { useNote } from '../hooks.js';
import { ActionBar } from './ActionBar.js';
import { ConflictDialog } from './ConflictDialog.js';
import { VersionHistory } from './VersionHistory.js';
import { AutosaveEngine, type AutosaveState, type ConflictInfo, type SaveRequest } from '../../app/autosave.js';
import { isContentEditable, transition as machineTransition, type Action, type UserActionType } from '../../domain/machine.js';
import { SOAP_SECTIONS, type NoteContent, type NoteSnapshot, type SoapSection } from '../../domain/types.js';
import type { NoteRecord } from '../../data/store.js';
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
  const queryClient = useQueryClient();
  const { data: note, isLoading, isError, error, refetch } = useNote(id);
  const actor = runtime.getActor();

  const [content, setContent] = useState<NoteContent | null>(null);
  const [autosave, setAutosave] = useState<AutosaveState | null>(null);
  const [conflict, setConflict] = useState<{ info: ConflictInfo; base: NoteContent; theirs: NoteContent } | null>(null);
  const [viewers, setViewers] = useState<Viewer[]>([]);
  const [actionError, setActionError] = useState<string | null>(null);
  const engineRef = useRef<AutosaveEngine | null>(null);

  // Open the three-way merge for a server version that superseded our base.
  // mine = current draft, theirs = the server version, base = our edit's base
  // (the last version we share). This is the SAME dialog as an autosave 409.
  const openMergeAgainst = useCallback(
    async (serverVersionId: string, ancestorVersionId?: string) => {
      const fresh = await refetch();
      const rec = fresh.data;
      const engine = engineRef.current;
      if (!rec || !engine) return;
      const baseId = ancestorVersionId ?? engine.getState().baseVersionId;
      const theirsVer = rec.versions.find((v) => v.versionId === serverVersionId);
      const baseVer = rec.versions.find((v) => v.versionId === baseId);
      setConflict({
        info: {
          current: { id: serverVersionId, revision: theirsVer?.revisionNumber ?? 0 },
          commonAncestor: { id: baseId, revision: baseVer?.revisionNumber ?? 0 },
        },
        theirs: theirsVer?.content ?? emptyContent(),
        base: baseVer?.content ?? emptyContent(),
      });
    },
    [refetch],
  );

  // A clean server version arrived while we were NOT editing: fast-forward the
  // editor to it without clobbering anything (there is nothing unsaved to lose).
  const fastForward = useCallback(
    async (versionId: string) => {
      const fresh = await refetch();
      const rec = fresh.data;
      const engine = engineRef.current;
      if (!rec || !engine) return;
      engine.adoptServerVersion(versionId);
      if (!engine.getState().hasUnsavedChanges) {
        const head = rec.versions.find((v) => v.versionId === versionId);
        if (head) setContent(structuredClone(head.content));
      }
    },
    [refetch],
  );

  // Build the editor + autosave engine ONCE per note id. Deliberately not keyed
  // on currentVersionId: a server version advancing the head must not rebuild
  // the engine and reset the editor — that was the edit-loss path. The engine's
  // base advances via saves (settleSave) and clean fast-forwards instead.
  useEffect(() => {
    if (!id) return;
    // Snapshot the initial head at mount from the query cache.
    const initial = note && note.id === id ? note : undefined;
    const head = initial?.versions.find((v) => v.versionId === initial.currentVersionId);
    setContent(head ? structuredClone(head.content) : emptyContent());

    const engine = new AutosaveEngine({
      noteId: id,
      baseVersionId: initial?.currentVersionId ?? '',
      ...(head ? { initialContent: structuredClone(head.content) } : {}),
      // Route through the coordinator: online → API, offline → durable queue.
      save: (req: SaveRequest) => runtime.saveCoordinator.save(req),
    });
    engineRef.current = engine;
    const unsub = engine.subscribe(setAutosave);
    return () => {
      engine.dispose();
      unsub();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // Keep the reconciler's view of this note continuously in sync with autosave
  // state, and tell it when a save lands so its own echo can't be misread as a
  // concurrent supersede. Any events deferred during the in-flight save are
  // flushed here and handled.
  const lastSettledRef = useRef<string | null>(null);
  useEffect(() => {
    if (!id || !note || !autosave) return;
    const { reconciler } = runtime;
    reconciler.setLocalView(id, {
      actor,
      status: note.status,
      assignedReviewerId: note.assignedReviewerId,
      approvedAt: note.approvedAt,
      headVersionId: autosave.baseVersionId || note.currentVersionId,
      editing: autosave.hasUnsavedChanges,
      saveInFlight: autosave.status === 'saving' || autosave.status === 'retrying',
    });

    if (autosave.lastSavedVersionId && autosave.lastSavedVersionId !== lastSettledRef.current) {
      lastSettledRef.current = autosave.lastSavedVersionId;
      const deferred = reconciler.settleSave(id, autosave.lastSavedVersionId);
      for (const e of deferred) {
        if (e.kind === 'supersede') void openMergeAgainst(e.serverVersionId);
      }
    }
  }, [id, note, autosave, actor, runtime, openMergeAgainst]);

  // Real-time subscription for this note: presence + live pushes through the
  // reconciler. Ref-counted; released with presence emission on unmount.
  useEffect(() => {
    if (!id) return;
    const { reconciler, subscriptions, backend } = runtime;
    const release = subscriptions.acquire(id);
    const off = backend.realtime.subscribe(id, (event) => {
      const effect = reconciler.ingest(event);
      switch (effect.kind) {
        case 'presence':
          setViewers(effect.viewers);
          break;
        case 'status':
          void refetch(); // content is preserved: the engine is keyed on id only
          break;
        case 'version':
          if (effect.mode === 'fast-forward') void fastForward(effect.versionId);
          break;
        case 'supersede':
          void openMergeAgainst(effect.serverVersionId); // same merge, draft intact
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
  }, [id, runtime, refetch, fastForward, openMergeAgainst]);

  // Open the merge dialog when autosave itself reports a 409 conflict.
  useEffect(() => {
    if (autosave?.status !== 'conflict' || !autosave.conflict) return;
    void openMergeAgainst(
      autosave.conflict.current.id,
      autosave.conflict.commonAncestor?.id,
    );
  }, [autosave?.status, autosave?.conflict, openMergeAgainst]);

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
    if (!id) return;
    let reason: string | undefined;
    if (type === 'reject') {
      reason = window.prompt('Reason for rejection?') ?? undefined;
      if (!reason) return;
    }
    const action: Action = type === 'reject' ? { type, reason: reason as string } : { type };
    const env = { now: Date.now() };
    const localEventId = `local_${env.now}_${Math.random().toString(36).slice(2)}`;

    // Validate against the machine and compute the optimistic next state up front.
    const optimistic = machineTransition(snapshot, action, actor, env, { eventId: localEventId });
    if (!optimistic.ok) {
      setActionError(optimistic.denial.reason);
      return;
    }

    const key = ['note', id];
    const previous = queryClient.getQueryData<NoteRecord>(key);

    // Apply optimistically: update status now and append a PENDING local
    // ReviewEvent, so the UI reflects the transition immediately.
    queryClient.setQueryData<NoteRecord>(key, (old) =>
      old
        ? {
            ...old,
            status: optimistic.note.status,
            assignedReviewerId: optimistic.note.assignedReviewerId,
            approvedAt: optimistic.note.approvedAt,
            events: [...old.events, optimistic.event],
          }
        : old,
    );
    setActionError(null);
    runtime.telemetry.track('note.action', { noteId: id, action: type, status: snapshot.status });

    const ack = await runtime.api.transition(id, action, actor);
    if (ack.ok) {
      // Reconcile: swap the provisional event id for the server's and clear the
      // pending flag; mark it seen so the matching real-time echo dedupes.
      runtime.reconciler.markSeen(ack.eventId);
      queryClient.setQueryData<NoteRecord>(key, (old) =>
        old
          ? {
              ...old,
              events: old.events.map((e) =>
                e.eventId === localEventId ? { ...e, eventId: ack.eventId, pending: false } : e,
              ),
            }
          : old,
      );
    } else {
      // Roll back cleanly to the pre-action snapshot and surface the reason.
      if (previous) queryClient.setQueryData(key, previous);
      setActionError(ack.reason);
    }
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

      {actionError && (
        <p className="action-error" role="alert">
          {actionError}
        </p>
      )}

      {locked && (
        <p className="locked-note" role="note">
          This note is locked after the 24-hour grace period. Start an amendment to make changes.
        </p>
      )}

      <div className="detail-body">
        <div className="soap">
          {SOAP_SECTIONS.map((s) => {
            const sectionDirty = autosave?.dirtySections[s] ?? false;
            return (
              <label key={s} className="soap-section">
                <span className="soap-label">
                  {SECTION_LABELS[s]}
                  {sectionDirty && (
                    <span className="soap-dirty" title="Unsaved changes in this section" aria-label="unsaved changes">
                      {' '}•
                    </span>
                  )}
                </span>
                <textarea
                  className="soap-input"
                  value={content.sections[s]}
                  readOnly={!editable}
                  aria-readonly={!editable}
                  onChange={(e) => onSectionChange(s, e.target.value)}
                  rows={4}
                />
              </label>
            );
          })}
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
    queued: 'Saved offline — will sync',
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

