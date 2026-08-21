/**
 * Conditional-template misuse that MUST NOT compile. Every line here is a real
 * way to get the wrong bytes into a live prompt, and the file is deliberately
 * broken: it is EXCLUDED from `packages/core/tsconfig.json` and typechecked only
 * by `unit-prompt-template-flags.test.ts`, which runs the same `tsc` the gate
 * runs and reads a diagnostic off each marked line.
 *
 * Why this fixture exists at all. `{{#if}}` was kept OUT of this engine for one
 * stated reason — "an untyped string lookup that renders empty when it misses"
 * is the failure that left two mode overlays dead in the live prompt. The
 * conditional is only allowed back because the flag is a DECLARED boolean slot,
 * and that claim is worth exactly as much as the compiler that enforces it. A
 * ban nobody points a compiler at is decoration.
 *
 * Written without a single `@ts-expect-error`. That directive proves an error
 * exists somewhere on the next line; it does not prove WHICH, so a fixture built
 * from it would keep passing if the contract broke and a typo took its place.
 * The test asserts the diagnostic names the offending slot.
 *
 * SHAPE MATTERS: a `// [n]` marker must be followed by comment lines and then the
 * offending CALL — nothing else. The test resolves each case to the first
 * non-comment line after its marker, so declarations belong above, here.
 *
 * Do not "fix" anything below the declarations.
 */

import { definePromptSection } from '../../../src/prompting/template';

const verification = definePromptSection(
  'fixture/verification',
  '## Verification\n- always{{#if hasShell}}\n- {{shellNote}}{{/if}}',
);

// [1] An undeclared flag. The template branches on `hasShell` and nothing else,
//     so a caller that thinks it wired `hasSandbox` wired nothing — the exact
//     silent-empty failure the conditional was banned for.
verification.render({ hasShell: true, shellNote: 'run it', hasSandbox: true });

// [2] A declared flag omitted. Absent is not false: nobody decided this.
verification.render({ shellNote: 'run it' });

// [3] A flag supplied as a string. `'false'` is truthy, so the untyped version
//     of this renders the branch the caller meant to suppress.
verification.render({ hasShell: 'false', shellNote: 'run it' });

// [4] A text slot supplied as a boolean — the mirror of [3].
verification.render({ hasShell: true, shellNote: true });

// [5] A declared text slot omitted.
verification.render({ hasShell: true });

// [6] An undeclared text slot.
verification.render({ hasShell: true, shellNote: 'run it', footer: 'extra' });

// [7] The promoted-candidate door takes the SAME contract. A replacement source
//     does not get to be rendered with different data than the incumbent.
verification.renderFrom('## V{{#if hasShell}}{{shellNote}}{{/if}}', { hasShell: true });
