/** A control-plane read has five outcomes: value, not operator, stale sign-in, no control plane, failure. */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { diagnostics, renderThrownChain, toKinuError } from '@kinu.run/core/obs';
import { Loader } from '@cloudflare/kumo';
import { ArrowClockwiseIcon, LockKeyIcon, WarningIcon } from '@phosphor-icons/react';
import type { ControlAnswer } from '../../lib/control-api';

export type Load<Value> =
  | { phase: 'loading' }
  | { phase: 'settled'; answer: ControlAnswer<Value> };

export interface ControlRead<Value> {
  load: Load<Value>;
  reload: () => void;
}

export function useControlRead<Value>(
  read: () => Promise<ControlAnswer<Value>>,
  deps: readonly unknown[],
): ControlRead<Value> {
  const [load, setLoad] = useState<Load<Value>>({ phase: 'loading' });
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let live = true;
    setLoad({ phase: 'loading' });

    // `control()` names HTTP failures in its answer, so a rejection is the transport; settle it as `failed`.
    const readFailed = (...rejection: [unknown]): void => {
      const [thrown] = rejection;

      diagnostics.failure('control.read_failed', toKinuError({
        doing: 'run a control-plane read', cause: thrown, otherwise: 'io',
      }));

      if (live) {
        setLoad({
          phase: 'settled',
          answer: { status: 'failed', reason: renderThrownChain({ cause: thrown }) },
        });
      }
    };

    void read().then(
      (answer) => { if (live) setLoad({ phase: 'settled', answer }); },
      readFailed,
    );

    return () => { live = false; };
    // `read` is a fresh closure every render, so `deps` stand in for it.
  }, [...deps, nonce]);

  return { load, reload: useCallback(() => setNonce((n) => n + 1), []) };
}

/** The server answers 404 to a non-operator so a probe learns nothing; `forbidden` renders that as a sentence. */
export function Panel<Value>(
  { load, children }: { load: Load<Value>; children: (value: Value) => ReactNode },
): ReactNode {
  if (load.phase === 'loading') {
    return <div className="flex items-center justify-center py-12"><Loader size="base" /></div>;
  }

  const answer = load.answer;

  switch (answer.status) {
    case 'ok':
      return children(answer.value);
    case 'forbidden':
      return (
        <Notice tone="muted" icon={<LockKeyIcon size={14} />}>
          This account is not a control-plane operator.
        </Notice>
      );
    case 'stale-auth':
      return (
        <Notice tone="warn" icon={<WarningIcon size={14} />}>
          {answer.reason} <a className="underline" href="/login">Sign in again</a>.
        </Notice>
      );
    case 'unconfigured':
      return <Notice tone="muted" icon={<WarningIcon size={14} />}>{answer.reason}</Notice>;
    case 'failed':
      return <Notice tone="danger" icon={<WarningIcon size={14} />}>{answer.reason}</Notice>;
  }
}

const NOTICE_TONE = {
  muted: 'p-text-3',
  warn: 'p-accent',
  danger: 'p-danger',
  ok: 'p-success',
} as const;

export function Notice(
  { tone, icon, children }: {
    tone: keyof typeof NOTICE_TONE;
    icon?: ReactNode;
    children: ReactNode;
  },
): ReactNode {
  return (
    <div className={`p-card p-3 text-xs flex items-start gap-2 ${NOTICE_TONE[tone]}`}>
      {icon}<div className="min-w-0">{children}</div>
    </div>
  );
}

export function Stat({ label, value, hint }: { label: string; value: string; hint?: string }): ReactNode {
  return (
    <div className="p-card p-4">
      <div className="p-eyebrow">{label}</div>
      <div className="text-2xl p-display tabular-nums mt-1">{value}</div>
      {hint !== undefined && <div className="p-meta p-text-3 mt-1">{hint}</div>}
    </div>
  );
}

export function SectionHeader(
  { title, hint, onRefresh, actions }: {
    title: string; hint?: string; onRefresh?: () => void; actions?: ReactNode;
  },
): ReactNode {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <h2 className="text-sm font-medium">{title}</h2>
        {hint !== undefined && <p className="text-xs p-text-3 mt-0.5">{hint}</p>}
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {actions}
        {onRefresh !== undefined && (
          <button
            onClick={onRefresh}
            className="text-xs p-text-3 hover:p-text flex items-center gap-1 px-2 py-1"
            title="Refresh"
          >
            <ArrowClockwiseIcon size={12} /> Refresh
          </button>
        )}
      </div>
    </div>
  );
}

/** Driven off `status: 'end'` (the store over-fetches one row), not `items.length`. */
export function PageWalker(
  { status, onNext, onFirst, page }: {
    status: 'more' | 'end'; onNext: () => void; onFirst: () => void; page: number;
  },
): ReactNode {
  return (
    <div className="flex items-center justify-between text-xs p-text-3 pt-1">
      <span>page {page + 1}</span>
      <div className="flex items-center gap-3">
        {page > 0 && (
          <button onClick={onFirst} className="hover:p-text">Back to first</button>
        )}
        {status === 'more'
          ? <button onClick={onNext} className="hover:p-text">Next page →</button>
          : <span>end of list</span>}
      </div>
    </div>
  );
}

/** Absent renders as an em dash, not the epoch. */
export function when(at: number | null | undefined): string {
  if (at === null || at === undefined || at <= 0) return '—';

  return new Date(at).toLocaleString();
}

export function bytes(count: number | null): string {
  if (count === null) return '—';

  if (count < 1024) return `${String(count)} B`;

  if (count < 1024 * 1024) return `${(count / 1024).toFixed(1)} KB`;

  return `${(count / (1024 * 1024)).toFixed(1)} MB`;
}
