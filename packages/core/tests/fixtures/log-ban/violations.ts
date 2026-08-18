/**
 * Log calls that MUST NOT compile. Every line here is a real evasion route, and
 * the file is deliberately broken: it is EXCLUDED from
 * `packages/core/tsconfig.json` and typechecked only by
 * `unit-obs-log-ban.test.ts`, which runs the same `tsc` the gate runs and reads a
 * diagnostic off each marked line.
 *
 * Written without a single `@ts-expect-error`. That directive proves an error
 * exists somewhere on the next line; it does not prove WHICH, so a fixture built
 * from it would keep passing if the ban broke and a typo took its place. The test
 * asserts the diagnostic names the uninhabited marker type.
 *
 * SHAPE MATTERS: a `// [n]` marker must be followed by comment lines and then the
 * offending CALL — nothing else. The test resolves each case to the first
 * non-comment line after its marker, so declarations belong above, here.
 *
 * Do not "fix" anything below the declarations.
 */

import { createRecordingLogger, type LogFieldValue } from '../../../src/obs/log.js';

const log = createRecordingLogger();

interface Credentials {
  readonly apiKey: string;
  readonly provider: string;
}
const credentials: Credentials = { apiKey: 'sk-live-1', provider: 'workers-ai' };
// `declare` rather than an initialiser: the TYPE is the fixture's subject, and
// annotating a literal with an open dictionary is itself a lint finding.
declare const openStrings: Record<string, string>;
declare const openValues: Record<string, LogFieldValue>;
declare const numericKeys: Record<number, string>;

// [1] A reserved field in a literal. The obvious case, and the only one an
//     excess-property check would have caught.
log.event('agent.booted', { soul: 'the whole system prompt' });

// [2] A reserved field reached through an annotated variable. Excess-property
//     checking does not fire here, which is why the ban reads `keyof`.
log.event('provider.selected', credentials);

// [3] A reserved field arriving by spread.
log.event('provider.selected', { ...credentials, attempt: 1 });

// [4] An OPEN field map. `Extract<string, ReservedLogField>` is `never`, so every
//     name-based ban passes this and only rejecting the index signature stops it.
log.event('provider.selected', openStrings);

// [5] The same hole with a scalar value type, which looks compliant.
log.event('provider.selected', openValues);

// [6] The numeric spelling of the same hole.
log.event('provider.selected', numericKeys);

// [7] An object nobody looked inside. There is no depth for a secret to hide at
//     because there is no depth.
log.event('turn.started', { request: { systemPrompt: 'you are...' } });

// [8] No dotted event name, so nothing can key a query on it.
log.event('booted', { runtime: 'workspace' });

// [9] A failure log with no classification. `failure` requires the error, so the
//     string-return defect cannot come back one layer up.
log.failure('run.escalation_failed', { runtime: 'sandbox' });
