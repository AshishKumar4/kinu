/**
 * Log calls that MUST compile.
 *
 * The half of the proof that a ban alone does not give: a type strict enough to
 * reject every secret and also the ordinary call is not a ban, it is an outage.
 * `unit-obs-log-ban.test.ts` asserts this file produces ZERO diagnostics, and it
 * is deliberately the awkward cases rather than one happy line — a fields object
 * held in an annotated variable was rejected by the first two designs of
 * `LoggableFields`, and nothing but this file would have caught it.
 */

import { ProteusError } from '../../../src/obs/error';
import { createRecordingLogger } from '../../../src/obs/log';

const log = createRecordingLogger();

// No fields at all.
log.event('run.escalated');

// Scalars, inline.
log.event('run.escalated', { runtime: 'sandbox', attempts: 2, reused: true });

// A fields object held in an annotated variable, which is what most call sites
// that build their fields conditionally end up with.
interface EscalationFields {
  readonly runtime: string;
  readonly attempts: number;
}
const fields: EscalationFields = { runtime: 'sandbox', attempts: 1 };
log.event('run.escalated', fields);

// A Record whose keys are CLOSED. Enumerable keys are the whole requirement; a
// Record is only rejected when its key type is `string` or `number`. `declare`
// because the TYPE is the subject here, not the value.
declare const closedKeys: Record<'runtime' | 'attempts', string>;
log.event('run.escalated', closedKeys);

// A union-typed value, which is what a classification field actually is.
type Outcome = 'ok' | 'failed' | 'refused';
const outcome: Outcome = 'refused';
log.event('run.escalated', { outcome, runtime: 'laptop' });

// A spread of a clean object, plus an extra field.
log.event('run.escalated', { ...fields, reused: false });

// A failure carries its classification, and fields are optional there too.
const failure = new ProteusError('unavailable', 'runtime_not_provisioned');
log.failure('run.escalation_refused', failure);
log.failure('run.escalation_refused', failure, { runtime: 'sandbox' });
