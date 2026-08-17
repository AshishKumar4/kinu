// Behavior tests for the prompt-section template engine.
//
// The engine's whole justification is that prompt prose becomes an addressable
// value, so the two properties that matter are: it renders the same bytes the
// hand-written string did, and it refuses to render silently-wrong bytes.
import { describe, expect, test } from 'bun:test';
import { definePromptSection, type TemplateSlots } from '../src/prompting/template.ts';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildSystemPromptSync } from '../src/prompt.ts';
import { BUILTIN_TOOL_LINE } from '../src/prompting/section-templates.ts';
import { BUILTIN_TOOLS, BUILTIN_TOOL_SPECS, type BuiltinToolName } from '../src/tools/registry.ts';
// Narrow import: a prompt-template test has no business pulling the core barrel
// (orchestrator, heads, chat) in behind a test runtime.
import { createTestRuntime } from '../../test-utils/src/runtime.ts';

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
    try { rendered = section.render({ present: 'x' }); } catch { /* asserted below */ }
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
});

describe('BUILTIN_TOOL_LINE — live in the system prompt', () => {
  // Byte-identity is the whole landing condition: the template replaced a
  // hand-written template literal and the prompt must not have moved one byte,
  // so the layergate `system-prefix` digest is untouched by this conversion.
  // `expected` is derived from the specs WITHOUT the engine, so it fails if the
  // template's wording, spacing, em-dash or backticks drift.
  function expectedLine(name: BuiltinToolName): string {
    const spec = BUILTIN_TOOL_SPECS[name];
    return `- **${name}** — ${spec.summary}\n  \`${spec.example}\``;
  }

  test('renders every built-in tool exactly as the hand-written literal did', () => {
    for (const name of BUILTIN_TOOLS) {
      const spec = BUILTIN_TOOL_SPECS[name];
      const rendered = BUILTIN_TOOL_LINE.render({
        name, summary: spec.summary, example: spec.example,
      });
      expect(rendered).toBe(expectedLine(name));
    }
  });

  test('those exact bytes reach the built prompt', () => {
    const { rt } = createTestRuntime();
    const prompt = buildSystemPromptSync(rt);
    // Not every built-in renders on every surface; each one that does must
    // render byte-exactly, and at least one must, or this proves nothing.
    const present = BUILTIN_TOOLS.filter((name) => prompt.includes(`- **${name}** —`));
    expect(present.length).toBeGreaterThan(0);
    for (const name of present) expect(prompt).toContain(expectedLine(name));
  });

  // Cut-the-wire: byte-identity alone cannot tell a live template from a
  // reverted inline literal, because both produce the same bytes. This asserts
  // the builder actually goes through the section, using the same source-text
  // idiom as unit-gepa-split-wiring.test.ts.
  test('the builder renders the tool line THROUGH the template, not inline', () => {
    const source = readFileSync(join(import.meta.dir, '..', 'src', 'prompt.ts'), 'utf8');
    const start = source.indexOf('function renderBuiltinToolLine(');
    expect(start).toBeGreaterThan(-1);
    const body = source.slice(start, source.indexOf('\n}', start));
    expect(body).toContain('BUILTIN_TOOL_LINE.render(');
    // The literal it replaced must be gone, or both paths exist and drift.
    expect(body).not.toContain('- **${name}**');
    expect(source).toContain("import { BUILTIN_TOOL_LINE } from './prompting/section-templates.js';");
  });
});
