/**
 * Failure pathologies: the cell a scaffold proposal names. A pathology id is its feature signature
 * `<complaint>/<responseMode>` over two closed vocabularies, so no model can rename a cell.
 */

import * as v from 'valibot';

const COMPLAINT_CLASSES = [
  'error', 'wrong_target', 'incomplete', 'no_action', 'overreach', 'repeat', 'other',
] as const;

type ComplaintClass = (typeof COMPLAINT_CLASSES)[number];

const RESPONSE_MODES = ['code', 'question', 'prose', 'terse'] as const;

type ResponseMode = (typeof RESPONSE_MODES)[number];

interface ParsedPathologyId {
  complaint: ComplaintClass;
  responseMode: ResponseMode;
}

const ComplaintClassSchema = v.picklist(COMPLAINT_CLASSES);

const ResponseModeSchema = v.picklist(RESPONSE_MODES);

function parsePathologyId(id: string): ParsedPathologyId | null {
  const [complaint, responseMode, ...rest] = id.split('/');

  if (rest.length !== 0) return null;
  const parsedComplaint = v.safeParse(ComplaintClassSchema, complaint);
  const parsedResponseMode = v.safeParse(ResponseModeSchema, responseMode);

  if (!parsedComplaint.success || !parsedResponseMode.success) return null;

  return {
    complaint: parsedComplaint.output,
    responseMode: parsedResponseMode.output,
  };
}

/** Both halves from the closed vocabularies; a cell with no current cluster is still valid. */
function isPathologyId(id: string): boolean {
  return parsePathologyId(id) !== null;
}

const COMPLAINT_PHRASE = {
  error: 'the user reported an error or that it did not work',
  wrong_target: 'the user said this was not what they asked for',
  incomplete: 'the user said the work was left unfinished',
  no_action: 'the user pointed out that nothing was actually done',
  overreach: 'the user said it did more than they asked for',
  repeat: 'the user had to re-state the same request',
  other: 'the user pushed back without a legible reason',
} satisfies Record<ComplaintClass, string>;

const MODE_PHRASE = {
  code: 'after a code answer',
  question: 'after a clarifying question',
  prose: 'after a long prose answer',
  terse: 'after a short answer',
} satisfies Record<ResponseMode, string>;

/** Derived from the id alone; an unrecognized id renders as itself. */
export function describePathology(id: string): string {
  const parsed = parsePathologyId(id);

  if (!parsed) return id;

  return `${COMPLAINT_PHRASE[parsed.complaint]} ${MODE_PHRASE[parsed.responseMode]}`;
}

/** One tag line in the returned code; a comment keeps the "return only JavaScript" contract. */
const PATHOLOGY_TAG = /^[^\S\n]*\/\/[^\S\n]*pathology:[^\S\n]*(\S+)[^\S\n]*$/m;

/** Null when none was named or it lies outside the closed vocabulary. */
export function parsePathologyTag(code: string): string | null {
  const tag = PATHOLOGY_TAG.exec(code)?.[1];

  return tag !== undefined && isPathologyId(tag) ? tag : null;
}
