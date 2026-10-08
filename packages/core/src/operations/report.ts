/** A hire's report to whoever hired it: progress, completion or a blocker, with the handoff the hirer acts on. */
import * as v from 'valibot';
import { SUBORDINATE_REPORT_HANDOFF_MAX_CHARS, SUBORDINATE_REPORT_STATUSES, type SubordinateReportHandoffField } from '../events/hub/types';
import { JsonValueSchema } from '../utils/json';
import { defineOperation } from './operation';

const described = <S extends v.GenericSchema>(schema: S, text: string) => v.pipe(schema, v.description(text));

const handoffField = (purpose: string) => v.optional(described(v.array(v.pipe(v.string(), v.trim())),
  `${purpose} One short entry each; the four lists share ${SUBORDINATE_REPORT_HANDOFF_MAX_CHARS} characters.`));

const Body = {
  status: described(v.picklist(SUBORDINATE_REPORT_STATUSES), 'completed: the assignment is done. blocked: you need input. progress: a mid-task update.'),
  content: described(v.pipe(v.string(), v.trim(), v.nonEmpty()), 'The result, or what blocks you.'),
};

const HANDOFF = {
  concerns: handoffField('What you are unsure of, and the cost if you are wrong.'),
  deviations: handoffField('Where you departed from the brief, and what you did instead.'),
  findings: handoffField('Decisions and constraints that outlive this assignment.'),
  open_work: handoffField('Unfinished work and follow-ups.'),
} satisfies Record<SubordinateReportHandoffField, v.GenericSchema>;

const HELP = 'Report progress, completion or a blocker on your assignment. The answer your turn ends with reaches your hirer anyway; report milestones, not steps. A report wakes the hirer.';

export const REPORT = {
  send: defineOperation({
    ns: 'report', name: 'send', help: HELP, impact: 'externalSend', plan: true, slate: false,
    input: v.strictObject({ ...Body, ...HANDOFF }), output: v.nullable(JsonValueSchema),
  }),
  /** The same operation where the destination takes the body alone: a handoff sent anyway is dropped, as it always was. */
  sendBody: defineOperation({
    ns: 'report', name: 'send', help: HELP, impact: 'externalSend', plan: true, slate: false,
    input: v.object(Body), output: v.nullable(JsonValueSchema),
  }),
} as const;
