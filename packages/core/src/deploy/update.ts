/**
 * A deployment updating itself (docs/SELF-DEPLOY.md § Updates).
 *
 * THE DEPLOYMENT PULLS. kinu.run publishes `release.json` and never reaches
 * into anybody's account after the first sitting, so what an update is, is a
 * deployment reading the channel, comparing it to the build it is serving, and
 * running THE SAME PLAN from inside itself with its own token. There is no
 * second uploader and no update-shaped subset of the plan: every step already
 * looks before it creates, which is what makes a second run of the whole plan
 * an update.
 *
 * NOTHING HERE ORDERS VERSIONS, the same rule `http/device-update.ts` states
 * for a CLI and a daemon: `0.4.0+aaa` and `0.4.0+bbb` are different builds of
 * one semver, and the build the channel publishes is by definition the build to
 * run. So "behind" means "not the channel's build", and `isSameBuild` is the
 * one comparison.
 */
import * as v from 'valibot';
import { isSameBuild } from '../http/device-update';
import type { ReleaseManifest } from './manifest';

/**
 * The run id the self-update ledger lives under.
 *
 * Fixed rather than minted: a deployment has one update at a time, and a
 * reload, a second tab and a retry must all find the run that is already going
 * rather than start a parallel upload of the same version. Sixteen characters
 * of the run-id alphabet, so the same `DEPLOY_RUN_ID` shape admits it.
 */
export const SELF_UPDATE_RUN_ID = 'self-update-0000';

/** A build, as both the deployment's own stamp and the channel's manifest
 *  name one. */
export interface UpdateBuild {
  readonly version: string;
  readonly sha: string;
  readonly builtAt: string;
}

const UpdateBuildSchema: v.GenericSchema<UpdateBuild> = v.object({
  version: v.string(),
  sha: v.string(),
  builtAt: v.string(),
});

/**
 * What `GET /api/health` answers about the build it is: the stamp under
 * `build`, or `null` on an instance whose assets carry no stamp
 * (`core/src/http/health-route.ts`). Both doors read a fresh instance through
 * this and nothing else; measured 2026-09-21, each read `version` at the top
 * level instead and called every real instance foreign or unstamped, which is
 * why no door deployment had ever passed its own smoke step.
 */
export const HealthAnswerSchema = v.object({ build: v.nullable(UpdateBuildSchema) });

/**
 * What the Updates page is told.
 *
 * `installable` is false for two different reasons and the page says which:
 * a deployment that was not installed by the flow holds no record and no key
 * of its own, and a channel that cannot be read offers nothing. Either way
 * `reason` is the sentence shown instead of a button.
 */
export interface UpdateOffer {
  readonly current: UpdateBuild | null;
  readonly available: UpdateBuild | null;
  readonly channelOrigin: string;
  readonly upToDate: boolean;
  readonly installable: boolean;
  readonly reason: string;
}

export const UpdateOfferSchema: v.GenericSchema<UpdateOffer> = v.object({
  current: v.nullable(UpdateBuildSchema),
  available: v.nullable(UpdateBuildSchema),
  channelOrigin: v.string(),
  upToDate: v.boolean(),
  installable: v.boolean(),
  reason: v.string(),
});

export function buildOf(manifest: ReleaseManifest): UpdateBuild {
  return { version: manifest.version, sha: manifest.sha, builtAt: manifest.builtAt };
}

/**
 * The offer, from the two builds and whether this deployment owns a key.
 *
 * `upToDate` is only ever true when both builds are known: a deployment that
 * cannot read its own stamp does not know it is current, and saying so would
 * be the one answer that hides a failed asset half of a deploy.
 */
export function updateOffer(input: {
  readonly current: UpdateBuild | null;
  readonly available: UpdateBuild | null;
  readonly channelOrigin: string;
  readonly owned: boolean;
}): UpdateOffer {
  const { current, available, channelOrigin, owned } = input;
  const upToDate = current !== null && available !== null && isSameBuild(current.version, available.version);

  return {
    current,
    available,
    channelOrigin,
    upToDate,
    installable: owned && available !== null && !upToDate,
    reason: reasonFor({ current, available, owned, upToDate }),
  };
}

function reasonFor(state: {
  readonly current: UpdateBuild | null;
  readonly available: UpdateBuild | null;
  readonly owned: boolean;
  readonly upToDate: boolean;
}): string {
  if (state.current === null) {
    return 'This deployment serves no build stamp, so what it is running cannot be read.';
  }

  if (state.available === null) {
    return 'The release channel could not be read, so there is nothing to compare against.';
  }

  if (!state.owned) {
    return 'This Kinu was not installed by the self-deploy flow, so it holds no key of its own '
      + 'to update itself with.';
  }

  return state.upToDate ? 'This is the build the channel publishes.' : '';
}
