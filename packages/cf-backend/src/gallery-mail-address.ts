/** The address route as the gallery answers it, for setup's Mail step and the Mail page's empty state. */
import { mailUsernameRefusal } from "@kinu.run/core";
import type { MailUsername } from "@/lib/mail-api";

/** Names other accounts hold, so a frame can show one taken. */
const TAKEN: ReadonlySet<string> = new Set(["priya", "dana"]);

export function galleryUsername(username: string): MailUsername {
  const refusal = mailUsernameRefusal(username) ?? (TAKEN.has(username) ? "taken" : null);

  return { username, available: refusal === null, refusal };
}
