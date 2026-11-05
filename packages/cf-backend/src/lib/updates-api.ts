/** `/api/updates` (docs/SELF-DEPLOY.md § Updates): what the release channel offers this deployment, and the run that installs it. */
import { Effect } from "effect";
import * as v from "valibot";
import { DeploySnapshotSchema, UpdateOfferSchema, type DeploySnapshot, type UpdateOffer } from "@kinu.run/core/deploy";
import { settle } from "@kinu.run/core/obs";
import { ApiError, request } from "./http";

/**
 * The routes answer 404 to everyone but the deployment's owner, and everywhere on a deployment that installs no updates
 * of its own (kinu.run): either way there is no page here for this reader, which a read answers as null.
 */
function readOwned<Schema extends v.GenericSchema>(schema: Schema, path: string): Effect.Effect<v.InferOutput<Schema> | null> {
  return Effect.catchDefect(request(schema, path), (died) => (died instanceof ApiError && died.status === 404 ? Effect.succeed(null) : Effect.die(died)));
}

export function readUpdateOffer(): Promise<UpdateOffer | null> {
  return settle(readOwned(UpdateOfferSchema, "/api/updates"));
}

/** `apply` answers before the first step runs, so a page opened mid-update reads the ledger. */
export function readUpdateRun(): Promise<DeploySnapshot | null> {
  return settle(readOwned(DeploySnapshotSchema, "/api/updates/run"));
}

export function applyUpdate(): Promise<DeploySnapshot> {
  return settle(request(DeploySnapshotSchema, "/api/updates/apply", { method: "POST" }));
}
