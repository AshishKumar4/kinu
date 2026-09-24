// Prompt-section template engine: renders the hand-written bytes exactly and
// refuses to render silently-wrong bytes.
import { describe, expect, test } from 'bun:test';
import { definePromptSection, templateContract, type TemplateSlots } from '../src/prompting/template';
import { buildSystemPromptSync } from '../src/prompt';
import { BUILTIN_TOOL_LINE } from '../src/prompting/section-templates';
import { BUILTIN_TOOLS, BUILTIN_TOOL_SPECS, type BuiltinToolName } from '../src/tools/registry';
// Narrow import: keep the core barrel out of this test.
import { createTestRuntime } from '../../test-utils/src/runtime';

/** Typed as `string` to erase the inferred slot contract, as a runtime source does. */
function storedSource(source: string): string {
  return source;
}

function commonPrefixLength(a: string, b: string): number {
  const limit = Math.min(a.length, b.length);
  let i = 0;

  while (i < limit && a.charCodeAt(i) === b.charCodeAt(i)) i += 1;

  return i;
}

describe('definePromptSection — rendering', () => {
  test('renders slots in source order, verbatim', () => {
    const section = definePromptSection('t/basic', 'A {{one}} B {{two}} C');
    expect(section.render({ one: 'x', two: 'y' })).toBe('A x B y C');
  });

  test('a section with no slots renders its source unchanged', () => {
    const source = '## Persistence\nYou are NOT stateless between turns.';
    expect(definePromptSection('t/static', source).render({})).toBe(source);
  });

  const RENDERS = [
    {
      name: 'a repeated slot is one contract entry and renders at every position',
      id: 't/repeat', template: '{{v}}-{{v}}-{{v}}', value: 'q', text: 'q-q-q',
    },
    {
      // Absent is a bug; empty is a decision.
      name: 'an empty string is a legal value and renders empty',
      id: 't/empty', template: 'A{{v}}B', value: '', text: 'AB',
    },
  ];

  for (const rendered of RENDERS) {
    test(rendered.name, () => {
      const section = definePromptSection(rendered.id, rendered.template);

      expect(section.render({ v: rendered.value })).toBe(rendered.text);
    });
  }

  test('interpolated content is never rewritten — no whitespace normalisation', () => {
    // No blank-line collapsing or trim: interpolated SOUL.md / SKILL.md bodies must pass through unchanged.
    const section = definePromptSection('t/verbatim', '[{{body}}]');
    const body = '\n\n\n\nkeep   every   byte\t\n\n\n';
    expect(section.render({ body })).toBe(`[${body}]`);
  });

  test('a slot value containing {{ }} is not re-parsed', () => {
    const section = definePromptSection('t/nested', '<{{code}}>');
    expect(section.render({ code: 'f({{x}})' })).toBe('<f({{x}})>');
  });

  test('the source stays readable on the section — this is what makes it evolvable', () => {
    const source = 'hello {{who}}';
    const section = definePromptSection('t/addressable', source);
    expect(section.id).toBe('t/addressable');
    expect(section.source).toBe(source);
  });
});

describe('definePromptSection — a missing slot fails loudly', () => {
  // A runtime source (store row, GEPA rewrite) has no compile-time contract, so the runtime check must hold.
  const fromStore = storedSource('A {{present}} B {{absent}} C');

  test('throws, naming the section and the slot, instead of rendering empty', () => {
    const section = definePromptSection('t/store', fromStore);
    expect(() => section.render({ present: 'x' })).toThrow(
      /prompt template "t\/store": slot \{\{absent\}\} has no value\. Supplied: present/,
    );
  });

  test('and does not silently drop the section — no partial output escapes', () => {
    const section = definePromptSection('t/store2', fromStore);
    let rendered: string | null = null;
    expect(() => { rendered = section.render({ present: 'x' }); })
      .toThrow(/prompt template "t\/store2": slot \{\{absent\}\} has no value/);
    expect(rendered).toBeNull();
  });
});

describe('definePromptSection — a malformed template fails at definition', () => {
  test('rejects an unclosed tag', () => {
    expect(() => definePromptSection('t/unclosed', 'A {{oops')).toThrow(
      /prompt template "t\/unclosed": unclosed \{\{ at index 2/,
    );
  });

  test('rejects a slot with inner spaces, so the type and the parser cannot disagree', () => {
    expect(() => definePromptSection('t/spaced', 'A {{ oops }} B')).toThrow(
      /malformed slot "\{\{ oops \}\}" at index 2/,
    );
  });

  test('rejects a dotted path — navigation belongs in TypeScript, not the template', () => {
    expect(() => definePromptSection('t/dotted', '{{a.b}}')).toThrow(/malformed slot/);
  });
});

describe('definePromptSection — cache-prefix stability, measured', () => {
  const section = definePromptSection(
    't/prefix',
    'STABLE HEAD {{first}} | MIDDLE {{second}} | TAIL {{third}}',
  );

  test('identical data renders byte-identical output', () => {
    const a = section.render({ first: '1', second: '2', third: '3' });
    const b = section.render({ first: '1', second: '2', third: '3' });
    expect(a).toBe(b);
    expect(commonPrefixLength(a, b)).toBe(a.length);
  });

  test('changing one slot leaves every byte ahead of it untouched', () => {
    const base = section.render({ first: '1', second: '2', third: '3' });
    const changed = section.render({ first: '1', second: '2', third: 'CHANGED' });
    const firstDifference = base.indexOf('3', base.indexOf('TAIL '));
    expect(commonPrefixLength(base, changed)).toBe(firstDifference);
    expect(base.slice(0, firstDifference)).toBe(changed.slice(0, firstDifference));
  });

  test('slot order follows the source, never the data object', () => {
    // Caller key order must not move the prefix.
    const forward = section.render({ first: 'a', second: 'b', third: 'c' });
    const shuffled = section.render({ third: 'c', first: 'a', second: 'b' });
    expect(shuffled).toBe(forward);
  });
});

describe('TemplateSlots — the typed boundary', () => {
  // `true satisfies Exact<…>` stops compiling if the contract gains, loses, or widens a key.
  type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

  test('extracts exactly the declared slots, as required readonly strings', () => {
    const exact = true satisfies Exact<
      TemplateSlots<'- **{{name}}** — {{summary}}\n  `{{example}}`'>,
      { readonly name: string; readonly summary: string; readonly example: string }
    >;

    expect(exact).toBe(true);
  });

  test('collapses a repeated slot into one required key', () => {
    const exact = true satisfies Exact<
      TemplateSlots<'{{v}} {{v}}'>,
      { readonly v: string }
    >;

    expect(exact).toBe(true);
  });

  test('a slotless source requires nothing', () => {
    const exact = true satisfies Exact<TemplateSlots<'plain prose'>, {}>;
    expect(exact).toBe(true);
  });

  test('a flag is a required boolean, alongside the text slots', () => {
    const exact = true satisfies Exact<
      TemplateSlots<'## V\n- a{{#if hasShell}}\n- b {{note}}{{/if}}'>,
      { readonly note: string } & { readonly hasShell: boolean }
    >;

    expect(exact).toBe(true);
  });

  // Type-level contract: the template must be a literal type, so no table.
  test('a flag is one required key however it is written, and no block token joins it', () => {
    const usedTwice = true satisfies Exact<
      TemplateSlots<'{{#if on}}a{{/if}}{{#if on}}b{{/if}}'>,
      { readonly on: boolean }
    >;

    const withElse = true satisfies Exact<
      TemplateSlots<'{{#if on}}a{{else}}b{{/if}}'>,
      { readonly on: boolean }
    >;

    expect(usedTwice).toBe(true);
    expect(withElse).toBe(true);
  });
});

describe('{{#if}} — prose that branches on one declared boolean', () => {
  const section = definePromptSection(
    't/if',
    '## Verification\n- always{{#if hasShell}}\n- only with a shell{{/if}}',
  );

  test('true renders the branch, false renders nothing at all', () => {
    expect(section.render({ hasShell: true }))
      .toBe('## Verification\n- always\n- only with a shell');
    expect(section.render({ hasShell: false })).toBe('## Verification\n- always');
  });

  test('the newline-inside-the-block idiom drops a line WITH its separator', () => {
    // An omitted line must not leave its joining newline.
    expect(section.render({ hasShell: false }).endsWith('- always')).toBe(true);
    expect(section.render({ hasShell: false })).not.toContain('\n\n');
  });

  test('{{else}} renders the alternative, and never both', () => {
    const either = definePromptSection('t/else', 'Plan mode: {{#if submits}}call `submit_plan`{{else}}report to the parent{{/if}}.');
    expect(either.render({ submits: true })).toBe('Plan mode: call `submit_plan`.');
    expect(either.render({ submits: false })).toBe('Plan mode: report to the parent.');
  });

  test('conditionals nest, and an outer false skips the whole inner branch', () => {
    const nested = definePromptSection(
      't/nested-if',
      'A{{#if outer}}B{{#if inner}}C{{else}}D{{/if}}E{{/if}}F',
    );

    expect(nested.render({ outer: true, inner: true })).toBe('ABCEF');
    expect(nested.render({ outer: true, inner: false })).toBe('ABDEF');
    expect(nested.render({ outer: false, inner: true })).toBe('AF');
  });

  test('a repeated flag is one contract entry and branches at every position', () => {
    const twice = definePromptSection('t/if-twice', '{{#if on}}1{{/if}}-{{#if on}}2{{/if}}');
    expect(twice.render({ on: true })).toBe('1-2');
    expect(twice.render({ on: false })).toBe('-');
  });

  test('a flag and a text slot can share a source without colliding', () => {
    const mixed = definePromptSection('t/mixed', '{{#if show}}{{value}}{{/if}}');
    expect(mixed.render({ show: true, value: 'x' })).toBe('x');
    expect(mixed.render({ show: false, value: 'x' })).toBe('');
  });
});

describe('{{#if}} — a flag with no value fails loudly, like every other slot', () => {
  const fromStore = storedSource('A{{#if flag}}B{{/if}}');

  test('an absent flag throws naming it — the section never silently vanishes', () => {
    const section = definePromptSection('t/flag-absent', fromStore);
    expect(() => section.render({})).toThrow(
      /prompt template "t\/flag-absent": flag \{\{#if flag\}\} has no value\. Supplied: \(none\)/,
    );
  });

  test('a string where a flag belongs throws, and says which spelling to use', () => {
    const section = definePromptSection('t/flag-typed', fromStore);
    // A runtime source declares no contract, so this compiles; that is the case under test.
    const stringWhereFlagBelongs = { flag: 'true' };
    expect(() => section.render(stringWhereFlagBelongs)).toThrow(
      /flag \{\{#if flag\}\} is a boolean slot but was given a string — write \{\{flag\}\}/,
    );
  });

  test('a boolean where a text slot belongs throws the mirror of that', () => {
    const source = storedSource('A{{value}}B');
    const section = definePromptSection('t/slot-typed', source);
    const booleanWhereTextBelongs = { value: true };
    expect(() => section.render(booleanWhereTextBelongs)).toThrow(
      /slot \{\{value\}\} is a text slot but was given a boolean — write \{\{#if value\}\}/,
    );
  });
});

describe('{{#if}} — a malformed conditional fails at definition', () => {
  test('rejects a conditional that is never closed', () => {
    expect(() => definePromptSection('t/unclosed-if', 'A{{#if x}}B')).toThrow(
      /prompt template "t\/unclosed-if": unclosed \{\{#if x\}\} — every conditional needs its \{\{\/if\}\}/,
    );
  });

  test('rejects a close with nothing open', () => {
    expect(() => definePromptSection('t/stray-close', 'A{{/if}}B')).toThrow(
      /\{\{\/if\}\} at index 1 with no \{\{#if\}\} open/,
    );
  });

  test('rejects {{else}} outside a conditional', () => {
    expect(() => definePromptSection('t/stray-else', 'A{{else}}B')).toThrow(
      /\{\{else\}\} at index 1 with no \{\{#if\}\} open/,
    );
  });

  test('rejects a second {{else}} in one conditional', () => {
    expect(() => definePromptSection('t/two-else', '{{#if x}}A{{else}}B{{else}}C{{/if}}')).toThrow(
      /a second \{\{else\}\} at index 19 in \{\{#if x\}\}/,
    );
  });

  test('rejects an expression in the condition — a flag is one declared boolean', () => {
    expect(() => definePromptSection('t/expr', '{{#if a && b}}x{{/if}}')).toThrow(
      /malformed flag "\{\{#if a && b\}\}" at index 0 — a flag is \{\{#if name\}\} with one space and no expression/,
    );
  });

  test('rejects {{#each}} BY NAME, pointing at where iteration lives', () => {
    expect(() => definePromptSection('t/each', '{{#each items}}x{{/each}}')).toThrow(
      /unknown block tag "\{\{#each items\}\}" at index 0 — .*iteration stays in TypeScript/,
    );
  });
});

describe('renderFrom — the door a promoted candidate comes through', () => {
  const section = definePromptSection('t/promotable', 'A {{v}}{{#if on}} B{{/if}}');

  test('renders the replacement, not the built-in source', () => {
    expect(section.renderFrom('Z {{v}}{{#if on}} Y{{/if}}', { v: 'q', on: true })).toBe('Z q Y');
    expect(section.render({ v: 'q', on: true })).toBe('A q B');
  });

  test('a replacement that drops a slot is legal; one that invents a slot throws', () => {
    // `templateContract` in the promotion gate catches this first; this is the backstop.
    expect(section.renderFrom('static prose', { v: 'q', on: true })).toBe('static prose');
    expect(() => section.renderFrom('{{invented}}', { v: 'q', on: true })).toThrow(
      /slot \{\{invented\}\} has no value/,
    );
  });

  test('re-rendering the same replacement is byte-stable', () => {
    const replacement = 'R {{v}}{{#if on}}!{{/if}}';
    const first = section.renderFrom(replacement, { v: '1', on: false });
    const second = section.renderFrom(replacement, { v: '1', on: false });
    expect(second).toBe(first);
    expect(commonPrefixLength(first, second)).toBe(first.length);
  });
});

describe('templateContract — what a candidate must declare', () => {
  test('reads both slot kinds out of a runtime source, sorted and deduped', () => {
    expect(templateContract('t/contract', 'x{{b}}{{#if f}}{{a}}{{b}}{{else}}{{#if g}}z{{/if}}{{/if}}'))
      .toEqual({ slots: ['a', 'b'], flags: ['f', 'g'] });
  });

  test('a section and its own source agree', () => {
    const section = definePromptSection('t/self', 'p {{one}}{{#if two}}q{{/if}}');
    expect(templateContract(section.id, section.source))
      .toEqual({ slots: ['one'], flags: ['two'] });
  });
});

describe('BUILTIN_TOOL_LINE — live in the system prompt', () => {
  // `expectedLine` is derived from the specs without the engine, so wording drift fails.
  function expectedLine(name: BuiltinToolName): string {
    const spec = BUILTIN_TOOL_SPECS[name];

    return `- **${name}**: \`${spec.example}\``;
  }

  test('renders every built-in tool as its name and its one real call', () => {
    for (const name of BUILTIN_TOOLS) {
      const spec = BUILTIN_TOOL_SPECS[name];
      const rendered = BUILTIN_TOOL_LINE.render({ name, example: spec.example });
      expect(rendered).toBe(expectedLine(name));
    }
  });

  test('the line never carries the summary the schema description already ships', () => {
    // Asserted on the rendered line, so a promoted override re-adding it fails too.
    for (const name of BUILTIN_TOOLS) {
      const spec = BUILTIN_TOOL_SPECS[name];
      expect(BUILTIN_TOOL_LINE.render({ name, example: spec.example }))
        .not.toContain(spec.summary);
    }
  });

  test('those exact bytes reach the built prompt', () => {
    const { rt } = createTestRuntime();
    const prompt = buildSystemPromptSync(rt);
    // At least one built-in must render, or this proves nothing.
    const present = BUILTIN_TOOLS.filter((name) => prompt.includes(`- **${name}**:`));
    expect(present.length).toBeGreaterThan(0);

    for (const name of present) expect(prompt).toContain(expectedLine(name));
  });

  // Byte identity cannot tell a live template from a reverted inline literal; a promoted override can.
  test('a promoted override of the tool line reaches the built prompt', () => {
    const { rt } = createTestRuntime();
    const promoted = '- tool {{name}}, called as {{example}}';
    const prompt = buildSystemPromptSync(rt, { sectionOverrides: { [BUILTIN_TOOL_LINE.id]: promoted } });
    const rendered = BUILTIN_TOOLS.filter((name) => prompt.includes(`- tool ${name}, called as `));
    expect(rendered.length).toBeGreaterThan(0);

    for (const name of rendered) {
      expect(prompt).toContain(`- tool ${name}, called as ${BUILTIN_TOOL_SPECS[name].example}`);
      expect(prompt).not.toContain(expectedLine(name));
    }
  });
});
