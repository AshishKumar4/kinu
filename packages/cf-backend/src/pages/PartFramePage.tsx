/**
 * `/s/:workspace/:slate/parts/:part?args=`: one personal part, in the app's own frame inside the slate's page
 * (docs/SLATE-SHARING-NIMBUS.md §3). It runs and decides only through the app page at the top of its window
 * (lib/part-bridge.ts); opened any other way it shows nothing of its viewer.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { Effect } from "effect";
import * as v from "valibot";
import { Loader } from "@cloudflare/kumo";
import { JsonValueSchema, safeJsonParse, type PartRunAnswer } from "@kinu.run/core";
import { detach } from "@kinu.run/core/obs";
import { PartOutsideItsSlate, PartView } from "@/components/sharing/PartView";
import { connectPartBridge, type PartBridge } from "@/lib/part-bridge";

/**
 * A part's frame sits inside the slate's own page: it shows that page through it, not the app's background, and takes
 * `?scheme=light|dark` when the slate's page says which suits it.
 */
function useSlateScheme(scheme: string | null): void {
  useEffect(() => {
    const root = document.documentElement;

    root.style.background = "transparent";
    document.body.style.background = "transparent";

    if (scheme !== "light" && scheme !== "dark") return;

    root.setAttribute("data-mode", scheme);
    root.style.colorScheme = scheme;
  }, [scheme]);
}

/** The page's public input to the part (`?args=`, a JSON array); none when it gives nothing that parses as one. */
const argsOf = (raw: string | null) => {
  const args = v.safeParse(v.array(JsonValueSchema), raw === null ? [] : safeJsonParse(raw));

  return args.success ? args.output : [];
};

/** One of the part's own controls, pressed, with what its viewer gave it. */
type Pressed = { readonly id: string; readonly input: string | null };

function PartFrame({ workspace, slate, part, args }: { workspace: string; slate: string; part: string; args: readonly v.InferOutput<typeof JsonValueSchema>[] }) {
  const [bridge, setBridge] = useState<PartBridge | null>(null);
  const [outside, setOutside] = useState(false);
  const [answer, setAnswer] = useState<PartRunAnswer | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  // The press whose run waits on a decision: allowed or approved, that run resumes with it; declined, it is dropped.
  const waiting = useRef<Pressed | null>(null);

  useEffect(() => {
    const stop = connectPartBridge({ workspace, slate, part, args }, setBridge);

    if (stop === null) setOutside(true);

    return () => { stop?.(); };
  }, [workspace, slate, part, args]);

  const run = useCallback((action: Pressed | null, approval: string | null) => {
    if (bridge === null) return;
    setFailure(null);
    detach(Effect.map(Effect.promise(() => bridge.run(action, approval)), (ran) => {
      if (typeof ran === "string") {
        setFailure(ran);

        return;
      }

      waiting.current = ran.kind === "needs-consent" || ran.kind === "needs-approval" ? action : null;
      setAnswer(ran);
    }));
  }, [bridge]);

  // The first run, once the top answers.
  useEffect(() => { run(null, null); }, [run]);

  const decide = useCallback((kind: "consent" | "approval" | "show") => {
    if (bridge === null) return;
    detach(Effect.map(Effect.promise(() => bridge.decide(kind)), (decided) => {
      // Allowed: the waiting run resumes under the new consent; approved: again, with that one effect admitted.
      if (decided.kind === "consented") run(waiting.current, null);

      if (decided.kind === "approved") run(waiting.current, decided.approval);

      if (decided.kind === "declined") waiting.current = null;
    }));
  }, [bridge, run]);

  if (outside) return <PartOutsideItsSlate />;

  if (answer === null) return <div className="flex h-dvh items-center justify-center">{failure === null ? <Loader size="sm" /> : <p role="alert" className="p-meta p-danger">{failure}</p>}</div>;

  return (
    <div data-part-frame={answer.kind} className="flex h-dvh flex-col p-2 p-text">
      <PartView answer={answer} slate={bridge?.title ?? slate} controls={{ act: (action) => run(action, null), decide, signIn: () => bridge?.signIn(), retry: () => run(null, null) }} />
      {failure !== null && <p role="alert" className="mt-1.5 p-meta p-danger">{failure}</p>}
    </div>
  );
}

export default function PartFramePage() {
  const { workspace = "", slate = "", part = "" } = useParams();
  const [search] = useSearchParams();
  const raw = search.get("args");
  const [args] = useState(() => argsOf(raw));

  useSlateScheme(search.get("scheme"));

  return <PartFrame workspace={workspace} slate={slate} part={part} args={args} />;
}
