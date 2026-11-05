/** `/api/updates` (docs/SELF-DEPLOY.md § Updates): what the release channel offers this deployment, and the run that installs it. */
import { Effect } from "effect";
import * as v from "valibot";
import { DeploySnapshotSchema, UpdateOfferSchema, type DeploySnapshot, type UpdateOffer } from "@kinu.run/core/deploy";
import { settle } from "@kinu.run/core/obs";
import { ApiError, request, type HttpRequest } from "./http";

/** The routes answer 404 to everyone but the deployment's owner, so a 404 means the reader is someone else. */
export const NOT_OWNER = "Updates are installed by the person who deployed this Kinu. They see what is available here and install it.";

function read<Schema extends v.GenericSchema>(schema: Schema, path: string, init?: HttpRequest): Effect.Effect<v.InferOutput<Schema>> {
  return Effect.catchDefect(request(schema, path, init), (died) => Effect.die(died instanceof ApiError && died.status === 404 ? new Error(NOT_OWNER) : died));
}

export function readUpdateOffer(): Promise<UpdateOffer> {
  return settle(read(UpdateOfferSchema, "/api/updates"));
}

/** `apply` answers before the first step runs, so a page opened mid-update reads the ledger. */
export function readUpdateRun(): Promise<DeploySnapshot> {
  return settle(read(DeploySnapshotSchema, "/api/updates/run"));
}

export function applyUpdate(): Promise<DeploySnapshot> {
  return settle(read(DeploySnapshotSchema, "/api/updates/apply", { method: "POST" }));
}
