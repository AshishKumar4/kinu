import * as v from 'valibot';
import { KinuError } from '../obs/error';
import { renderIssues } from '../utils/json';
import { SLATE_READ_MODELS } from './read-models';

const Name = v.pipe(v.string(), v.minLength(1));

const SourcePath = v.pipe(Name, v.check((path) => !path.startsWith('/') && !path.includes('\0') && !path.split('/').includes('..'), 'must name a file inside this Slate'));

const Binding = v.variant('kind', [
  v.strictObject({ kind: v.literal('namespace'), namespace: Name, members: v.optional(v.array(Name)) }),
  v.strictObject({ kind: v.literal('rpc'), methods: v.pipe(v.array(v.picklist(SLATE_READ_MODELS)), v.minLength(1)) }),
  v.strictObject({ kind: v.literal('mcp'), server: Name, tools: v.optional(v.array(Name)) }),
  v.strictObject({ kind: v.literal('app'), id: Name }),
  v.strictObject({ kind: v.literal('tool'), name: Name }),
  v.strictObject({ kind: v.literal('memory'), members: v.optional(v.array(Name)) }),
  v.strictObject({ kind: v.literal('tasks'), members: v.optional(v.array(Name)) }),
  v.strictObject({ kind: v.literal('web'), members: v.optional(v.array(Name)) }),
]);

const SlateMetadata = v.strictObject({
  runtime: v.optional(v.picklist(['worker', 'node']), 'worker'),
  port: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(65535))),
  title: v.optional(Name),
  bindings: v.optional(v.record(Name, Binding), () => ({})),
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
    throw new KinuError('bad_input', 'package.json main must name the Worker module that exports a fetch handler');
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
  }
}

/**
 * A binding that acts with the owner's connections or reads the owner's
 * workspace: `mcp`, `tool`, `web` and `namespace` spend the owner's
 * credentials; `memory`, `tasks` and `rpc` read the owner's data. An `app`
 * binding is credentialed exactly when its callee is, and the callee is another
 * slate's own declaration, so it is not counted here.
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
