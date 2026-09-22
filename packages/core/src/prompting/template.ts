/**
 * Prompt-section templating: prose is data, control flow stays in TypeScript.
 * A section defined as one template string is addressable by GEPA and
 * replaceable at runtime. `{{#if flag}}` declares a typed boolean slot like
 * `{{slot}}` declares a string; there is no `{{#each}}` (iteration needs an
 * expression language). A missing slot throws: a silently empty section is
 * invisible. An empty string is legal, an absent key is not.
 */

import * as v from 'valibot';

type Tag<Source extends string> =
  Source extends `${string}{{${infer Name}}}${infer Rest}`
    ? Name | Tag<Rest>
    : never;

type ValueTag<Name extends string> =
  Name extends `#${string}` | `/${string}` | 'else' ? never : Name;

type BlockFlag<Name extends string> = Name extends `#if ${infer Flag}` ? Flag : never;

type SlotName<Source extends string> = ValueTag<Tag<Source>>;

type FlagName<Source extends string> = BlockFlag<Tag<Source>>;

/**
 * Exactly the data a template needs: `{{slot}}` requires a string, `{{#if flag}}`
 * a boolean; omissions fail to compile and invented names are excess properties.
 * A non-literal source yields no slots and is checked at runtime (`renderNodes`).
 */
export type TemplateSlots<Source extends string> =
  & { readonly [Name in SlotName<Source>]: string }
  & { readonly [Name in FlagName<Source>]: boolean };

type SlotValues = Readonly<Record<string, string | boolean>>;

// Runtime kind checks for sources the compiler cannot see (promoted candidates).
const TEXT_VALUE = v.string();

const FLAG_VALUE = v.boolean();

type TemplateNode =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'slot'; readonly name: string }
  | {
      readonly kind: 'if';
      readonly flag: string;
      readonly whenTrue: readonly TemplateNode[];
      readonly whenFalse: readonly TemplateNode[];
    };

/** No inner spaces: the runtime grammar must match what `Tag` infers, or contract and lookup diverge. */
const SLOT_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/;

const IF_PREFIX = '#if ';

interface OpenBlock {
  readonly flag: string;
  readonly whenTrue: TemplateNode[];
  readonly whenFalse: TemplateNode[];
  branch: 'then' | 'else';
}

function fail(id: string, message: string): never {
  throw new Error(`prompt template "${id}": ${message}`);
}

function pushText(into: TemplateNode[], text: string): void {
  if (text !== '') into.push({ kind: 'text', text });
}

function compileTemplate(id: string, source: string): TemplateNode[] {
  const root: TemplateNode[] = [];
  const open: OpenBlock[] = [];

  const top = (): TemplateNode[] => {
    const block = open.at(-1);

    if (!block) return root;

    return block.branch === 'then' ? block.whenTrue : block.whenFalse;
  };

  let pos = 0;

  for (;;) {
    const start = source.indexOf('{{', pos);

    if (start === -1) {
      pushText(top(), source.slice(pos));
      const unclosed = open.at(-1);

      if (unclosed) {
        fail(id, `unclosed {{${IF_PREFIX}${unclosed.flag}}} — every conditional needs its {{/if}}`);
      }

      return root;
    }

    const end = source.indexOf('}}', start + 2);

    if (end === -1) fail(id, `unclosed {{ at index ${start}`);
    pushText(top(), source.slice(pos, start));
    const name = source.slice(start + 2, end);
    pos = end + 2;

    if (name.startsWith(IF_PREFIX)) {
      const flag = name.slice(IF_PREFIX.length);

      if (!SLOT_PATTERN.test(flag)) {
        fail(id, `malformed flag "{{${name}}}" at index ${start} — a flag is `
          + `{{${IF_PREFIX}name}} with one space and no expression, matching ${SLOT_PATTERN.source}`);
      }

      open.push({ flag, whenTrue: [], whenFalse: [], branch: 'then' });
      continue;
    }

    if (name === 'else') {
      const block = open.at(-1);

      if (!block) fail(id, `{{else}} at index ${start} with no {{#if}} open`);

      if (block.branch === 'else') {
        fail(id, `a second {{else}} at index ${start} in {{${IF_PREFIX}${block.flag}}}`);
      }

      block.branch = 'else';
      continue;
    }

    if (name === '/if') {
      const block = open.pop();

      if (!block) fail(id, `{{/if}} at index ${start} with no {{#if}} open`);
      top().push({
        kind: 'if', flag: block.flag, whenTrue: block.whenTrue, whenFalse: block.whenFalse,
      });
      continue;
    }

    if (name.startsWith('#') || name.startsWith('/')) {
      // Named rather than "malformed slot": `{{#each}}` is a design decision, not a typo.
      fail(id, `unknown block tag "{{${name}}}" at index ${start} — `
        + `{{${IF_PREFIX}flag}} / {{else}} / {{/if}} are the only blocks; iteration stays in TypeScript`);
    }

    if (!SLOT_PATTERN.test(name)) {
      fail(id, `malformed slot "{{${name}}}" at index ${start} — `
        + `a slot is {{name}} with no spaces, matching ${SLOT_PATTERN.source}`);
    }

    top().push({ kind: 'slot', name });
  }
}

function supplied(values: SlotValues): string {
  const keys = Object.keys(values);

  return keys.length === 0 ? '(none)' : keys.join(', ');
}

/** Render in source order so output is byte-stable, keeping the cacheable prompt prefix intact. */
function renderNodes(
  id: string,
  nodes: readonly TemplateNode[],
  values: SlotValues,
  out: string,
): string {
  let acc = out;

  for (const node of nodes) {
    switch (node.kind) {
      case 'text':
        acc += node.text;
        break;
      case 'slot': {
        const value = values[node.name];

        if (value === undefined) {
          fail(id, `slot {{${node.name}}} has no value. Supplied: ${supplied(values)}`);
        }

        if (!v.is(TEXT_VALUE, value)) {
          fail(id, `slot {{${node.name}}} is a text slot but was given a boolean — `
            + `write {{${IF_PREFIX}${node.name}}} to branch on it`);
        }

        acc += value;
        break;
      }

      case 'if': {
        const value = values[node.flag];

        if (value === undefined) {
          fail(id, `flag {{${IF_PREFIX}${node.flag}}} has no value. Supplied: ${supplied(values)}`);
        }

        if (!v.is(FLAG_VALUE, value)) {
          fail(id, `flag {{${IF_PREFIX}${node.flag}}} is a boolean slot but was given a string — `
            + `write {{${node.flag}}} to substitute it`);
        }

        acc = renderNodes(id, value ? node.whenTrue : node.whenFalse, values, acc);
        break;
      }
    }
  }

  return acc;
}

/** `renderFrom` renders a replacement source (a promoted candidate) against the same slot contract, checked at runtime. */
export interface PromptSection<Source extends string> {
  readonly id: string;
  readonly source: string;
  render(slots: TemplateSlots<Source>): string;
  renderFrom(source: string, slots: TemplateSlots<Source>): string;
}

/**
 * Compile at module load so a malformed template throws on import. `renderFrom`
 * memoises one replacement per section: overrides change only on promotion,
 * so the cache cannot grow with traffic.
 */
export function definePromptSection<const Source extends string>(
  id: string,
  declaration: Source,
  source: string = declaration,
): PromptSection<Source> {
  const declared = templateContract(id, declaration);
  const used = templateContract(id, source);

  if (JSON.stringify(declared) !== JSON.stringify(used)) {
    fail(id, `source contract ${JSON.stringify(used)} differs from declaration ${JSON.stringify(declared)}`);
  }

  const compiled = compileTemplate(id, source);
  let override: { source: string; nodes: readonly TemplateNode[] } | null = null;

  return {
    id,
    source,
    render: (slots) => renderNodes(id, compiled, slots, ''),
    renderFrom: (replacement, slots) => {
      if (replacement === source) return renderNodes(id, compiled, slots, '');

      if (override?.source !== replacement) {
        override = { source: replacement, nodes: compileTemplate(id, replacement) };
      }

      return renderNodes(id, override.nodes, slots, '');
    },
  };
}

/** Sorted and deduped so two contracts compare by value. */
export interface TemplateContract {
  readonly slots: readonly string[];
  readonly flags: readonly string[];
}

/** Runtime slot/flag contract, for the gate comparing a promoted candidate against the compiled one. */
export function templateContract(id: string, source: string): TemplateContract {
  const slots = new Set<string>();
  const flags = new Set<string>();

  const walk = (nodes: readonly TemplateNode[]): void => {
    for (const node of nodes) {
      if (node.kind === 'slot') slots.add(node.name);
      else if (node.kind === 'if') {
        flags.add(node.flag);
        walk(node.whenTrue);
        walk(node.whenFalse);
      }
    }
  };

  walk(compileTemplate(id, source));

  return { slots: [...slots].sort(), flags: [...flags].sort() };
}
