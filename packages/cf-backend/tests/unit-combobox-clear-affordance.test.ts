/**
 * Only the `aria-label` ties the stylesheet's Kumo clear-button removal to ModelPicker's label.
 * Defends: a rename on either side silently bringing the dead X back on the workspace toolbar.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const css = readFileSync(resolve(import.meta.dir, '../src/index.css'), 'utf8');

const picker = readFileSync(resolve(import.meta.dir, '../src/components/ModelPicker.tsx'), 'utf8');

const CSS_LABEL = css.match(/\.p-combobox-no-clear\s*>\s*\[aria-label="([^"]+)"\]/)?.[1];

const TSX_LABEL = picker.match(/const CLEAR_LABEL_UNUSED = "([^"]+)"/)?.[1];

// Load-time precondition: with neither side present the equality below compares undefined to undefined and passes.
if (CSS_LABEL === undefined || TSX_LABEL === undefined) {
  throw new Error('combobox clear affordance: nothing to compare — '
    + `index.css rule label=${String(CSS_LABEL)}, ModelPicker label=${String(TSX_LABEL)}`);
}

describe('combobox clear affordance', () => {
  test('the label the picker sends is the label the stylesheet hides', () => {
    expect(TSX_LABEL).toBe(CSS_LABEL);
  });

  test('only a clearable picker keeps the clear button', () => {
    // Applied on exactly the non-clearable branch; inverting it would hide a working control.
    expect(picker).toContain('clearable ? className : `p-combobox-no-clear ${className ?? ""}`');
    expect(picker).toContain('clearLabel={clearable ? "Use default model" : CLEAR_LABEL_UNUSED}');
  });
});
