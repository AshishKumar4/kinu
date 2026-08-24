/**
 * Shared pieces of the admin control plane's views.
 *
 * They exist as one module because the control plane's views all answer the same
 * awkward question in the same way: a read here has FIVE outcomes, not two — a
 * value, "you are not an operator", "your sign-in went stale", "this deployment
 * has no control plane", and a genuine failure. A page that reduced those to
 * loading/loaded would show an empty table to somebody who was simply not
 * allowed to ask, which is the worst possible answer.
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Loader } from '@cloudflare/kumo';
import { ArrowClockwiseIcon, LockKeyIcon, WarningIcon } from '@phosphor-icons/react';
import type { ControlAnswer } from '../../lib/control-api';

/** A read's state, before it becomes a rendered panel. */
export type Load<Value> =
  | { phase: 'loading' }
  | { phase: 'settled'; answer: ControlAnswer<Value> };

/**
 * Run a control-plane read, and re-run it when `deps` change.
 *
 * `reload` is returned rather than exposed as a nonce because every view here
 * has a refresh affordance and an action that should refresh after it lands.
 */
/** A live read and the handle that re-runs it. Named because every view here
 *  destructures both, and an anonymous pair would be restated seven times. */
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
    void read().then((answer) => { if (live) setLoad({ phase: 'settled', answer }); });
    return () => { live = false; };
    // `read` is a fresh closure every render, so it is deliberately not a
    // dependency: the caller's `deps` state what the read actually depends on,
    // and including `read` would re-fire on every render.
  }, [...deps, nonce]);

  return { load, reload: useCallback(() => setNonce((n) => n + 1), []) };
}

/**
 * Render a read.
 *
 * Each non-ok arm says something an operator can act on. `forbidden` is the one
 * that matters most: the server answers 404 to a non-operator so a probe learns
 * nothing, and this is where that becomes a sentence instead of a blank page.
 */
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
          This account is not on the control-plane operator list, so there is nothing here to show.
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

export function Notice(
  { tone, icon, children }: {
    tone: 'muted' | 'warn' | 'danger' | 'ok';
    icon?: ReactNode;
    children: ReactNode;
  },
): ReactNode {
  const toneClass = tone === 'danger' ? 'p-danger'
    : tone === 'warn' ? 'p-gold'
    : tone === 'ok' ? 'p-success'
    : 'p-text-3';
  return (
    <div className={`p-card p-3 text-xs flex items-start gap-2 ${toneClass}`}>
      {icon}<div className="min-w-0">{children}</div>
    </div>
  );
}

/** A labelled number. The control plane is mostly counts, and a count with no
 *  label beside it is a number nobody can act on. */
export function Stat({ label, value, hint }: { label: string; value: string; hint?: string }): ReactNode {
  return (
    <div className="p-card p-4">
      <div className="text-[11px] uppercase tracking-wide p-text-3">{label}</div>
      <div className="text-2xl p-display tabular-nums mt-1">{value}</div>
      {hint !== undefined && <div className="text-[11px] p-text-3 mt-1">{hint}</div>}
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

/**
 * The cursor walk.
 *
 * `status: 'end'` is the store's direct evidence that a query ran off the end of
 * the data — it over-fetches one row and reports the extra's absence — so this
 * shows "no more" only when that is a fact rather than an inference from a page
 * that happened to be full. Which is exactly why the button is driven off
 * `status` and not off `items.length`.
 */
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

/** Epoch millis as something a person reads. Absent renders as an em dash rather
 *  than as the epoch, which is what `new Date(0)` would show. */
export function when(at: number | null | undefined): string {
  if (at === null || at === undefined || at <= 0) return '—';
  return new Date(at).toLocaleString();
}

/** A byte count at the precision an operator needs, which is one decimal. */
export function bytes(count: number | null): string {
  if (count === null) return '—';
  if (count < 1024) return `${String(count)} B`;
  if (count < 1024 * 1024) return `${(count / 1024).toFixed(1)} KB`;
  return `${(count / (1024 * 1024)).toFixed(1)} MB`;
}
