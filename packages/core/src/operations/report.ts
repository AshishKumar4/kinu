/** A hire's report to whoever hired it: progress, completion or a blocker, with the handoff the hirer acts on. */
import * as v from 'valibot';
import { SUBAGENT_REPORT_HANDOFF_MAX_CHARS, SUBAGENT_REPORT_STATUSES, type SubagentReportHandoffField } from '../events/hub/types';
import { JsonValueSchema } from '../utils/json';
import { defineOperation, described } from './operation';

const handoffField = (purpose: string) => v.optional(described(v.array(v.pipe(v.string(), v.trim())),
  `${purpose} One short entry each; the four lists share ${SUBAGENT_REPORT_HANDOFF_MAX_CHARS} characters.`));

const Body = {
  status: described(v.picklist(SUBAGENT_REPORT_STATUSES), 'completed: the assignment is done. blocked: you need input. progress: a mid-task update.'),
  content: described(v.pipe(v.string(), v.trim(), v.nonEmpty()), 'The result, or what blocks you.'),
};

const HANDOFF = {
  concerns: handoffField('What you are unsure of, and the cost if you are wrong.'),
  deviations: handoffField('Where you departed from the brief, and what you did instead.'),
  findings: handoffField('Decisions and constraints that outlive this assignment.'),
  open_work: handoffField('Unfinished work and follow-ups.'),
} satisfies Record<SubagentReportHandoffField, v.GenericSchema>;

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
