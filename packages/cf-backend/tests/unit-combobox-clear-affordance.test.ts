/**
 * The stylesheet removes Kumo's forced clear button by matching its
 * `aria-label`, and ModelPicker supplies that label. Nothing else ties the two
 * together, so a rename on either side silently brings the dead X back — on
 * the workspace toolbar, where it lands on top of a model name that is already
 * clipping. That is exactly the defect an owner screenshot caught.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const css = readFileSync(resolve(import.meta.dir, '../src/index.css'), 'utf8');

const picker = readFileSync(resolve(import.meta.dir, '../src/components/ModelPicker.tsx'), 'utf8');

/** The `[aria-label="…"]` the `.p-combobox-no-clear` rule hides. */
const CSS_LABEL = css.match(/\.p-combobox-no-clear\s*>\s*\[aria-label="([^"]+)"\]/)?.[1];

/** The label ModelPicker hands Kumo for the same button. */
const TSX_LABEL = picker.match(/const CLEAR_LABEL_UNUSED = "([^"]+)"/)?.[1];

// THE GUARD'S GUARD, as a load-time precondition rather than a test of its
// own. With no rule and no constant there is nothing to keep in step, and the
// equality below then compares undefined to undefined and passes — which is
// exactly the state a rename produces. `expect(CSS_LABEL).toBeDefined()` said
// so in a case that asserted nothing about the affordance; a throw here says
// the same thing louder, cannot be skipped, and names both sides.
if (CSS_LABEL === undefined || TSX_LABEL === undefined) {
  throw new Error('combobox clear affordance: nothing to compare — '
    + `index.css rule label=${String(CSS_LABEL)}, ModelPicker label=${String(TSX_LABEL)}`);
}

describe('combobox clear affordance', () => {
  test('the label the picker sends is the label the stylesheet hides', () => {
    expect(TSX_LABEL).toBe(CSS_LABEL);
  });

  test('only a clearable picker keeps the clear button', () => {
    // The class is what removes it, so it must be applied on exactly the
    // non-clearable branch — inverting this would hide a working control.
    expect(picker).toContain('clearable ? className : `p-combobox-no-clear ${className ?? ""}`');
    expect(picker).toContain('clearLabel={clearable ? "Use default model" : CLEAR_LABEL_UNUSED}');
  });
});
