/** `?frame=characters`: every chat mascot's colour, in every state its eyes carry, at the sizes the app draws them. */
import type { AgentActivity } from "@kinu.run/core";
import { ChatMascot, mascotColour, mascotSeed } from "@/components/Marks";

/** The first agents of a workspace in birth order, past where a palette of twelve repeated: none shares a colour. */
const RANKS = 24;

const COLOURS = Array.from({ length: RANKS }, (_unused, rank) => ({
  colour: mascotColour("gallery", rank), seed: mascotSeed("gallery", `chat-${String(rank)}`),
}));

const STATES = ["idle", "working", "waiting", "failed", "done"] as const satisfies readonly AgentActivity[];

export function CharactersFrame() {
  return (
    <div className="p-bg min-h-screen p-6 space-y-6">
      {[16, 32].map((size) => (
        <section key={size} className="space-y-3" data-mascot-size={size}>
          {STATES.map((state) => (
            <div key={state} className="flex items-center gap-3" data-mascot-state={state}>
              <span className="w-20 p-meta p-text-3">{state}</span>
              {COLOURS.map(({ colour, seed }) => <ChatMascot key={seed} seed={seed} colour={colour} activity={state} size={size} />)}
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}
