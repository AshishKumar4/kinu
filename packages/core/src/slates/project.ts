import * as v from 'valibot';
import { KinuError } from '../obs/error';
import { TierIdSchema } from '../types/profile';
import { renderIssues } from '../utils/json';
import { SLATE_INLINE_HEIGHT } from './host-context';
import { SLATE_READ_MODELS } from './read-models';

const Name = v.pipe(v.string(), v.minLength(1));

const SourcePath = v.pipe(Name, v.check((path) => !path.startsWith('/') && !path.includes('\0') && !path.split('/').includes('..'), 'must name a file inside this Slate'));

const Binding = v.variant('kind', [
  v.pipe(
    v.strictObject({ kind: v.literal('namespace'), namespace: Name, members: v.optional(v.array(Name)), paths: v.optional(v.array(Name)) }),
    v.check((binding) => binding.paths === undefined || binding.namespace === 'workspace', 'paths scope only a workspace namespace binding'),
  ),
  v.strictObject({ kind: v.literal('rpc'), methods: v.pipe(v.array(v.picklist(SLATE_READ_MODELS)), v.minLength(1)) }),
  v.strictObject({ kind: v.literal('mcp'), server: Name, tools: v.optional(v.array(Name)) }),
  v.strictObject({ kind: v.literal('app'), id: Name }),
  v.strictObject({ kind: v.literal('tool'), name: Name }),
  v.strictObject({ kind: v.literal('memory'), members: v.optional(v.array(Name)) }),
  v.strictObject({ kind: v.literal('tasks'), members: v.optional(v.array(Name)) }),
  v.strictObject({ kind: v.literal('web'), members: v.optional(v.array(Name)) }),
  v.strictObject({ kind: v.literal('agent') }),
  v.strictObject({ kind: v.literal('ai'), tier: v.optional(TierIdSchema) }),
]);

const SlateMetadata = v.strictObject({
  runtime: v.optional(v.picklist(['worker', 'node']), 'worker'),
  port: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(65535))),
  title: v.optional(Name),
  bindings: v.optional(v.record(Name, Binding), () => ({})),
  inline: v.optional(v.strictObject({
    height: v.optional(v.pipe(v.number(), v.integer(), v.minValue(SLATE_INLINE_HEIGHT.min), v.maxValue(SLATE_INLINE_HEIGHT.max)), SLATE_INLINE_HEIGHT.default),
  }), () => ({ height: SLATE_INLINE_HEIGHT.default })),
});

const Project = v.object({
  name: v.optional(Name),
  description: v.optional(v.string()),
  main: v.optional(SourcePath),
  browser: v.optional(SourcePath),
  scripts: v.optional(v.object({ dev: v.optional(Name), start: v.optional(Name), build: v.optional(Name) })),
  slate: v.optional(SlateMetadata, () => ({ runtime: 'worker', bindings: {} })),
});

export type SlateProject = v.InferOutput<typeof Project>;

export type SlateBinding = v.InferOutput<typeof Binding>;

export function parseSlateProject<Input>(input: Input): SlateProject {
  const parsed = v.safeParse(Project, input);

  if (!parsed.success) throw new KinuError('bad_input', `package.json: ${renderIssues(parsed.issues)}`);
  const project = parsed.output;

  if (project.slate.runtime === 'worker' && project.main === undefined) {
    throw new KinuError('bad_input', 'package.json main must name the module that exports class Slate extends SlateObject from kinu:slate');
  }

  if (project.slate.runtime === 'node') {
    if (project.slate.port === undefined) throw new KinuError('bad_input', 'package.json slate.port must name the server port');

    if (project.scripts?.dev === undefined && project.scripts?.start === undefined) {
      throw new KinuError('bad_input', 'package.json scripts.dev or scripts.start must start the server');
    }
  }

  return project;
}

export type SlateBindingKind = SlateBinding['kind'];

/** Every binding kind the variant admits, in declaration order, read off the
 *  variant itself so a kind added there reaches every schema that lists
 *  kinds. An option wrapped in a pipe (the workspace namespace carries a
 *  check) is read through its first schema. */
export const SLATE_BINDING_KINDS: readonly SlateBindingKind[] = Binding.options.map(
  (option) => ('pipe' in option ? option.pipe[0] : option).entries.kind.literal,
);

/** One declared binding as a page or a forker reads it: its name, its kind and
 *  what it names on the other side. `credentialed` is the section-3 rule. */
export interface SlateBindingDeclaration {
  readonly name: string;
  readonly kind: SlateBindingKind;
  /** The server, tool, namespace, slate or member list the binding names. */
  readonly target: string;
  readonly credentialed: boolean;
}

/** What one binding reaches on the other side, for a reader. */
function bindingTarget(binding: SlateBinding): string {
  switch (binding.kind) {
    case 'namespace': return binding.namespace;
    case 'rpc': return binding.methods.join(', ');
    case 'mcp': return binding.server;
    case 'app': return binding.id;
    case 'tool': return binding.name;
    case 'memory':
    case 'tasks':
    case 'web': return binding.members?.join(', ') ?? '';
    case 'agent': return 'send';
    case 'ai': return binding.tier ?? 'default';
  }
}

/**
 * A binding that acts with the owner's connections or reads the owner's
 * workspace: `mcp`, `tool`, `web` and `namespace` spend the owner's
 * credentials; `memory`, `tasks` and `rpc` read the owner's data; `agent`
 * reaches the owner's own agent and `ai` runs on the owner's model access. An
 * `app` binding is credentialed exactly when its callee is, and the callee is
 * another slate's own declaration, so it is not counted here.
 */
function isCredentialedBinding(binding: SlateBinding): boolean {
  return binding.kind !== 'app';
}

/** Every declared binding, in declaration order. */
export function describeBindings(project: SlateProject): SlateBindingDeclaration[] {
  return Object.entries(project.slate.bindings).map(([name, binding]) => ({
    name, kind: binding.kind, target: bindingTarget(binding), credentialed: isCredentialedBinding(binding),
  }));
}

/** The bindings a viewer or a forker must be told about (S4): non-empty exactly
 *  when the slate reaches something of the owner's. */
export function credentialedBindings(project: SlateProject): SlateBindingDeclaration[] {
  return describeBindings(project).filter((binding) => binding.credentialed);
}
