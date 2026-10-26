// The computer's steps (docs/SELF-DEPLOY-FLOW.md § 7): its tools copied into the store bucket, its registry token minted,
// and its container application made on the class's namespace. A deployment without the computer runs none of them.
import { Effect } from 'effect';
import * as v from 'valibot';
import type { KinuError } from '../obs/index';
import { cloudflareResult, readEnvelope } from './cloudflare';
import type { DeployContext } from './context';
import { instanceToken } from './instance-token';
import { REGISTRY_TOKEN_SECRET, resourceName } from './inputs';
import { devboxToolsPath, type ReleaseComputer, type ReleaseManifest } from './manifest';
import type { DeployStep } from './steps';

/** The permission the computer's snapshots are deleted with (`packages/devbox` snapshot registry; DEPLOYMENT.md). */
const CONTAINERS_WRITE = 'Workers Containers Write';

const IdSchema = v.object({ id: v.string() });

const NamespaceSchema = v.object({ id: v.string(), script: v.optional(v.nullable(v.string())), class: v.optional(v.nullable(v.string())) });

/** What the step answers when the deployment runs without the computer, or its release names none. */
function absent(context: DeployContext, manifest: ReleaseManifest): string | null {
  if (!context.inputs.sandbox) return 'This deployment runs without the computer.';

  return manifest.computer === null ? 'This release names no computer to deploy.' : null;
}

/** Its parts from the channel into the store bucket, each carried through unheld; a part already there stays. */
export function computerToolsStep(manifest: ReleaseManifest): DeployStep {
  return {
    id: 'computer-tools',
    title: "Copy the computer's tools",
    after: ['r2'],
    run(context: DeployContext): Effect.Effect<string, KinuError> {
      return Effect.gen(function* () {
        const skipped = absent(context, manifest);

        if (skipped !== null || manifest.computer === null) return skipped ?? '';
        const computer = manifest.computer;
        const binding = manifest.bindings.find((entry) => entry.binding === computer.bucket);

        if (binding === undefined) return yield* Effect.die(new Error(`the release binds no ${computer.bucket} for the computer's tools`));
        const bucket = resourceName(context.inputs, binding.resource);
        let copied = 0;

        for (const [index, part] of computer.tools.parts.entries()) {
          const path = `/accounts/${context.inputs.accountId}/r2/buckets/${bucket}/objects/${part.key}`;
          const held = yield* Effect.promise(async () => context.transport.request({ method: 'HEAD', path }));

          if (held.status >= 200 && held.status < 300) continue;
          context.note(`Copying the computer's tools, part ${String(index + 1)} of ${String(computer.tools.parts.length)}.`);
          yield* copyPart(context, computer, part.key, path);
          copied += 1;
        }

        return `${String(copied)} of ${String(computer.tools.parts.length)} tools part(s) copied into ${bucket}; the rest were there.`;
      });
    },
  };
}

function copyPart(context: DeployContext, computer: ReleaseComputer, key: string, path: string): Effect.Effect<void, KinuError> {
  return Effect.gen(function* () {
    const source = `${context.manifest.channelOrigin}${devboxToolsPath(key)}`;
    const part = computer.tools.parts.find((entry) => entry.key === key);
    const answer = yield* Effect.promise(async () => context.http(source));

    if (!answer.ok || answer.body === null || part === undefined) {
      return yield* Effect.die(new Error(`the computer's tools at ${source} answered HTTP ${String(answer.status)}`));
    }

    const body = answer.body;
    const stored = yield* Effect.promise(async () => context.transport.put({ path, body, bytes: part.bytes }));

    readEnvelope(path, stored, v.looseObject({}));
  });
}

/** An account-owned token that may write the account's containers, so the computer deletes the snapshots it no longer
 *  wakes; minted here, never asked of the person, and rolled when a run lost the one it minted. */
export function computerTokenStep(manifest: ReleaseManifest): DeployStep {
  return {
    id: 'computer-token',
    title: "Mint the computer's registry token",
    after: ['account'],
    run(context: DeployContext): Effect.Effect<string, KinuError> {
      return Effect.gen(function* () {
        const skipped = absent(context, manifest);

        if (skipped !== null) return skipped;

        // An update keeps the running version's (`keep_bindings`).
        if (context.update) return 'The running version keeps its registry token.';
        const name = `${context.inputs.instanceName} computer (Kinu)`;

        const outcome = yield* instanceToken(context, {
          name, permission: CONTAINERS_WRITE, resource: `com.cloudflare.api.account.${context.inputs.accountId}`, secret: REGISTRY_TOKEN_SECRET,
        });

        if (outcome === 'kept') return 'The registry token is minted.';

        return outcome === 'minted' ? `Minted "${name}", which may write this account's containers.` : `Rolled "${name}": this run had lost its value.`;
      });
    },
  };
}

/** The container application on the class's namespace, as Wrangler makes one with no image: Cloudflare runs its managed
 *  image (D55). Found by the namespace, so a second sitting makes none. */
export function computerStep(manifest: ReleaseManifest): DeployStep {
  return {
    id: 'computer',
    title: 'Set up the computer',
    after: ['upload', 'computer-tools'],
    run(context: DeployContext): Effect.Effect<string, KinuError> {
      return Effect.gen(function* () {
        const skipped = absent(context, manifest);

        if (skipped !== null || manifest.computer === null) return skipped ?? '';
        const account = context.inputs.accountId;
        const className = manifest.computer.className;

        const namespaces = yield* Effect.promise(async () => cloudflareResult(
          context.transport, { method: 'GET', path: `/accounts/${account}/workers/durable_objects/namespaces?per_page=1000` }, v.array(NamespaceSchema),
        ));

        const namespace = namespaces.find((entry) => entry.script === context.inputs.instanceName && entry.class === className);

        if (namespace === undefined) return yield* Effect.die(new Error(`the upload made no ${className} namespace for ${context.inputs.instanceName}`));
        const path = `/accounts/${account}/containers/applications`;
        const held = yield* Effect.promise(async () => context.transport.request({ method: 'GET', path: `${path}/${namespace.id}` }));

        if (held.status >= 200 && held.status < 300) return `The computer's application is set up on ${namespace.id}.`;
        const name = `${context.inputs.instanceName}-${className}`.toLowerCase();

        yield* Effect.promise(async () => cloudflareResult(
          context.transport,
          { method: 'POST', path, body: { name, scheduling_policy: 'durable_object', durable_objects: { namespace_id: namespace.id } } },
          IdSchema,
        ));

        return `Made the computer's application ${name} on ${namespace.id}.`;
      });
    },
  };
}
