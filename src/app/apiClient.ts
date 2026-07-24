/**
 * API client — the seam between the UI and the transport.
 *
 * The UI depends on this interface, never on MockBackend directly, so the real
 * server could be dropped in by implementing the same surface. It also adapts
 * store/back-end shapes into the exact result types the autosave engine and
 * write queue expect (SaveOutcome, ReplayResult), keeping those modules unaware
 * of the wire format.
 */

import type { Action } from '../domain/machine.js';
import type { Actor, NoteContent } from '../domain/types.js';
import type { ListParams, ListResult, NoteRecord } from '../data/store.js';
import { MockBackend, ServerError } from '../data/backend.js';
import type { SaveOutcome, SaveRequest } from './autosave.js';
import type { QueuedWrite, ReplayResult } from './writeQueue.js';

export interface NotesApi {
  listNotes(params: ListParams): Promise<ListResult>;
  getNote(id: string): Promise<NoteRecord>;
  saveVersion(req: SaveRequest, author: Actor): Promise<SaveOutcome>;
  replayWrite(entry: QueuedWrite, author: Actor): Promise<ReplayResult>;
  transition(
    noteId: string,
    action: Action,
    actor: Actor,
  ): Promise<{ ok: true; eventId: string } | { ok: false; reason: string }>;
}

export class BackendApi implements NotesApi {
  constructor(private readonly backend: MockBackend) {}

  listNotes(params: ListParams): Promise<ListResult> {
    return this.backend.listNotes(params);
  }

  getNote(id: string): Promise<NoteRecord> {
    return this.backend.getNote(id);
  }

  async saveVersion(req: SaveRequest, author: Actor): Promise<SaveOutcome> {
    return this.toSaveOutcome(
      await this.backend.saveVersion(
        req.noteId,
        { baseVersionId: req.baseVersionId, content: req.content, clientMutationId: req.clientMutationId },
        author,
      ),
    );
  }

  async replayWrite(entry: QueuedWrite, author: Actor): Promise<ReplayResult> {
    try {
      const result = await this.backend.saveVersion(
        entry.noteId,
        { baseVersionId: entry.baseVersionId, content: entry.content, clientMutationId: entry.clientMutationId },
        author,
      );
      return this.toSaveOutcome(result) as ReplayResult;
    } catch (e) {
      return this.toError(e);
    }
  }

  async transition(
    noteId: string,
    action: Action,
    actor: Actor,
  ): Promise<{ ok: true; eventId: string } | { ok: false; reason: string }> {
    const result = await this.backend.postTransition(noteId, action, actor);
    // The server-assigned eventId is threaded through so the client can reconcile
    // its optimistic local ReviewEvent with the authoritative one on ack.
    return result.ok ? { ok: true, eventId: result.eventId } : { ok: false, reason: result.reason };
  }

  private toSaveOutcome(
    result: Awaited<ReturnType<MockBackend['saveVersion']>>,
  ): SaveOutcome {
    if (result.ok) {
      return { status: 'saved', version: { id: result.version.versionId, revision: result.version.revisionNumber } };
    }
    return {
      status: 'conflict',
      current: { id: result.current.versionId, revision: result.current.revisionNumber },
      commonAncestor: result.commonAncestor
        ? { id: result.commonAncestor.versionId, revision: result.commonAncestor.revisionNumber }
        : null,
    };
  }

  private toError(e: unknown): ReplayResult {
    if (e instanceof ServerError) {
      // 5xx is transient; 4xx (except 409, handled above) is not.
      return { status: 'error', retryable: e.status >= 500, message: e.message };
    }
    return { status: 'error', retryable: true, message: e instanceof Error ? e.message : 'network error' };
  }
}
