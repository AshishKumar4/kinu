// Failure pathologies: an id from two closed vocabularies, described from the id alone, named by a proposal's tag.
import { describe, expect, test } from 'bun:test';
import { describePathology, parsePathologyTag } from '../src/evolution/pathology';

describe('pathology identity is deterministic and model-free', () => {
  test('a well-formed id describes itself; anything else renders as itself rather than a fabricated sentence', () => {
    expect(describePathology('error/code')).toBe('the user reported an error or that it did not work after a code answer');
    expect(describePathology('repeat/prose')).toBe('the user had to re-state the same request after a long prose answer');

    for (const id of ['whatever', 'error/nope', 'made_up/code', 'error', 'error/code/extra']) expect(describePathology(id)).toBe(id);
  });
});

describe('the proposal tag', () => {
  test('a valid tag anywhere in the code is the named cell', () => {
    expect(parsePathologyTag('// pathology: error/code\nasync function* run() {}')).toBe('error/code');
    expect(parsePathologyTag('async function* run() {}\n//pathology:repeat/prose')).toBe('repeat/prose');
  });

  test('a missing, malformed, or invented tag names nothing', () => {
    expect(parsePathologyTag('async function* run() {}')).toBeNull();
    expect(parsePathologyTag('// pathology: made_up/thing')).toBeNull();
    expect(parsePathologyTag('// pathology:')).toBeNull();
    // A tag inside prose on the same line as code is not a tag line.
    expect(parsePathologyTag('const x = 1; // pathology: error/code and more')).toBeNull();
  });
});

