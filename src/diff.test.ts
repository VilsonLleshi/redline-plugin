import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { diffLines, applyHunk } from './diff';

const L = (s: string) => s.split('');

test('identical -> no hunks', () => assert.deepEqual(diffLines(L('abc'), L('abc')), []));

test('insert, delete, replace', () => {
  assert.deepEqual(diffLines(L('ac'), L('abc')), [{ oldStart: 1, oldEnd: 1, newStart: 1, newEnd: 2 }]);
  assert.deepEqual(diffLines(L('abc'), L('ac')), [{ oldStart: 1, oldEnd: 2, newStart: 1, newEnd: 1 }]);
  assert.deepEqual(diffLines(L('axc'), L('ayc')), [{ oldStart: 1, oldEnd: 2, newStart: 1, newEnd: 2 }]);
});

test('two separate hunks', () => {
  assert.equal(diffLines(L('abcdefg'), L('aXcdeYg')).length, 2);
});

test('applying every hunk (last first) turns old into new', () => {
  const a = L('the quick brown fox'), b = L('a quick red fox jumps');
  let out = a;
  for (const h of diffLines(a, b).reverse()) out = applyHunk(out, b, h);
  assert.deepEqual(out, b);
});

test('keeping one hunk leaves the others pending', () => {
  const a = L('abcdefg'), b = L('aXcdeYg');
  const [first] = diffLines(a, b);
  assert.deepEqual(diffLines(applyHunk(a, b, first), b), [{ oldStart: 5, oldEnd: 6, newStart: 5, newEnd: 6 }]);
});

test('huge scattered rewrite falls back to one whole-file hunk instead of hanging', () => {
  const a = Array.from({ length: 20000 }, (_, i) => `line ${i}`), b = a.map((l, i) => i % 10 ? l : `changed ${i}`);
  assert.deepEqual(diffLines(a, b), [{ oldStart: 0, oldEnd: 20000, newStart: 0, newEnd: 20000 }]);
});
