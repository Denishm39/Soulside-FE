/**
 * Word-level diff rendering between two texts, using the pure diff engine.
 * Insertions and deletions are marked with semantic elements (<ins>/<del>) so
 * the change is conveyed to screen readers, not by colour alone.
 */

import { diffWords } from '../../domain/diff.js';

export function DiffView({ before, after }: { before: string; after: string }): JSX.Element {
  const spans = diffWords(before, after);
  return (
    <p className="diff">
      {spans.map((span, i) => {
        if (span.op === 'insert') return <ins key={i} className="diff-ins">{span.text}</ins>;
        if (span.op === 'delete') return <del key={i} className="diff-del">{span.text}</del>;
        return <span key={i}>{span.text}</span>;
      })}
    </p>
  );
}
