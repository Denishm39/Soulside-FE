/**
 * Status-driven action bar.
 *
 * Every button is derived from the state machine via availableActions — the
 * component contains no `if (status === ...)`. A disabled action shows *why*
 * (the machine's denial reason) as its title/aria-description, satisfying the
 * "disabled actions must show the reason" requirement structurally.
 */

import { availableActions, type UserActionType } from '../../domain/machine.js';
import type { Actor, NoteSnapshot } from '../../domain/types.js';

const LABELS: Record<UserActionType, string> = {
  start_review: 'Start review',
  return: 'Return',
  approve: 'Approve',
  reject: 'Reject',
  resubmit: 'Resubmit',
  amend: 'Amend',
  regenerate: 'Regenerate',
};

export function ActionBar({
  note,
  actor,
  now,
  onAction,
}: {
  note: NoteSnapshot;
  actor: Actor;
  now: number;
  onAction: (type: UserActionType) => void;
}): JSX.Element {
  const actions = availableActions(note, actor, { now });

  return (
    <div className="action-bar" role="toolbar" aria-label="Note actions">
      {actions.map(({ type, decision }) => {
        const disabled = !decision.allowed;
        const reason = decision.allowed ? undefined : decision.reason;
        return (
          <button
            key={type}
            type="button"
            className="action-btn"
            // Use aria-disabled (not the `disabled` attribute) so the control
            // stays keyboard-focusable and a screen-reader user can still reach
            // its explanatory label — the whole point of "show the reason".
            aria-disabled={disabled}
            title={reason}
            aria-label={reason ? `${LABELS[type]} — ${reason}` : LABELS[type]}
            onClick={() => {
              if (disabled) return; // guarded: a rogue click on a disabled action is a no-op
              onAction(type);
            }}
          >
            {LABELS[type]}
          </button>
        );
      })}
    </div>
  );
}
