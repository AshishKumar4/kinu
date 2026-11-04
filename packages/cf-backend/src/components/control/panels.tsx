/** A control-plane read has five outcomes: value, not operator, stale sign-in, no control plane, failure. */
import type { ReactNode } from 'react';
import { Loader } from '@/components/ui/Loader';
import { ArrowClockwiseIcon } from '@phosphor-icons/react';
import { Notice } from '@/components/ui/Notice';
import { useAsyncResource } from '@/hooks/use-async-resource';
import type { ControlAnswer } from '../../lib/control-api';
import { Button } from "@/components/ui/Button";
import { Surface } from "@/components/ui/Surface";

export type Load<Value> =
  | { phase: 'loading' }
  | { phase: 'settled'; answer: ControlAnswer<Value> };

interface ControlRead<Value> {
  load: Load<Value>;
  reload: () => void;
}

/** `read` must be stable (useCallback): it is the read's identity, as `useAsyncResource`'s `load` is. */
export function useControlRead<Value>(read: () => Promise<ControlAnswer<Value>>): ControlRead<Value> {
  // `control()` answers every failure of a read, the transport's included; a rejection left is a defect.
  const { resource, reload } = useAsyncResource(read);

  if (resource.status === 'loading') return { load: { phase: 'loading' }, reload };

  return {
    load: { phase: 'settled', answer: resource.status === 'ready' ? resource.value : { status: 'failed', reason: resource.message } },
    reload,
  };
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
        <Notice tone="info">
          This account is not a control-plane operator.
        </Notice>
      );
    case 'stale-auth':
      return (
        <Notice tone="warning">
          {answer.reason} <a className="underline" href="/login">Sign in again</a>.
        </Notice>
      );
    case 'access-expired':
      // A full load of this page, which Access answers with its own sign-in and then this page again.
      return (
        <Notice tone="warning">
          <a className="underline" href={location.pathname + location.search} data-access-sign-in>{answer.reason}</a>.
        </Notice>
      );
    case 'unconfigured':
      return <Notice tone="info">{answer.reason}</Notice>;
    case 'failed':
      return <Notice tone="danger">{answer.reason}</Notice>;
  }
}

export function Stat({ label, value, hint }: { label: string; value: string; hint?: string }): ReactNode {
  return (
    <Surface look="panel" className="p-4">
      <div className="t-label">{label}</div>
      <div className="t-page-title tabular-nums mt-1">{value}</div>
      {hint !== undefined && <div className="t-meta p-text-3 mt-1">{hint}</div>}
    </Surface>
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
        <h2 className="t-item">{title}</h2>
        {hint !== undefined && <p className="t-meta p-text-3 mt-px">{hint}</p>}
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {actions}
        {onRefresh !== undefined && (
          <Button variant="ghost" size="sm" onClick={onRefresh} title="Refresh" icon={<ArrowClockwiseIcon size={14} />}> Refresh
          </Button>
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
    <div className="t-meta flex items-center justify-between p-text-3 pt-1">
      <span>page {page + 1}</span>
      <div className="flex items-center gap-3">
        {page > 0 && (
          <Button variant="ghost" size="sm" onClick={onFirst}>Back to first</Button>
        )}
        {status === 'more'
          ? <Button variant="ghost" size="sm" onClick={onNext}>Next page →</Button>
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

