/**
 * Who is in a shared slate with you: an avatar each, ringed in their own colour, then "+3 viewing" for the people who
 * view it signed out. Signed-out visitors change nothing, so they are counted, never named (security §2.5).
 */
import { Avatar, presenceColor } from "@/components/ui/Avatar";

export function Presence({ here, viewing }: { here: readonly string[]; viewing: number }) {
  if (here.length === 0 && viewing === 0) return null;

  return (
    <span data-presence className="flex items-center gap-2" aria-label={here.length > 0 ? `Here: ${here.join(", ")}` : undefined}>
      {here.map((name) => (
        <span key={name} title={name} className="flex rounded-full" style={{ outline: `2px solid ${presenceColor(name)}`, outlineOffset: 1.5 }}>
          <Avatar name={name} size={22} />
        </span>
      ))}
      {viewing > 0 && (
        <span data-presence-viewing={viewing} title={viewing === 1 ? "1 person signed out" : `${String(viewing)} people signed out`} className="whitespace-nowrap p-meta p-text-3">
          {here.length > 0 ? "+" : ""}{viewing} viewing
        </span>
      )}
    </span>
  );
}
