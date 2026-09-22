// Self-update (docs/SELF-DEPLOY.md): the deployment pulls and reruns the same plan.
// Versions are never ordered; "behind" means "not the channel's build".
import * as v from 'valibot';
import { isSameBuild } from '../http/device-update';
import type { ReleaseManifest } from './manifest';

/** Fixed so reloads and retries join the running update; matches `DEPLOY_RUN_ID`. */
export const SELF_UPDATE_RUN_ID = 'self-update-0000';

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

/** `GET /api/health`: the stamp is under `build`, not top-level. */
export const HealthAnswerSchema = v.object({ build: v.nullable(UpdateBuildSchema), versionId: v.nullish(v.string()) });

/** `reason` is shown instead of the install button. */
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

/** `upToDate` requires both builds known, so a missing stamp cannot hide a failed asset deploy. */
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
