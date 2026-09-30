import { diffArrays } from 'diff';

// Half-open line ranges: old lines [oldStart, oldEnd) became new lines [newStart, newEnd).
export interface Hunk { oldStart: number; oldEnd: number; newStart: number; newEnd: number }

// Myers diff (jsdiff), grouped into hunks of adjacent changes.
// Gives up after 100ms (huge file, thousands of scattered edits) and reports the whole file as one change.
export function diffLines(a: string[], b: string[]): Hunk[] {
  const changes = diffArrays(a, b, { timeout: 100 });
  if (!changes) return [{ oldStart: 0, oldEnd: a.length, newStart: 0, newEnd: b.length }];
  const hunks: Hunk[] = [];
  let o = 0, n = 0, cur: Hunk | undefined;
  for (const c of changes) {
    if (!c.added && !c.removed) { o += c.count; n += c.count; cur = undefined; continue; }
    if (!cur) hunks.push(cur = { oldStart: o, oldEnd: o, newStart: n, newEnd: n });
    if (c.added) cur.newEnd = n += c.count;
    else cur.oldEnd = o += c.count;
  }
  return hunks;
}

// Apply hunk `h` from `to` onto `from`: lines [oldStart, oldEnd) of `from` become [newStart, newEnd) of `to`.
export function applyHunk(from: string[], to: string[], h: Hunk): string[] {
  const out = from.slice();
  out.splice(h.oldStart, h.oldEnd - h.oldStart, ...to.slice(h.newStart, h.newEnd));
  return out;
}
