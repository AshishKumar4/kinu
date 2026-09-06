import assert from 'node:assert/strict';
import { parseSync } from 'oxc-parser';
import { REPO_PATH } from './platform-catalog';
import { isDocument, isParseable, readMatching, trackedFiles } from './sources';
import { sentences } from './prose';

/** Documents and parser-readable source carry authored claims. */
export const isClaimSource = (file: string): boolean => isDocument(file) || isParseable(file);

/** A code subject followed by an absolute, present-tense behaviour predicate. */
const BEHAVIOUR = /`[A-Za-z_$][^`]*`\s+(?:(?:always|never)\s+(?:[A-Za-z]+s|is|can|will)\b|guarantees?\s+[A-Za-z])/i;
const CONDITION = /\b(?:if|when|where|given|unless|except|because|since|so|as|without|until|measured|unmeasured|not measured)\b/i;
const LOCATOR = /`[\w./-]+\.(?:[cm]?[jt]sx?|md|py)(?::\d+(?:-\d+)?)?`|\{@link\s+[^}]+}|`[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*(?:\(\))?`/;
const RETIRED = /\b(?:removed|retired|deleted)\s+`[^`]+`\s+(?:always|never|guarantees?)\b/i;

/** Research moved off the public tree. Dependencies and Lean have separate ownership. */
export const isLocalPathClaim = (path: string): boolean =>
  !path.startsWith('node_modules/') && !path.startsWith('docs/research/') && !path.endsWith('.lean');

export interface ClaimFinding {
  readonly file: string;
  readonly line: number;
  readonly kind: 'missing-path' | 'unbounded-claim' | 'retired-behaviour';
  readonly detail: string;
}

interface ProseBlock {
  value: string;
  readonly start: number;
  end: number;
}

function commentBlocks(file: string, text: string): ProseBlock[] {
  const parsed = parseSync(file, text);
  if (parsed.errors.length > 0) throw new Error(`${file}: source cannot be parsed`);
  const blocks: ProseBlock[] = [];
  for (const comment of parsed.comments) {
    const prior = blocks.at(-1);
    const gap = prior === undefined ? '' : text.slice(prior.end, comment.start);
    const value = comment.value.replace(/^[ \t]*\*/gm, match => ' '.repeat(match.length));
    if (prior !== undefined && /^\s*$/.test(gap) && !gap.includes('\n\n')) {
      prior.value += gap + '  ' + value;
      prior.end = comment.end;
    } else {
      blocks.push({ value, start: comment.start + 2, end: comment.end });
    }
  }
  return blocks;
}

export function auditClaims(file: string, text: string, paths: ReadonlySet<string>) {
  const findings: ClaimFinding[] = [];
  let citations = 0;
  let excluded = 0;
  let claims = 0;
  const document = isDocument(file);
  const blocks = document ? [{ value: text, start: 0, end: text.length }] : commentBlocks(file, text);
  for (const block of blocks) {
    for (const match of (document ? [] : block.value.matchAll(REPO_PATH))) {
      const citation = match[0];
      if (!isLocalPathClaim(citation)) {
        excluded++;
        continue;
      }
      citations++;
      let matches = 0;
      if (!paths.has(citation)) {
        for (const path of paths) if (path.endsWith(`/${citation}`)) matches++;
      }
      if (!paths.has(citation) && matches !== 1) findings.push({
        file, line: text.slice(0, block.start + match.index).split('\n').length,
        kind: 'missing-path', detail: citation,
      });
    }
    for (const sentence of sentences(block.value)) {
      if (!BEHAVIOUR.test(sentence.text)) continue;
      claims++;
      if (RETIRED.test(sentence.text)) {
        findings.push({ file, line: text.slice(0, block.start + sentence.at).split('\n').length,
          kind: 'retired-behaviour', detail: sentence.text });
        continue;
      }
      if (CONDITION.test(sentence.text) || LOCATOR.test(sentence.text) || sentence.text.matchAll(REPO_PATH).next().done === false) continue;
      findings.push({ file, line: text.slice(0, block.start + sentence.at).split('\n').length,
        kind: 'unbounded-claim', detail: sentence.text });
    }
  }
  return { findings, citations, excluded, claims };
}

if (import.meta.main) {
  const governed = trackedFiles().filter(isClaimSource).sort();
  const corpus = readMatching(isClaimSource);
  assert.deepEqual([...corpus.keys()].sort(), governed);
  assert.ok(governed.length > 0, 'claim corpus is empty');
  const paths = new Set(trackedFiles());
  let citations = 0;
  let excluded = 0;
  let claims = 0;
  const findings: ClaimFinding[] = [];
  for (const [file, text] of corpus) {
    const result = auditClaims(file, text, paths);
    citations += result.citations;
    excluded += result.excluded;
    claims += result.claims;
    findings.push(...result.findings);
  }
  assert.ok(citations > 0 && claims > 0, 'claim directions must both have live subjects');
  for (const finding of findings) process.stderr.write(`${finding.file}:${finding.line}: ${finding.kind}: ${finding.detail}\n`);
  process.stdout.write(`doc-claims: ${governed.length} governed = ${corpus.size} measured files; ${citations} comment paths; ${claims} claim shapes; ${findings.length} findings. Blind spots: prose truth, relative paths, bare symbols, code strings, external references, path templates, historical and imperative prose. ${excluded} references excluded by isLocalPathClaim (machine-local research, dependencies, Lean). Claim shapes require a code subject and an absolute present-tense predicate; a condition or locator bounds the shape but does not prove it. Template declarations are author-trusted.\n`);
  if (findings.length > 0) process.exitCode = 1;
}
