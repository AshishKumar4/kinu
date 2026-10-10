/**
 * `?frame=characters`: every chat mascot's colour and what it wears, in every state its eyes carry, at the sizes the
 * app draws them. The first is Main, in the crown; then one agent in each accessory, then agents as their seeds fall.
 */
import type { AgentActivity } from "@kinu.run/core";
import { ChatMascot, mascotAccessory, mascotColour, mascotSeed, type MascotAccessory } from "@/components/Marks";

/** The first agents of a workspace in birth order, past where a palette of twelve repeated: none shares a colour. */
const RANKS = 24;

const WORN: readonly (MascotAccessory | null)[] = ["party", "beanie", "tophat", "cap", "bow", "headphones", "glasses", "flower", null];

/** The first `gallery/pick-N` seed that wears `accessory`: the sheet shows each one, drawn by the app's own pick. */
function wearing(accessory: MascotAccessory | null): string {
  for (let pick = 0; ; pick += 1) {
    const seed = mascotSeed("gallery", `pick-${String(pick)}`);

    if (mascotAccessory(seed) === accessory) return seed;
  }
}

const SEEDS = [mascotSeed("gallery", "main"), ...WORN.map(wearing)];

const COLOURS = Array.from({ length: RANKS }, (_unused, rank) => ({
  colour: mascotColour("gallery", rank), seed: SEEDS[rank] ?? mascotSeed("gallery", `chat-${String(rank)}`),
}));

const STATES = ["idle", "working", "waiting", "failed", "done"] as const satisfies readonly AgentActivity[];

export function CharactersFrame() {
  return (
    <div className="p-bg min-h-screen p-6 space-y-6">
      {[16, 32].map((size) => (
        <section key={size} className="space-y-3" data-mascot-size={size}>
          {STATES.map((state) => (
            <div key={state} className="flex flex-wrap items-center gap-3" data-mascot-state={state}>
              <span className="w-20 p-meta p-text-3">{state}</span>
              {COLOURS.map(({ colour, seed }) => <ChatMascot key={seed} seed={seed} colour={colour} activity={state} size={size} />)}
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}
