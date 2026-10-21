/** A value to copy whole, a key or a command (docs/DESIGN-SYSTEM.md §2): mono in a sunken well, with its copy control. */
import { ClipboardText } from "@cloudflare/kumo";

export function CopyField({ value, what }: { value: string; what: string }) {
  return <ClipboardText text={value} className="p-copy-field" labels={{ copyAction: `Copy ${what}` }} />;
}
