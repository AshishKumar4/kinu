// Behavior tests for the prompt-section template engine.
//
// The engine's whole justification is that prompt prose becomes an addressable
// value, so the two properties that matter are: it renders the same bytes the
// hand-written string did, and it refuses to render silently-wrong bytes.
import { describe, expect, test } from 'bun:test';
import { definePromptSection, templateContract, type TemplateSlots } from '../src/prompting/template';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildSystemPromptSync } from '../src/prompt';
import { BUILTIN_TOOL_LINE } from '../src/prompting/section-templates';
import { BUILTIN_TOOLS, BUILTIN_TOOL_SPECS, type BuiltinToolName } from '../src/tools/registry';
// Narrow import: a prompt-template test has no business pulling the core barrel
// (orchestrator, heads, chat) in behind a test runtime.
import { createTestRuntime } from '../../test-utils/src/runtime';

/** Longest common prefix of two strings, in code units — the cache measurement. */
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

  test('a repeated slot is one contract entry and renders at every position', () => {
    const section = definePromptSection('t/repeat', '{{v}}-{{v}}-{{v}}');
    expect(section.render({ v: 'q' })).toBe('q-q-q');
  });

  test('interpolated content is never rewritten — no whitespace normalisation', () => {
    // OpenSeal's engine ends compile() with .replace(/\n{3,}/g,'\n\n') plus an
    // outer trim, which silently rewrites whatever was interpolated. Doing that
    // here would mutate SOUL.md / SKILL.md bodies on their way into the prompt
    // and make byte-identical conversion of an existing section impossible.
    const section = definePromptSection('t/verbatim', '[{{body}}]');
    const body = '\n\n\n\nkeep   every   byte\t\n\n\n';
    expect(section.render({ body })).toBe(`[${body}]`);
  });

  test('a slot value containing {{ }} is not re-parsed', () => {
    // Tool examples are arbitrary code. Substituted text is output, not source.
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
  // The type system stops a missing slot when the source is a literal. It cannot
  // when the source arrives at runtime — which is exactly the case this engine
  // exists to enable (a section loaded from a store, or rewritten by GEPA). So
  // the runtime check is the one that has to hold, and it is tested through that
  // same door: `source` typed as `string` erases the slot contract.
  const fromStore: string = 'A {{present}} B {{absent}} C';

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

  test('an empty string is a legal value and renders empty', () => {
    // The distinction that matters: absent is a bug, empty is a decision.
    const section = definePromptSection('t/empty', 'A{{v}}B');
    expect(section.render({ v: '' })).toBe('AB');
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
    // The first genuine difference is where `third` is substituted, so the
    // common prefix must reach exactly that index — not one byte less.
    const firstDifference = base.indexOf('3', base.indexOf('TAIL '));
    expect(commonPrefixLength(base, changed)).toBe(firstDifference);
    expect(base.slice(0, firstDifference)).toBe(changed.slice(0, firstDifference));
  });

  test('slot order follows the source, never the data object', () => {
    // Key order in the caller's literal must not reach the output, or the
    // prefix would move whenever a call site was reformatted.
    const forward = section.render({ first: 'a', second: 'b', third: 'c' });
    const shuffled = section.render({ third: 'c', first: 'a', second: 'b' });
    expect(shuffled).toBe(forward);
  });
});

describe('TemplateSlots — the typed boundary', () => {
  // Exact type equality: if the extracted contract gained or lost a key, or
  // widened, `true satisfies Exact<…>` stops compiling. `satisfies` rather than
  // an annotation so the literal is not widened.
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

  test('a flag used twice is one required key, and never leaks in as a text slot', () => {
    const exact = true satisfies Exact<
      TemplateSlots<'{{#if on}}a{{/if}}{{#if on}}b{{/if}}'>,
      { readonly on: boolean }
    >;
    expect(exact).toBe(true);
  });

  test('{{else}} and {{/if}} are block syntax, never contract entries', () => {
    const exact = true satisfies Exact<
      TemplateSlots<'{{#if on}}a{{else}}b{{/if}}'>,
      { readonly on: boolean }
    >;
    expect(exact).toBe(true);
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
    // The whole reason a conditional can replace `lines.push()` + `join('\n')`
    // byte-for-byte: an omitted line must not leave the newline that joined it.
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
  // Same door as the missing-slot tests above: `string` erases the compile-time
  // contract, which is exactly the shape a promoted candidate arrives in.
  const fromStore: string = 'A{{#if flag}}B{{/if}}';

  test('an absent flag throws naming it — the section never silently vanishes', () => {
    const section = definePromptSection('t/flag-absent', fromStore);
    expect(() => section.render({})).toThrow(
      /prompt template "t\/flag-absent": flag \{\{#if flag\}\} has no value\. Supplied: \(none\)/,
    );
  });

  test('a string where a flag belongs throws, and says which spelling to use', () => {
    const section = definePromptSection('t/flag-typed', fromStore);
    // No assertion needed to write this: a runtime source declares no contract,
    // so the compiler has nothing to object to. That IS the case under test.
    const stringWhereFlagBelongs = { flag: 'true' };
    expect(() => section.render(stringWhereFlagBelongs)).toThrow(
      /flag \{\{#if flag\}\} is a boolean slot but was given a string — write \{\{flag\}\}/,
    );
  });

  test('a boolean where a text slot belongs throws the mirror of that', () => {
    const source: string = 'A{{value}}B';
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
    // The tag a writer reaches for next. Swept into "malformed slot" it reads as
    // a typo; named, it reads as the design decision it is.
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
    // The contract check that stops the second case BEFORE a turn renders it is
    // `templateContract`, used by the promotion gate — this is the backstop.
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
  // `expectedLine` is derived from the specs WITHOUT the engine, so this fails
  // if the template's wording, spacing, separator or backticks drift.
  //
  // 2026-08-25: the line lost its `{{summary}}`. The summary is line 1 of the
  // same tool's schema description, which ships in the same request, so the
  // index was sending all eight of them twice (942 chars). The example is what
  // only the index carries. The derivation is unchanged in kind: it just
  // describes the one-line shape now, and the second test below makes the
  // removal a PROVEN property rather than a note, so the duplicate cannot
  // quietly come back.
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
    // The duplication this template was slimmed to remove. Asserted on the
    // rendered line rather than on the source, so re-adding it through a
    // promoted section override fails here too.
    for (const name of BUILTIN_TOOLS) {
      const spec = BUILTIN_TOOL_SPECS[name];
      expect(BUILTIN_TOOL_LINE.render({ name, example: spec.example }))
        .not.toContain(spec.summary);
    }
  });

  test('those exact bytes reach the built prompt', () => {
    const { rt } = createTestRuntime();
    const prompt = buildSystemPromptSync(rt);
    // Not every built-in renders on every surface; each one that does must
    // render byte-exactly, and at least one must, or this proves nothing.
    const present = BUILTIN_TOOLS.filter((name) => prompt.includes(`- **${name}**:`));
    expect(present.length).toBeGreaterThan(0);
    for (const name of present) expect(prompt).toContain(expectedLine(name));
  });

  // Cut-the-wire: byte-identity alone cannot tell a live template from a
  // reverted inline literal, because both produce the same bytes. This asserts
  // the builder actually goes through the section, using the same source-text
  // idiom as unit-gepa-split-wiring.test.ts. The whole-prompt version of this
  // check — no section prose left anywhere in the builder — is in
  // unit-prompt-sections.test.ts.
  test('the builder renders the tool line THROUGH the template, not inline', () => {
    const source = readFileSync(join(import.meta.dir, '..', 'src', 'prompt.ts'), 'utf8');
    const start = source.indexOf('function renderBuiltinToolLine(');
    expect(start).toBeGreaterThan(-1);
    const body = source.slice(start, source.indexOf('\n}', start));
    expect(body).toContain('render(BUILTIN_TOOL_LINE,');
    // The literal it replaced must be gone, or both paths exist and drift.
    expect(body).not.toContain('- **${name}**');
    expect(source).toContain('BUILTIN_TOOL_LINE,');
  });
});
