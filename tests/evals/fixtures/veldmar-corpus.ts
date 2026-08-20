/**
 * The controlled corpus behind the research eval: a FICTIONAL topic whose facts
 * exist nowhere but here, served to the agent over MCP and nowhere else.
 *
 * ONE module holds the planted values, the canary and the served text, and the
 * eval's expected answers are imported from it — the same no-drift rule the
 * hard-task corpus states (`test-utils/src/hard-tasks/index.ts`): a prompt or an
 * assertion quoting a number a second copy serves is a silently mis-stated eval.
 * The corpus-integrity test in `research.eval.ts` holds the two halves of THIS
 * module to each other: every planted value must appear in the served text, and
 * neither a planted value nor the canary may appear in the prompt — a prompt
 * that leaks the answers is an eval a model passes without reading anything.
 *
 * WHY THE TOPIC IS FICTIONAL. The eval's claim is "the agent read the controlled
 * source", and on a real topic a correct answer is equally consistent with model
 * memory. Veldmar Hollow does not exist, so its numbers cannot be remembered —
 * only read or fabricated, and exact-match scoring separates those two.
 *
 * WHY A CANARY AT ALL. The numbers prove extraction; the canary proves READING.
 * A model that guessed all three numbers (it cannot) would still have no path to
 * a random token that exists in one archive entry. Removing the canary from
 * `ENTRIES` is the designed red: the integrity test fails naming it without
 * spending anything, and a live run fails on the answer's `audit_token`.
 */

/** The facts the archive plants, spelled once. Field names match the JSON the
 *  agent is asked to return, so a mismatch names the field that fabricated. */
export const PLANTED = {
  households_relocated: 1847,
  deepest_sounding_m: 96.4,
  bell_tower_height_m: 27.3,
} as const;

/** The reading proof. Random-looking on purpose: no model completes this from
 *  priors, so its presence in an answer means the provenance entry was read. */
export const CANARY = 'KZR-4419-VOSSK';

export interface ArchiveEntry {
  readonly id: string;
  readonly title: string;
  readonly body: string;
}

/**
 * The served text. The facts are split across TWO entries and a third carries
 * only the canary, so one lucky read cannot answer everything — the agent has
 * to search, pick, and read more than once. The fourth entry is chaff: a search
 * that returns everything indiscriminately still forces the agent to tell the
 * survey from the mill dispute.
 */
export const ENTRIES: readonly ArchiveEntry[] = [
  {
    id: 'relocation-census',
    title: 'Relocation census, Veldmar Hollow clearance (1976-1977)',
    body: [
      'Prior to the closure of the Kerrensdal impoundment, the valley settlement of',
      'Veldmar Hollow was cleared in four phases between October 1976 and August 1977.',
      `The consolidated census of record lists ${String(PLANTED.households_relocated)} households relocated`,
      'across the four phases, the largest share to the terrace developments at',
      'Norrbeck. Livestock counts were kept separately by the drainage board and are',
      'not part of this census.',
    ].join('\n'),
  },
  {
    id: 'lakebed-survey',
    title: 'Lakebed survey of the flooded hollow (1978 soundings)',
    body: [
      'The first post-impoundment survey of the flooded hollow was taken by line',
      `sounding in spring 1978. The deepest sounding recorded was ${String(PLANTED.deepest_sounding_m)} metres,`,
      'directly over the old market square. The one structure left standing at',
      `flooding, the chapel bell tower, is ${String(PLANTED.bell_tower_height_m)} metres tall from its footing;`,
      'its cap remains the shallowest point over the settlement footprint.',
    ].join('\n'),
  },
  {
    id: 'archive-provenance',
    title: 'Provenance and citation note',
    body: [
      'This archive is the sole documentary source for the Veldmar Hollow clearance',
      'and the Kerrensdal impoundment soundings. Any report derived from this',
      `archive must quote the audit token ${CANARY} verbatim, so the archive can`,
      'trace which of its releases a figure was taken from.',
    ].join('\n'),
  },
  {
    id: 'grain-mill-dispute',
    title: 'Grain mill water-rights dispute (1911-1914)',
    body: [
      'Correspondence concerning the Veldmar Hollow grain mill and its weir rights,',
      'settled by arbitration in 1914. The mill ceased operation in 1921 and its',
      'stones were sold. Nothing in this file concerns the later impoundment.',
    ].join('\n'),
  },
];

/** The one task id this family declares. */
export const RESEARCH_TASK_ID = 'veldmar-hollow';

/**
 * What the agent is asked. It names the QUESTIONS and the reply shape and
 * nothing else — no figure and no token, which the integrity test enforces. The
 * structured reply is the scoring contract: `{status:...}` is parsed, never
 * scraped out of prose, and a reply that refuses the shape is itself a finding.
 */
export const RESEARCH_PROMPT = [
  'Research the flooding of Veldmar Hollow under the Kerrensdal impoundment using',
  'the veldmar archive tools available to you. The archive is the only source that',
  'documents this; do not answer from general knowledge.',
  '',
  'Find:',
  '  1. how many households were relocated in the clearance,',
  '  2. the deepest sounding in metres from the post-impoundment lakebed survey,',
  '  3. the height in metres of the bell tower left standing.',
  '',
  "The archive's provenance note names an audit token that must be quoted verbatim",
  'in any report; include it.',
  '',
  'Reply with ONLY a JSON object, no prose around it:',
  '  {"status": "OK", "households_relocated": <integer>, "deepest_sounding_m": <number>,',
  '   "bell_tower_height_m": <number>, "audit_token": "<string>"}',
  'or, if the archive does not answer a question:',
  '  {"status": "error", "reason": "<what is missing>"}',
].join('\n');
