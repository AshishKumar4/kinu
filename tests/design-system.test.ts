/**
 * The design system's gate (docs/DESIGN-SYSTEM.md §4): no page or feature component draws its own box, colour, type or
 * raw control, `ui/` names only tokens, and `index.css` holds no colour, size or radius but theme.ts's and the role
 * table's. A finding reads as `file:line rule token`, so a red run says where to look.
 */
import { expect, test } from 'bun:test';
import { scanDesignSystem } from '../scripts/design-system-scan';

test('the app takes every look from the design system', () => {
  const findings = scanDesignSystem().map((finding) => `${finding.file}:${String(finding.line)} ${finding.rule} ${finding.token}`);

  expect(findings).toEqual([]);
});
