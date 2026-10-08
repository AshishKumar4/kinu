/** `?frame=characters`: every chat mascot's colour, in every state its eyes carry, at the sizes the app draws them. */
import type { AgentActivity } from "@kinu.run/core";
import { ChatMascot, MASCOT_COLOURS, mascotSeed } from "@/components/Marks";

/** One chat per colour, named as a workspace names them. */
const COLOURS = Array.from({ length: MASCOT_COLOURS }, (_unused, colour) => ({ colour, seed: mascotSeed("gallery", `chat-${String(colour)}`) }));

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
