/** `?frame=characters`: every chat mascot's colour, in every state its eyes carry, at the sizes the app draws them. */
import type { AgentActivity } from "@kinu.run/core";
import { ChatMascot, mascotSeed } from "@/components/Marks";

/** One seed per colour the hash lands on in practice: chats named as a workspace names them. */
const SEEDS = Array.from({ length: 12 }, (_, index) => mascotSeed("gallery", `chat-${String(index)}`));

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
