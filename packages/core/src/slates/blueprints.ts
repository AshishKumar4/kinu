/**
 * Forks: a slate's code with the namespaces it reaches as requirements, which the forker's own workspace answers. A fork
 * carries no lend, grant, person or state (`Confinement.lean`: `a_fork_starts_with_its_code_alone`). Provider keys, MCP
 * headers and vault ids never live in a slate tree.
 */
import { CompatRange, ContentRef } from '@agent-core/core';
import { BindingName, BindingRequirement, FacetPackageId } from '@agent-core/core/facets';
import { SlateId, SlateSkeleton } from '@agent-core/core/slates';
import * as v from 'valibot';
import { Effect } from 'effect';
import { KinuError } from '../obs/error';
import { settle } from '../obs/effect';
import { base64ToBytes, bytesToBase64 } from '../utils/base64';
import { secretSightings } from '../safety/secret-scan';
import { readRetainedTree, RetainedTreeSchema, type RetainedTree, type WorkspaceSlateContentStore } from './content';
import { slateProject, slateTitle, type SlateProject } from './project';
import { namespaceHead, type SlateUsage } from './capability-graph';
import type { WorkspaceSlates } from './runtime';
import { type BlueprintBundle, BlueprintBundleSchema, type BlueprintFork } from './sharing';

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

export interface WorkspaceBlueprintsDeps {
  readonly slates: WorkspaceSlates;
  readonly content: WorkspaceSlateContentStore;
  /** What a slate has called on its surface, as its owner ran it. */
  readonly usage: (slate: string) => readonly SlateUsage[];
}

export class WorkspaceBlueprints {
  constructor(private readonly deps: WorkspaceBlueprintsDeps) {}

  /** The slate's tree as it is now, retained: the version a publish names, so a fork gets that and nothing added since. */
  async currentSource(slateId: string): Promise<string> {
    return (await this.deps.slates.synchronize(new SlateId(slateId))).source.value;
  }

  /**
   * A fork's bundle of the version `source` names, the one its room published: files written since are not in it. A
   * version holding a secret is refused whole, as its room keeps its link off.
   */
  async bundleAt(slateId: string, source: string): Promise<BlueprintBundle> {
    return settle(Effect.gen({ self: this }, function* () {
      const ref = new ContentRef(source);
      const tree = readRetainedTree(this.deps.content, ref);
      const skeleton = new SlateSkeleton(ref.digest, yield* blueprintRequirements(reachOf(this.deps.usage(slateId))));
      const blobs: Record<string, string> = {};

      for (const entry of tree.entries) {
        if (entry.kind !== 'file' || blobs[entry.content] !== undefined) continue;
        const bytes = this.deps.content.read(new ContentRef(entry.content));
        const [secret] = bytes.includes(0) ? [] : secretSightings(entry.path, new TextDecoder('utf8', { fatal: false }).decode(bytes));

        if (secret !== undefined) return yield* new KinuError('denied', `${secret.path}:${String(secret.line)} holds ${secret.message}: this version cannot be forked`);
        blobs[entry.content] = bytesToBase64(bytes);
      }

      return v.parse(BlueprintBundleSchema, { skeleton: skeleton.toData(), tree: new TextDecoder().decode(this.deps.content.read(ref)), blobs });
    }));
  }

  /** Proves the bytes match the skeleton and lands them with every requirement unsatisfied; starts no process. */
  async admit(workspace: string, input: BlueprintBundle): Promise<BlueprintFork> {
    return settle(Effect.gen({ self: this }, function* () {
      const bundle = v.parse(BlueprintBundleSchema, input);
      const skeleton = SlateSkeleton.fromData(bundle.skeleton);
      const tree = v.parse(RetainedTreeSchema, JSON.parse(bundle.tree));

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

  private project(tree: RetainedTree): Effect.Effect<SlateProject, KinuError> {
    const manifest = tree.entries.find((entry) => entry.path === 'package.json');

    if (manifest === undefined || manifest.kind !== 'file') return Effect.fail(new KinuError('bad_input', 'This version has no package.json'));

    return Effect.suspend(() => slateProject(JSON.parse(new TextDecoder().decode(this.deps.content.read(new ContentRef(manifest.content))))));
  }
}
