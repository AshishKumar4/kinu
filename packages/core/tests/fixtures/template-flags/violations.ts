/**
 * Conditional-template misuse that must not compile. Excluded from
 * `packages/core/tsconfig.json`; typechecked by `unit-prompt-template-flags.test.ts`,
 * which asserts each diagnostic names the offending slot (so no `@ts-expect-error`).
 *
 * A `// [n]` marker must be followed only by comment lines and then the offending
 * call; declarations belong above. Do not "fix" anything below the declarations.
 */

import { definePromptSection } from '../../../src/prompting/template';

const verification = definePromptSection(
  'fixture/verification',
  '{{shellNote}}{{#if hasShell}}{{/if}}',
  '## Verification\n- always{{#if hasShell}}\n- {{shellNote}}{{/if}}',
);

// [1] An undeclared flag.
verification.render({ hasShell: true, shellNote: 'run it', hasSandbox: true });

// [2] A declared flag omitted. Absent is not false.
verification.render({ shellNote: 'run it' });

// [3] A flag supplied as a string: `'false'` is truthy.
verification.render({ hasShell: 'false', shellNote: 'run it' });

// [4] A text slot supplied as a boolean.
verification.render({ hasShell: true, shellNote: true });

// [5] A declared text slot omitted.
verification.render({ hasShell: true });

// [6] An undeclared text slot.
verification.render({ hasShell: true, shellNote: 'run it', footer: 'extra' });

// [7] The promoted-candidate door takes the same contract.
verification.renderFrom('## V{{#if hasShell}}{{shellNote}}{{/if}}', { hasShell: true });
