/**
 * Blueprints: a committed slate version published with every binding unmapped. Provider keys, MCP headers
 * and vault ids never live in a slate tree, but pasted secrets can, so inspection runs `secretSightings`.
 */
import { CompatRange, ContentRef } from '@agent-core/core';
import { BindingName, BindingRequirement, FacetPackageId } from '@agent-core/core/facets';
import { SlateId, SlatePublicationId, SlateSkeleton, SlateVersionId } from '@agent-core/core/slates';
import * as v from 'valibot';
import { KinuError } from '../obs/error';
import { secretSightings, type SecretSighting } from '../safety/secret-patterns';
import { base64ToBytes, bytesToBase64 } from '../utils/base64';
import { nanoid } from '../utils/nanoid';
import type { WorkspaceSlateContentStore } from './content';
import { credentialedBindings, describeBindings, parseSlateProject, type SlateBindingDeclaration, type SlateProject } from './project';
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

/** One lowercase segment: `GITHUB`/`my_files` become `github`/`my-files`; `package.json` keeps the authored spelling. */
const CANONICAL_BINDING_NAME = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u;

const BLUEPRINT_FACET_PREFIX = 'kinu.slate.';

function canonicalBindingName(name: string): string {
  const canonical = name.toLowerCase().replace(/_/g, '-');

  if (!CANONICAL_BINDING_NAME.test(canonical)) {
    throw new KinuError('bad_input', `Binding "${name}" cannot be published: a requirement name is letters, digits, "." and "-", starting with a letter`);
  }

  return canonical;
}

/** A declaration, never a grant: the forker maps each requirement before the slate runs. */
function blueprintRequirements(project: SlateProject): BindingRequirement[] {
  const requirements: BindingRequirement[] = [];
  const seen: Record<string, string> = {};

  for (const declaration of describeBindings(project)) {
    const canonical = canonicalBindingName(declaration.name);
    const other = seen[canonical];

    if (other !== undefined) throw new KinuError('bad_input', `Bindings "${other}" and "${declaration.name}" would publish as the same requirement "${canonical}"`);
    seen[canonical] = declaration.name;
    requirements.push(new BindingRequirement(new BindingName(canonical), new FacetPackageId(BLUEPRINT_FACET_PREFIX + declaration.kind), CompatRange.any()));
  }

  return requirements;
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

export interface BlueprintReading {
  readonly record: SlateShareRecord;
  /** The page without its address: the app host signs the id. */
  readonly view: Omit<BlueprintView, 'id'>;
}

export interface WorkspaceBlueprintsDeps {
  readonly slates: WorkspaceSlates;
  readonly content: WorkspaceSlateContentStore;
  readonly shares: SlateShareStore;
}

export class WorkspaceBlueprints {
  constructor(private readonly deps: WorkspaceBlueprintsDeps) {}

  /** Reads only. */
  inspect(slate: string, version: string, included?: readonly string[]): BlueprintInspection {
    const record = this.deps.slates.version(new SlateVersionId(version));

    if (!record.slateId.equals(new SlateId(slate))) throw new KinuError('missing', 'That version belongs to another slate');
    const tree = this.tree(record.source);
    const chosen = includeTree(tree, included);
    const project = this.project(chosen);

    return {
      slate, version,
      title: project.slate.title ?? project.name ?? slate,
      description: project.description ?? '',
      entries: this.entries(tree, chosen),
      bindings: describeBindings(project),
      credentialed: credentialedBindings(project),
      warnings: this.warnings(chosen),
    };
  }

  /** Answers the inspection of exactly the published bytes. */
  async publish(slate: string, version: string, included?: readonly string[]): Promise<PublishedBlueprint> {
    const inspection = this.inspect(slate, version, included);
    const record = this.deps.slates.version(new SlateVersionId(version));
    const tree = includeTree(this.tree(record.source), included);
    // A subset is retained as its own bundle so the skeleton names exactly what ships.
    const bundle = included === undefined ? record.source : this.retainTree(tree);
    const publication = await this.deps.slates.publish(record.id, blueprintRequirements(this.project(tree)), bundle);

    const row: NewSlateShare = {
      id: nanoid(), slate, kind: 'blueprint', publication: publication.id.value, included: topLevelNames(tree),
    };

    return { share: this.deps.shares.add(row), inspection };
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
    const record = this.deps.shares.live(share);
    const publication = this.deps.slates.publication(new SlatePublicationId(record.publication));
    const tree = this.tree(publication.materialization);
    const project = this.project(tree);

    return {
      record,
      view: {
        title: project.slate.title ?? project.name ?? record.slate,
        description: project.description ?? '',
        bindings: describeBindings(project),
        credentialed: credentialedBindings(project),
        entries: this.entries(tree, tree),
        warnings: this.warnings(tree),
        createdAt: record.createdAt,
      },
    };
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
    const slate = await this.deps.slates.synchronize(new SlateId(slateId));
    const tree = this.tree(slate.source);
    const project = this.project(tree);
    const skeleton = new SlateSkeleton(slate.source.digest, blueprintRequirements(project));
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
  }

  /** Proves the bytes match the skeleton and lands them with every requirement unsatisfied; starts no process. */
  async admit(workspace: string, input: BlueprintBundle): Promise<BlueprintFork> {
    const bundle = v.parse(BlueprintBundleSchema, input);
    const skeleton = SlateSkeleton.fromData(bundle.skeleton);
    const tree = v.parse(Tree, JSON.parse(bundle.tree));

    for (const entry of tree.entries) {
      if (entry.kind !== 'file') continue;
      const encoded = bundle.blobs[entry.content];

      if (encoded === undefined) throw new KinuError('bad_input', `The blueprint names ${entry.path} but carries no bytes for it`);
      const retained = this.deps.content.retain(base64ToBytes(encoded));

      if (retained.ref.value !== entry.content) throw new KinuError('bad_input', `The bytes for ${entry.path} are not the bytes the blueprint names`);
    }

    const source = this.deps.content.retain(new TextEncoder().encode(bundle.tree)).ref;
    const project = this.project(tree);
    const admitted = await this.deps.slates.instantiate(skeleton, source);

    return {
      workspace,
      slate: admitted.slate.id.value,
      title: project.slate.title ?? project.name ?? admitted.slate.id.value,
      requirements: admitted.unsatisfied.map((requirement) => ({ name: requirement.name.value, facet: requirement.facet.value })),
      bindings: describeBindings(project),
    };
  }

  private tree(source: ContentRef): Tree {
    return v.parse(Tree, JSON.parse(new TextDecoder().decode(this.deps.content.read(source))));
  }

  private retainTree(tree: Tree): ContentRef {
    return this.deps.content.retain(new TextEncoder().encode(JSON.stringify(tree))).ref;
  }

  private project(tree: Tree): SlateProject {
    const manifest = tree.entries.find((entry) => entry.path === 'package.json');

    if (manifest === undefined || manifest.kind !== 'file') throw new KinuError('bad_input', 'This version has no package.json');

    return parseSlateProject(JSON.parse(new TextDecoder().decode(this.deps.content.read(new ContentRef(manifest.content)))));
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

export type { SlateBindingDeclaration, TreeEntry as BlueprintTreeEntry };
