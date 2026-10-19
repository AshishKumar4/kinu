/**
 * The mail the assistant marked Important: what it is, who sent it, and the assistant's one-line reason. The Mail lane
 * (feat/mail) owns the route and the row; this is the read the shell's Mail icon and Home's Today make of it.
 */
import * as v from "valibot";
import { settle } from "@kinu.run/core/obs";
import { request } from "./http";

export const ImportantMailSchema = v.object({
  /** Opens `/mail?thread=<id>`. */
  thread: v.string(),
  from: v.object({ name: v.string(), address: v.string() }),
  /** The box it reached. */
  to: v.string(),
  subject: v.string(),
  /** Why the assistant marked it Important, in one line. */
  reason: v.string(),
  at: v.number(),
  unread: v.boolean(),
});

export type ImportantMail = v.InferOutput<typeof ImportantMailSchema>;

const ImportantSchema = v.object({ unread: v.number(), items: v.array(ImportantMailSchema) });

export type Important = v.InferOutput<typeof ImportantSchema>;

export function readImportantMail(limit: number): Promise<Important> {
  return settle(request(ImportantSchema, `/api/user/mail/important?limit=${String(limit)}`));
}
