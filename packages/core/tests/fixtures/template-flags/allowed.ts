/**
 * The ordinary conditional-template calls, which MUST compile.
 *
 * The half a ban usually skips, and the half that matters most here: a contract
 * strict enough to reject every misuse in `violations.ts` is easy to write and
 * easy to write TOO strictly. An intersection of a string map and a boolean map
 * has to keep accepting a slot object held in a variable, a flag computed from a
 * comparison, and a section whose contract is only flags or only slots.
 */

import { definePromptSection, templateContract } from '../../../src/prompting/template';

const verification = definePromptSection(
  'fixture/verification',
  '## Verification\n- always{{#if hasShell}}\n- {{shellNote}}{{/if}}',
);
const flagsOnly = definePromptSection('fixture/flags-only', 'a{{#if on}}b{{else}}c{{/if}}');
const slotsOnly = definePromptSection('fixture/slots-only', 'a {{value}}');
const noSlots = definePromptSection('fixture/none', 'plain prose');

const tools: readonly string[] = ['run'];

// Both slot kinds, inline.
verification.render({ hasShell: true, shellNote: 'run the check' });

// A flag computed from a real expression at the call site — where the unions
// are exhaustive, which is the whole argument for keeping logic in TypeScript.
verification.render({ hasShell: tools.includes('run'), shellNote: 'run the check' });

// The slot object held in a variable. An annotated-variable argument skips the
// excess-property check, so this is the case a `keyof`-based contract can break
// on; it must still compile.
const slots = { hasShell: false, shellNote: '' };
verification.render(slots);

// An empty string is a legal value; absent is what is banned.
verification.render({ hasShell: true, shellNote: '' });

// Contracts that are only flags, only slots, or neither.
flagsOnly.render({ on: true });
slotsOnly.render({ value: 'x' });
noSlots.render({});

// A promoted replacement, rendered against the same contract.
verification.renderFrom('## V{{#if hasShell}} {{shellNote}}{{/if}}', {
  hasShell: true, shellNote: 'x',
});

// The runtime contract reader takes any string — that is its whole point.
const promoted: string = '## V{{#if hasShell}}{{shellNote}}{{/if}}';
templateContract(verification.id, promoted);
