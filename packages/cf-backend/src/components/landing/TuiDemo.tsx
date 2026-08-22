import { useEffect, useId, useState, type ReactElement } from 'react';

import { Button, Tabs } from '@cloudflare/kumo';

const DEMO_STATES = ['idle', 'working', 'result'] as const;
type DemoState = (typeof DEMO_STATES)[number];

const STATE_LABELS = {
  idle: 'Idle',
  working: 'Working',
  result: 'Result',
} as const satisfies Record<DemoState, string>;

const STATE_DURATION_MS = {
  idle: 2_400,
  working: 3_400,
  result: 5_200,
} as const satisfies Record<DemoState, number>;

const SPINNER_INTERVAL_MS = 120;
const SPINNER_FRAMES = ['⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;

const READY_INPUT = {
  title: 'checkout · 20260821-checkout01 · Ctrl+P model ›',
  hint: 'Type a message or /help · Shift+Enter for a new line',
} as const;

// Verbatim display copy from scripts/tui-capture.ts and the three 88x28 chat captures.
const CAPTURE = {
  status: {
    brand: 'kinu',
    prompt: '❯',
    workspace: 'checkout',
    mode: 'local',
    model: 'Deepseek V4 Pro 0813',
    modelHint: '[Ctrl+P]',
    context: 'ctx ~2.3k/128k',
    version: 'cli 0.2.0',
    live: '●',
  },
  idle: {
    system: 'Connected to checkout. Type a message or /help for commands.',
    input: READY_INPUT,
  },
  working: {
    user: 'The checkout tests are failing on main — find out why and fix it.',
    agent: 'Reading the failure first.',
    phase: 'writing',
    input: {
      title: '⟳ processing…',
      hint: 'Type to steer · Tab queues · Ctrl+B branches · Esc interrupts',
    },
  },
  result: {
    user: 'Run the test suite, then summarize what is broken.',
    opening: 'Running the suite now.',
    exec: {
      name: 'exec',
      args: '{"cmd":"bun test packages/checkout"}',
      output: ['37 pass', '2 fail', 'totals.ts:41 expected 1187, received 1204'],
    },
    write: {
      name: 'write_file',
      args: '{"path":"totals.ts"}',
      refusal: 'Writing outside this workspace needs approval.',
      reason: '(denied)',
      detail: 'The path /etc/hosts.conf is not inside the workspace.',
    },
    closing: [
      'Two failures share one cause: lineTotal counts shipping as taxable.',
      'A third-party refusal blocked a config write — not needed for the fix.',
    ],
    input: READY_INPUT,
  },
} as const;

const STATE_TABS = DEMO_STATES.map((state) => ({
  value: state,
  label: STATE_LABELS[state],
  className: 'font-mono text-xs',
}));

function nextState(state: DemoState): DemoState {
  switch (state) {
    case 'idle':
      return 'working';
    case 'working':
      return 'result';
    case 'result':
      return 'idle';
  }
}

function TerminalStatus(): ReactElement {
  const status = CAPTURE.status;

  return (
    <div
      className="p-surface flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border p-border px-3 py-2 sm:gap-x-4"
      aria-label={`${status.brand}, workspace ${status.workspace}, ${status.mode}, model ${status.model}, context ${status.context}, version ${status.version}, live`}
    >
      <span className="flex items-center gap-2 whitespace-nowrap">
        <strong className="p-gold font-medium">{status.brand}</strong>
        <span className="p-text-3" aria-hidden="true">{status.prompt}</span>
        <strong className="font-medium">{status.workspace}</strong>
        <span className="p-text-3">{status.mode}</span>
      </span>
      <span className="flex items-center gap-2 whitespace-nowrap md:ml-auto">
        <span>{status.model}</span>
        <kbd className="p-text-3">{status.modelHint}</kbd>
      </span>
      <span className="p-text-3 whitespace-nowrap">{status.context}</span>
      <span className="p-text-3 whitespace-nowrap">{status.version}</span>
      <span className="p-success whitespace-nowrap" title="Live">
        <span aria-hidden="true">{status.live}</span>
        <span className="sr-only"> Live</span>
      </span>
    </div>
  );
}

function UserMessage({ children }: { children: string }): ReactElement {
  return (
    <div className="p-user-bubble w-fit max-w-full rounded-none px-3 py-2 sm:max-w-md">
      <strong className="block font-medium">You</strong>
      <p className="m-0 whitespace-pre-wrap">{children}</p>
    </div>
  );
}

function AgentMessage({ lines, live = false }: { lines: readonly string[]; live?: boolean }): ReactElement {
  return (
    <div className="p-text-2">
      <strong className="p-text mb-1 block font-medium">Agent</strong>
      <p className="m-0 whitespace-pre-wrap">
        {lines.map((line, index) => (
          <span className="block" key={line}>{line}{live && index === lines.length - 1 ? (
            <span className="p-gold mt-1 block" aria-hidden="true">▌</span>
          ) : null}</span>
        ))}
      </p>
    </div>
  );
}

function IdleTranscript(): ReactElement {
  return <p className="p-text-2 m-0">{CAPTURE.idle.system}</p>;
}

function WorkingTranscript({ spinner }: { spinner: string }): ReactElement {
  return (
    <>
      <UserMessage>{CAPTURE.working.user}</UserMessage>
      <AgentMessage lines={[CAPTURE.working.agent]} live />
      <div className="p-gold flex items-center gap-2" role="status" aria-label={CAPTURE.working.phase}>
        <span aria-hidden="true">{spinner}</span>
        <span>{CAPTURE.working.phase}</span>
      </div>
    </>
  );
}

function ResultTranscript(): ReactElement {
  const result = CAPTURE.result;

  return (
    <>
      <UserMessage>{result.user}</UserMessage>
      <AgentMessage lines={[result.opening]} />
      <div className="p-text-2 pl-2">
        <div className="flex min-w-0 gap-2">
          <span className="p-gold shrink-0" aria-hidden="true">▸</span>
          <span className="min-w-0 break-words">
            <strong className="p-text font-medium">{result.exec.name}</strong>{' '}
            <span>{result.exec.args}</span>
          </span>
        </div>
        <div className="mt-1 pl-4">
          {result.exec.output.map((line, index) => (
            <div className="break-words" key={line}>
              {index === 0 ? <span className="p-success" aria-hidden="true">↳ </span> : null}
              {line}
            </div>
          ))}
        </div>
      </div>
      <div className="p-text-2 pl-2">
        <div className="flex min-w-0 gap-2">
          <span className="p-gold shrink-0" aria-hidden="true">▸</span>
          <span className="min-w-0 break-words">
            <strong className="p-text font-medium">{result.write.name}</strong>{' '}
            <span>{result.write.args}</span>
          </span>
        </div>
        <div className="mt-1 break-words pl-4">
          <span className="p-danger">✗ refused</span>{' '}
          <span>{result.write.refusal}</span>{' '}
          <span className="p-text-3">{result.write.reason}</span>
          <span className="block">{result.write.detail}</span>
        </div>
      </div>
      <AgentMessage lines={result.closing} />
    </>
  );
}

function Transcript({ state, spinner }: { state: DemoState; spinner: string }): ReactElement {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-3 py-2 sm:gap-3 sm:px-5 sm:py-3">
      {state === 'idle' ? <IdleTranscript /> : null}
      {state === 'working' ? <WorkingTranscript spinner={spinner} /> : null}
      {state === 'result' ? <ResultTranscript /> : null}
    </div>
  );
}

function TerminalInput({ state }: { state: DemoState }): ReactElement {
  const input = state === 'working'
    ? CAPTURE.working.input
    : state === 'idle'
      ? CAPTURE.idle.input
      : CAPTURE.result.input;

  return (
    <fieldset className="p-sidebar min-w-0 shrink-0 border p-border px-3 pb-3 pt-1">
      <legend className="p-text-2 max-w-full truncate px-1">{input.title}</legend>
      <p className="p-text-3 m-0 break-words">{input.hint}</p>
    </fieldset>
  );
}

export function TuiDemo(): ReactElement {
  const [state, setState] = useState<DemoState>('result');
  const [playing, setPlaying] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(false);
  const [spinnerFrame, setSpinnerFrame] = useState(0);
  const captionId = useId();
  const frameId = useId();

  useEffect(() => {
    const media = globalThis.window.matchMedia('(prefers-reduced-motion: reduce)');
    const syncMotion = () => {
      const reduced = media.matches;
      setReducedMotion(reduced);
      setState(reduced ? 'result' : 'idle');
      setPlaying(!reduced);
      setSpinnerFrame(0);
    };

    syncMotion();
    media.addEventListener('change', syncMotion);
    return () => media.removeEventListener('change', syncMotion);
  }, []);

  useEffect(() => {
    if (!playing || reducedMotion) return;

    const timer = globalThis.window.setTimeout(() => {
      setSpinnerFrame(0);
      setState((current) => nextState(current));
    }, STATE_DURATION_MS[state]);
    return () => globalThis.window.clearTimeout(timer);
  }, [playing, reducedMotion, state]);

  useEffect(() => {
    if (state !== 'working' || !playing || reducedMotion) return;

    const timer = globalThis.window.setInterval(
      () => setSpinnerFrame((current) => (current + 1) % SPINNER_FRAMES.length),
      SPINNER_INTERVAL_MS,
    );
    return () => globalThis.window.clearInterval(timer);
  }, [playing, reducedMotion, state]);

  const selectState = (value: string) => {
    if (value !== 'idle' && value !== 'working' && value !== 'result') return;
    setState(value);
    setPlaying(false);
    setSpinnerFrame(0);
  };

  const togglePlayback = () => {
    if (reducedMotion) return;
    if (playing) {
      setPlaying(false);
      return;
    }
    if (state === 'result') setState('idle');
    setPlaying(true);
  };

  const replay = () => {
    if (reducedMotion) return;
    setState('idle');
    setSpinnerFrame(0);
    setPlaying(true);
  };

  return (
    <figure className="m-0 min-w-0" aria-labelledby={captionId}>
      <figcaption
        id={captionId}
        className="p-surface p-annotation flex flex-wrap items-center justify-between gap-2 border border-b-0 p-border px-3 py-2"
      >
        <span className="p-gold">FIG.04 · TUI · LIVE DOM</span>
        <span className="p-text-3">KINU CHAT · LOCAL</span>
      </figcaption>

      <div
        id={frameId}
        className="p-recessed p-text p-annotation flex h-120 min-w-0 flex-col gap-2 border p-border p-2 tracking-normal sm:h-112 sm:text-xs sm:leading-5"
        data-tui-state={state}
        aria-busy={state === 'working'}
      >
        <TerminalStatus />
        <Transcript state={state} spinner={SPINNER_FRAMES[spinnerFrame]} />
        <TerminalInput state={state} />
      </div>

      <div className="p-surface flex flex-col gap-3 border border-t-0 p-border p-3 sm:flex-row sm:items-center sm:justify-between">
        <fieldset className="min-w-0 border-0 p-0">
          <legend className="sr-only">Terminal preview state</legend>
          <Tabs
            tabs={STATE_TABS}
            value={state}
            onValueChange={selectState}
            activateOnFocus
            className="max-w-full font-mono"
            indicatorClassName="motion-reduce:transition-none"
          />
        </fieldset>

        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Preview playback">
          {reducedMotion ? <span className="p-annotation p-text-3 mr-1">Reduced motion</span> : null}
          <Button
            type="button"
            size="sm"
            variant="secondary"
            onClick={togglePlayback}
            disabled={reducedMotion}
            aria-controls={frameId}
            aria-pressed={playing}
          >
            {playing ? 'Pause' : 'Play'}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={replay}
            disabled={reducedMotion}
            aria-controls={frameId}
          >
            Replay
          </Button>
        </div>
      </div>

      <span className="sr-only" aria-live="polite">
        {STATE_LABELS[state]} frame. Playback {playing ? 'running' : 'paused'}.
      </span>
    </figure>
  );
}
