/** Ordinary conditional-template calls that must compile, so the contract is not too strict. */

import { definePromptSection, templateContract } from '../../../src/prompting/template';

const verification = definePromptSection(
  'fixture/verification',
  '{{shellNote}}{{#if hasShell}}{{/if}}',
  '## Verification\n- always{{#if hasShell}}\n- {{shellNote}}{{/if}}',
);

const flagsOnly = definePromptSection('fixture/flags-only', 'a{{#if on}}b{{else}}c{{/if}}');

const slotsOnly = definePromptSection('fixture/slots-only', 'a {{value}}');

const noSlots = definePromptSection('fixture/none', 'plain prose');

const tools: readonly string[] = ['shell'];

// Both slot kinds, inline.
verification.render({ hasShell: true, shellNote: 'run the check' });

// A flag computed from an expression.
verification.render({ hasShell: tools.includes('shell'), shellNote: 'run the check' });

// A slot object in an annotated variable skips the excess-property check; must still compile.
const slots = { hasShell: false, shellNote: '' };

verification.render(slots);

// An empty string is legal; absent is banned.
verification.render({ hasShell: true, shellNote: '' });

// Contracts that are only flags, only slots, or neither.
flagsOnly.render({ on: true });

slotsOnly.render({ value: 'x' });

noSlots.render({});

// A promoted replacement, rendered against the same contract.
verification.renderFrom('## V{{#if hasShell}} {{shellNote}}{{/if}}', {
  hasShell: true, shellNote: 'x',
});

const promoted = '## V{{#if hasShell}}{{shellNote}}{{/if}}';

templateContract(verification.id, promoted);
