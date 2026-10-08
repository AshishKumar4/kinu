/**
 * Blueprints: a committed slate version published with the namespaces it reaches as requirements, which the forker's own
 * workspace answers. Provider keys, MCP headers and vault ids never live in a slate tree, but pasted secrets can, so
 * inspection runs `secretSightings`.
 */
import { CompatRange, ContentRef } from '@agent-core/core';
import { BindingName, BindingRequirement, FacetPackageId } from '@agent-core/core/facets';
import { SlateId, SlatePublicationId, SlateSkeleton, SlateVersionId } from '@agent-core/core/slates';
import * as v from 'valibot';
import { Effect } from 'effect';
import { KinuError } from '../obs/error';
import { settle, settleSync } from '../obs/effect';
import { secretSightings, type SecretSighting } from '../safety/secret-patterns';
import { base64ToBytes, bytesToBase64 } from '../utils/base64';
import { nanoid } from '../utils/nanoid';
import type { WorkspaceSlateContentStore } from './content';
import { slateProject, slateTitle, type SlateProject } from './project';
import { namespaceHead, type SlateUsage } from './capability-graph';
import type { WorkspaceSlates } from './runtime';
import { type NewSlateShare, type ShareUser, type SlateShareStore } from './shares';
import {
  type BlueprintBundle, BlueprintBundleSchema, type BlueprintEntry, type BlueprintFork, type BlueprintInspection,
  type BlueprintView, type PublishedBlueprint, type SlateShareRecord,
} from './sharing';

const TreePath = v.pipe(v.string(), v.check((path) => path.split('/').every((part) => part !== '' && part !== '.' && part !== '..')));

const TreeEntry = v.variant('kind', [
  v.object({ path: TreePath, kind: v.literal('directory'), mode: v.number() }),
  v.object({ path: TreePath, kind: v.literal('file'), mode: v.number(), content: v.string() }),
  v.object({ path: TreePath, kind: v.literal('symlink'), target: v.string() }),
]);

/** The retained manifest shape; blueprint operations never read live source. */
const Tree = v.object({ mode: v.number(), entries: v.array(TreeEntry) });

type Tree = v.InferOutput<typeof Tree>;

type TreeEntry = v.InferOutput<typeof TreeEntry>;

/** One lowercase segment: `mcp.my_files` becomes `mcp.my-files`. */
const BLUEPRINT_FACET_PREFIX = 'kinu.slate.';

/** Each namespace once, in the order first called. */
function reachOf(usage: readonly SlateUsage[]): string[] {
  return [...new Set(usage.map((entry) => entry.namespace))];
}

const LITERAL = /^[a-z0-9]$/u;

/**
 * A namespace as agent-core's canonical binding name, reversibly: every character but a lowercase letter or digit is
 * `-` and its code point in six hex digits, and a `.` between two literals stays itself: `mcp.files` is itself, and
 * `mcp.My_Files` is `mcp-00002e-00004dy-00005f-000046iles`.
 */
function requirementName(namespace: string): string {
  const literal = (at: number) => LITERAL.test(namespace.charAt(at));

  return namespace.replace(/[^a-z0-9]/gu, (char: string, at: number) => (char === '.' && at > 0 && literal(at - 1) && literal(at + 1)
    ? char
    : `-${(char.codePointAt(0) ?? 0).toString(16).padStart(6, '0')}`));
}

/** The namespace a requirement names, as the slate's code calls it. */
function requirementNamespace(name: string): string {
  return name.replace(/-([0-9a-f]{6})/gu, (_code, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)));
}

/** A declaration, never a grant: the forked slate calls its forker's own surface, as its forker, by the same names. */
function blueprintRequirements(reaches: readonly string[]): Effect.Effect<BindingRequirement[], KinuError> {
  return Effect.forEach(reaches, (namespace) => (/^[a-z]/u.test(namespace)
    ? Effect.succeed(new BindingRequirement(
      new BindingName(requirementName(namespace)), new FacetPackageId(BLUEPRINT_FACET_PREFIX + namespaceHead(namespace)), CompatRange.any(),
    ))
    : Effect.fail(new KinuError('bad_input', `"${namespace}" cannot be published: a namespace a blueprint requires starts with a lowercase letter`))));
}

/** `package.json` always, plus every entry under an included top-level name. */
function includeTree(tree: Tree, included: readonly string[] | undefined): Tree {
  if (included === undefined) return tree;
  const names = new Set([...included, 'package.json']);

  return { mode: tree.mode, entries: tree.entries.filter((entry) => names.has(entry.path.split('/')[0])) };
}

function topLevelNames(tree: Tree): string[] {
  const names: string[] = [];

  for (const entry of tree.entries) {
    const name = entry.path.split('/')[0];

    if (!names.includes(name)) names.push(name);
  }

  return names;
}

export interface BlueprintHeading {
  readonly title: string;
  readonly description: string;
}

function heading(record: SlateShareRecord, project: SlateProject): BlueprintHeading {
  return { title: slateTitle(project, record.slate), description: project.description ?? '' };
}

export interface BlueprintReading {
  readonly record: SlateShareRecord;
  /** The page without its address: the app host signs the id. */
  readonly view: Omit<BlueprintView, 'id'>;
}

export interface WorkspaceBlueprintsDeps {
  readonly slates: WorkspaceSlates;
  readonly content: WorkspaceSlateContentStore;
  readonly shares: SlateShareStore;
  /** What a slate has called on its surface, as its owner ran it. */
  readonly usage: (slate: string) => readonly SlateUsage[];
}

export class WorkspaceBlueprints {
  constructor(private readonly deps: WorkspaceBlueprintsDeps) {}

  /** Reads only. */
  inspect(slate: string, version: string, included?: readonly string[]): BlueprintInspection {
    return settleSync(this.inspection(slate, version, included));
  }

  private inspection(slate: string, version: string, included?: readonly string[]): Effect.Effect<BlueprintInspection, KinuError> {
    return Effect.gen({ self: this }, function* () {
      const record = this.deps.slates.version(new SlateVersionId(version));

      if (!record.slateId.equals(new SlateId(slate))) return yield* new KinuError('missing', 'That version belongs to another slate');
      const tree = this.tree(record.source);
      const chosen = includeTree(tree, included);
      const project = yield* this.project(chosen);

      return {
        slate, version,
        title: slateTitle(project, slate),
        description: project.description ?? '',
        entries: this.entries(tree, chosen),
        reaches: reachOf(this.deps.usage(slate)),
        warnings: this.warnings(chosen),
      };
    });
  }

  /** Answers the inspection of exactly the published bytes. */
  async publish(slate: string, version: string, included?: readonly string[]): Promise<PublishedBlueprint> {
    return settle(Effect.gen({ self: this }, function* () {
      const inspection = yield* this.inspection(slate, version, included);
      const record = this.deps.slates.version(new SlateVersionId(version));
      const tree = includeTree(this.tree(record.source), included);
      // A subset is retained as its own bundle, so the skeleton names what ships.
      const bundle = included === undefined ? record.source : this.retainTree(tree);
      const requirements = yield* blueprintRequirements(inspection.reaches);
      const publication = yield* Effect.promise(() => this.deps.slates.publish(record.id, requirements, bundle));

      const row: NewSlateShare = {
        id: nanoid(), slate, publication: publication.id.value, included: topLevelNames(tree),
      };

      return { share: this.deps.shares.add(row), inspection };
    }));
  }

  unshare(share: string): SlateShareRecord {
    return this.deps.shares.revoke(share);
  }

  shareWith(share: string, users: readonly ShareUser[]): SlateShareRecord {
    return this.deps.shares.addUsers(share, users);
  }

  list(): SlateShareRecord[] {
    return this.deps.shares.list();
  }

  /** Refuses when revoked (S6). */
  read(share: string): BlueprintReading {
    return settleSync(Effect.map(this.published(share), ({ record, tree, project, reaches }) => ({
      record,
      view: {
        ...heading(record, project),
        reaches,
        entries: this.entries(tree, tree),
        warnings: this.warnings(tree),
        createdAt: record.createdAt,
      },
    })));
  }

  /** Without the entries and warnings, which read every file. */
  heading(share: string): BlueprintHeading {
    return settleSync(Effect.map(this.published(share), ({ record, project }) => heading(record, project)));
  }

  /** `reaches` is what the publication requires, fixed when it was published. */
  private published(share: string): Effect.Effect<{ record: SlateShareRecord; tree: Tree; project: SlateProject; reaches: string[] }, KinuError> {
    return Effect.gen({ self: this }, function* () {
      const record = this.deps.shares.live(share);
      const publication = this.deps.slates.publication(new SlatePublicationId(record.publication));
      const tree = this.tree(publication.materialization);
      const reaches = this.deps.slates.skeleton(publication.id).bindings.map((requirement) => requirementNamespace(requirement.name.value));

      return { record, tree, project: yield* this.project(tree), reaches };
    });
  }

  /** Re-reads the row, so a revoked blueprint refuses here too. */
  bundle(share: string): BlueprintBundle {
    const record = this.deps.shares.live(share);
    const publication = this.deps.slates.publication(new SlatePublicationId(record.publication));
    const skeleton = this.deps.slates.skeleton(publication.id);
    const tree = this.tree(publication.materialization);
    const blobs: Record<string, string> = {};

    for (const entry of tree.entries) {
      if (entry.kind === 'file' && blobs[entry.content] === undefined) {
        blobs[entry.content] = bytesToBase64(this.deps.content.read(new ContentRef(entry.content)));
      }
    }

    return v.parse(BlueprintBundleSchema, {
      skeleton: skeleton.toData(),
      tree: new TextDecoder().decode(this.deps.content.read(publication.materialization)),
      blobs,
    });
  }
  /** Live-share fork: the skeleton is built from the running slate's synchronized tree, never an included subset. */
  async liveBundle(slateId: string): Promise<BlueprintBundle> {
    return settle(Effect.gen({ self: this }, function* () {
      const slate = yield* Effect.promise(() => this.deps.slates.synchronize(new SlateId(slateId)));
      const tree = this.tree(slate.source);
      const skeleton = new SlateSkeleton(slate.source.digest, yield* blueprintRequirements(reachOf(this.deps.usage(slateId))));
      const blobs: Record<string, string> = {};

      for (const entry of tree.entries) {
        if (entry.kind === 'file' && blobs[entry.content] === undefined) {
          blobs[entry.content] = bytesToBase64(this.deps.content.read(new ContentRef(entry.content)));
        }
      }

      return v.parse(BlueprintBundleSchema, {
        skeleton: skeleton.toData(),
        tree: new TextDecoder().decode(this.deps.content.read(slate.source)),
        blobs,
      });
    }));
  }

  /** Proves the bytes match the skeleton and lands them with every requirement unsatisfied; starts no process. */
  async admit(workspace: string, input: BlueprintBundle): Promise<BlueprintFork> {
    return settle(Effect.gen({ self: this }, function* () {
      const bundle = v.parse(BlueprintBundleSchema, input);
      const skeleton = SlateSkeleton.fromData(bundle.skeleton);
      const tree = v.parse(Tree, JSON.parse(bundle.tree));

      for (const entry of tree.entries) {
        if (entry.kind !== 'file') continue;
        const encoded = bundle.blobs[entry.content];

        if (encoded === undefined) return yield* new KinuError('bad_input', `The blueprint names ${entry.path} but carries no bytes for it`);
        const retained = this.deps.content.retain(base64ToBytes(encoded));

        if (retained.ref.value !== entry.content) {
          return yield* new KinuError('bad_input', `The bytes for ${entry.path} are not the bytes the blueprint names`);
        }
      }

      const source = this.deps.content.retain(new TextEncoder().encode(bundle.tree)).ref;
      const project = yield* this.project(tree);
      const admitted = yield* Effect.promise(() => this.deps.slates.instantiate(skeleton, source));

      return {
        workspace,
        slate: admitted.slate.id.value,
        title: slateTitle(project, admitted.slate.id.value),
        requirements: admitted.unsatisfied.map((requirement) => ({ name: requirementNamespace(requirement.name.value), facet: requirement.facet.value })),
      };
    }));
  }

  private tree(source: ContentRef): Tree {
    return v.parse(Tree, JSON.parse(new TextDecoder().decode(this.deps.content.read(source))));
  }

  private retainTree(tree: Tree): ContentRef {
    return this.deps.content.retain(new TextEncoder().encode(JSON.stringify(tree))).ref;
  }

  private project(tree: Tree): Effect.Effect<SlateProject, KinuError> {
    const manifest = tree.entries.find((entry) => entry.path === 'package.json');

    if (manifest === undefined || manifest.kind !== 'file') return Effect.fail(new KinuError('bad_input', 'This version has no package.json'));

    return Effect.suspend(() => slateProject(JSON.parse(new TextDecoder().decode(this.deps.content.read(new ContentRef(manifest.content))))));
  }

  private entries(whole: Tree, chosen: Tree): BlueprintEntry[] {
    const included = new Set(chosen.entries.map((entry) => entry.path));

    return whole.entries.map((entry) => ({ path: entry.path, kind: entry.kind, included: included.has(entry.path) }));
  }

  /** Binary files (a NUL byte) are not decoded. */
  private warnings(tree: Tree): SecretSighting[] {
    const warnings: SecretSighting[] = [];

    for (const entry of tree.entries) {
      if (entry.kind !== 'file') continue;
      const bytes = this.deps.content.read(new ContentRef(entry.content));

      if (bytes.includes(0)) continue;
      warnings.push(...secretSightings(entry.path, new TextDecoder('utf8', { fatal: false }).decode(bytes)));
    }

    return warnings;
  }
}

export type { TreeEntry as BlueprintTreeEntry };
