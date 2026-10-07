/** `?frame=characters`: every chat mascot's colour, in every state its eyes carry, at the sizes the app draws them. */
import type { AgentActivity } from "@kinu.run/core";
import { ChatMascot, MASCOT_COLOURS, mascotColour, mascotSeed } from "@/components/Marks";

/** The first chat, named as a workspace names them, to land on each colour. */
function seedPerColour(): string[] {
  const seeds = new Map<number, string>();

  for (let index = 0; seeds.size < MASCOT_COLOURS; index += 1) {
    const seed = mascotSeed("gallery", `chat-${String(index)}`);

    if (!seeds.has(mascotColour(seed))) seeds.set(mascotColour(seed), seed);
  }

  return [...seeds.entries()].sort(([a], [b]) => a - b).map(([, seed]) => seed);
}

const SEEDS = seedPerColour();

const STATES = ["idle", "working", "waiting", "failed", "done"] as const satisfies readonly AgentActivity[];

export function CharactersFrame() {
  return (
    <div className="p-bg min-h-screen p-6 space-y-6">
      {[16, 32].map((size) => (
        <section key={size} className="space-y-3" data-mascot-size={size}>
          {STATES.map((state) => (
            <div key={state} className="flex items-center gap-3" data-mascot-state={state}>
              <span className="w-20 p-meta p-text-3">{state}</span>
              {SEEDS.map((seed) => <ChatMascot key={seed} seed={seed} activity={state} size={size} />)}
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}
