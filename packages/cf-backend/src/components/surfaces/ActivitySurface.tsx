/**
 * Activity — the instrument panel for the run itself.
 *
 * The raw `activity_log` dump that used to close this panel is gone. Event
 * name + detail + ms is telemetry, and everything in it a person should read
 * already lands in chat, in the Work tab's journal, or in the meters above —
 * the same argument that retired the Run Timeline. `proteus debug` prints the
 * rows for anyone who wants them; the table and its RPC are untouched.
 *
 * Two kinds of number live here and they are never blended. The provider's
 * report (what the request cost, what was a cache read) is authoritative and
 * labelled `API`. The breakdown of where the context went is measured locally,
 * labelled `est`, and reconciled against the API total in the open: the bar
 * carries a rule at the provider's figure, and the residual between the two is
 * its own row. Anything the backend could not source renders as an em dash and
 * a reason, never as a plausible zero.
 */
import { useCallback } from "react";
import {
  GaugeIcon, CurrencyDollarIcon, LightningIcon, WarningCircleIcon,
} from "@phosphor-icons/react";
import { Loader } from "@cloudflare/kumo";
import { LoadFailure } from "@/components/ui/LoadFailure";
import { useAsyncResource, lastValue } from "@/hooks/use-async-resource";
import { fmtTokens, fmtUsd, fmtPct } from "@/lib/format";
import type { ActivitySnapshot, Rpc } from "@/lib/protocol";
import type { ContextComposition, ContextPlane } from "@proteus/core";
import { breakdownView, shareOfReported, type BreakdownPlane, type BreakdownRow } from "./activity-breakdown";

/** Live surface: a turn in flight re-measures every step. */
const STREAMING_POLL_MS = 1500;
const IDLE_POLL_MS = 10_000;

/** Planes read as one brass ramp rather than five hues — this is one quantity
 *  split by origin, not five unrelated series. */
const PLANE_LABEL: Record<ContextPlane, string> = {
  system: "System prompt",
  tools: "Tool definitions",
  messages: "Conversation",
  ephemeral: "Live-state blocks",
};
const PLANE_ALPHA: Record<ContextPlane, number> = {
  system: 1, tools: 0.72, messages: 0.46, ephemeral: 0.26,
};
const planeFill = (plane: ContextPlane): string =>
  `color-mix(in srgb, var(--c-accent) ${Math.round(PLANE_ALPHA[plane] * 100)}%, transparent)`;

export interface ActivitySurfaceProps {
  rpc: Rpc;
  isStreaming: boolean;
}

export function ActivitySurface({ rpc, isStreaming }: ActivitySurfaceProps) {
  const load = useCallback(() => rpc<ActivitySnapshot>("getActivitySnapshot", []), [rpc]);
  const revalidate = useCallback(() => (isStreaming ? STREAMING_POLL_MS : IDLE_POLL_MS), [isStreaming]);
  const { resource, reload } = useAsyncResource(load, revalidate);
  const snap = lastValue(resource);

  if (snap === null) {
    return resource.status === "error"
      ? <LoadFailure what="the activity snapshot" message={resource.message} onRetry={reload} />
      : <div className="flex justify-center py-10"><Loader size="sm" /></div>;
  }

  return (
    <div className="flex flex-col gap-6 text-xs">
      <ContextBlock snap={snap} />
      <CostBlock snap={snap} />
      <CacheBlock snap={snap} />
    </div>
  );
}

/* ── shared chrome ──────────────────────────────────────────────── */

function BlockHeader(
  { icon: Icon, title, note }: { icon: React.ComponentType<{ size?: number; className?: string }>; title: string; note?: string },
) {
  return (
    <div className="flex items-baseline gap-2 mb-2.5">
      <Icon size={13} className="p-accent self-center" />
      <h3 className="text-[12px] font-semibold p-text">{title}</h3>
      {note && <span className="text-[10px] p-text-3 ml-auto text-right">{note}</span>}
    </div>
  );
}

/** Every numeral in this panel is tabular mono so columns align down the page. */
function Num({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <span className={`font-mono tabular-nums ${className}`}>{children}</span>;
}

/** Marks a figure's provenance. The whole panel turns on this distinction. */
function Source({ kind }: { kind: "API" | "est" }) {
  return (
    <span
      className={`text-[9px] px-1 py-px rounded uppercase tracking-wide ${kind === "API" ? "p-badge-info" : "p-badge-neutral"}`}
      title={kind === "API"
        ? "The provider's authoritative count for this step."
        : "Measured locally from the composed request. It is an estimate, not the provider's count."}
    >{kind}</span>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-[11px] p-text-3 leading-relaxed">{children}</p>;
}

/* ── context ────────────────────────────────────────────────────── */

function ContextBlock({ snap }: { snap: ActivitySnapshot }) {
  const { latest, contextWindow } = snap;
  if (latest === null) {
    return (
      <section>
        <BlockHeader icon={GaugeIcon} title="Context" />
        <Empty>No model step has reported usage yet. This fills in on the first step of the next turn.</Empty>
      </section>
    );
  }

  const reported = latest.usage.input;
  const windowShare = contextWindow !== null && contextWindow > 0 ? reported / contextWindow : null;

  return (
    <section>
      <BlockHeader
        icon={GaugeIcon}
        title="Context"
        note={`step ${latest.stepIndex} · ${new Date(latest.at).toLocaleTimeString()}`}
      />

      <div className="flex items-end gap-2 mb-1">
        <Num className="text-[22px] leading-none p-text">{reported.toLocaleString()}</Num>
        <span className="text-[11px] p-text-2 pb-px">
          {contextWindow !== null ? `of ${fmtTokens(contextWindow)} tokens` : "tokens"}
        </span>
        <span className="ml-auto pb-px"><Source kind="API" /></span>
      </div>

      {windowShare !== null ? (
        <>
          <Meter value={windowShare} />
          <p className="text-[10px] p-text-3 mt-1">
            {fmtPct(windowShare, 1)} of the window · {latest.usage.cached.toLocaleString()} of those
            input tokens were a cache read
          </p>
        </>
      ) : (
        <p className="text-[10px] p-text-3 mt-1">
          Context window unknown. The model catalog has not answered, so no share is shown.
        </p>
      )}

      <Breakdown context={latest.context} reported={reported} />
    </section>
  );
}

function Meter({ value }: { value: number }) {
  const pct = Math.min(Math.max(value, 0), 1) * 100;
  const tone = value >= 0.9 ? "var(--c-danger)" : value >= 0.7 ? "var(--c-warning)" : "var(--c-accent)";
  return (
    <div className="h-1.5 rounded-full overflow-hidden" style={{ background: "var(--c-neutral-tint)" }}>
      <div className="h-full rounded-full" style={{ width: `${pct}%`, background: tone }} />
    </div>
  );
}

function Breakdown({ context, reported }: { context: ContextComposition | null; reported: number }) {
  if (context === null) {
    return (
      <div className="mt-4">
        <Empty>
          No breakdown was recorded for this step. Steps recorded before this panel existed carry
          usage but no composition.
        </Empty>
      </div>
    );
  }

  const { planes, estimated, residual, span } = breakdownView(context, reported);

  return (
    <div className="mt-4">
      <div className="flex items-baseline gap-2 mb-2">
        <h4 className="text-[11px] font-semibold p-text-2">Where it went</h4>
        <Source kind="est" />
        <span className="ml-auto text-[10px] p-text-3">
          {context.measuredChars.toLocaleString()} chars ÷ {context.charsPerToken}
        </span>
      </div>

      <StackedBar planes={planes} span={span} reported={reported} residual={residual} />

      <table className="w-full mt-3 border-collapse">
        <tbody>
          {planes.map((plane) => (
            <PlaneRows key={plane.plane} plane={plane} reported={reported} />
          ))}
        </tbody>
      </table>

      <Reconciliation reported={reported} estimated={estimated} residual={residual} />
    </div>
  );
}

/** Hatched, not tinted: the remainder is unknown territory, and a flat fill
 *  would read as a fifth measured plane. */
const UNACCOUNTED_FILL =
  "repeating-linear-gradient(-45deg, var(--c-neutral-tint) 0 3px, transparent 3px 6px)";

const swatch = "w-2 h-2 rounded-[2px] inline-block shrink-0 border p-border";

function StackedBar(
  { planes, span, reported, residual }:
  { planes: readonly BreakdownPlane[]; span: number; reported: number; residual: number },
) {
  const over = residual < 0;
  return (
    <div className="relative">
      <div className="flex h-3 rounded overflow-hidden" style={{ background: "var(--c-neutral-tint)" }}>
        {planes.map((row) => (
          <div
            key={row.plane}
            style={{ width: `${(row.tokens / span) * 100}%`, background: planeFill(row.plane) }}
            title={`${PLANE_LABEL[row.plane]} — ${row.tokens.toLocaleString()} tokens (est)`}
          />
        ))}
        {residual > 0 && (
          <div
            style={{ width: `${(residual / span) * 100}%`, background: UNACCOUNTED_FILL }}
            title={`Unaccounted — ${residual.toLocaleString()} tokens the provider billed that the breakdown does not explain`}
          />
        )}
      </div>
      {/* Only drawn when it falls INSIDE the segments: an estimate that
          overshoots is the case worth seeing. Otherwise the hatch already ends
          exactly at the provider's figure, and a rule on the bar's own edge
          reads as a border. */}
      {over && (
        <div
          className="absolute top-0 bottom-0 w-px pointer-events-none"
          style={{ left: `${(reported / span) * 100}%`, background: "var(--c-text)" }}
          title={`Provider-reported input: ${reported.toLocaleString()} tokens`}
        />
      )}
      <div className="flex flex-wrap gap-x-3 gap-y-1 mt-1.5">
        {planes.map((row) => (
          <span key={row.plane} className="flex items-center gap-1 text-[10px] p-text-3">
            <span className={swatch} style={{ background: planeFill(row.plane) }} />
            {PLANE_LABEL[row.plane]}
          </span>
        ))}
        {residual > 0 && (
          <span className="flex items-center gap-1 text-[10px] p-text-3">
            <span className={swatch} style={{ background: UNACCOUNTED_FILL }} />
            Unaccounted
          </span>
        )}
        {over && (
          <span className="flex items-center gap-1 text-[10px] p-text-3">
            <span className="w-px h-2.5 inline-block" style={{ background: "var(--c-text)" }} />
            API total
          </span>
        )}
      </div>
    </div>
  );
}

function PlaneRows({ plane, reported }: { plane: BreakdownPlane; reported: number }) {
  return (
    <>
      <tr className="border-t p-border">
        <td className="py-1 pr-2">
          <span className="flex items-center gap-1.5">
            <span className={swatch} style={{ background: planeFill(plane.plane) }} />
            <span className="text-[11px] font-medium p-text">{PLANE_LABEL[plane.plane]}</span>
          </span>
        </td>
        <td className="py-1 text-right w-16"><Num className="text-[11px] p-text">{fmtTokens(plane.tokens)}</Num></td>
        <td className="py-1 text-right w-12">
          <Num className="text-[11px] p-text-2">{fmtPct(shareOfReported(plane.tokens, reported), 1)}</Num>
        </td>
      </tr>
      {plane.rows.map((row: BreakdownRow) => (
        <tr key={`${plane.plane}:${row.label}`}>
          <td className="py-px pr-2 pl-[14px]">
            <span className="text-[11px] p-text-3 truncate block" title={row.label}>
              {row.label}
              {row.items > 1 && <span className="p-text-3"> ×{row.items}</span>}
            </span>
          </td>
          <td className="py-px text-right"><Num className="text-[11px] p-text-3">{fmtTokens(row.tokens)}</Num></td>
          <td className="py-px text-right">
            <Num className="text-[11px] p-text-3">{fmtPct(shareOfReported(row.tokens, reported), 1)}</Num>
          </td>
        </tr>
      ))}
    </>
  );
}

function Reconciliation({ reported, estimated, residual }: { reported: number; estimated: number; residual: number }) {
  const over = residual < 0;
  const share = reported > 0 ? Math.abs(residual) / reported : null;
  return (
    <div className="mt-3 pt-2.5 border-t p-border flex flex-col gap-1">
      <Line label="Measured locally" value={`${estimated.toLocaleString()} tok`} source="est" />
      <Line label="Reported by the provider" value={`${reported.toLocaleString()} tok`} source="API" />
      <div className="flex items-baseline gap-2">
        <span className={`text-[11px] font-medium ${over ? "p-warning" : "p-text-2"}`}>
          {over ? "Over-attributed" : "Unaccounted"}
        </span>
        <span className="ml-auto">
          <Num className={`text-[11px] ${over ? "p-warning" : "p-text"}`}>
            {over ? "−" : ""}{Math.abs(residual).toLocaleString()} tok
          </Num>
          {share !== null && <span className="text-[10px] p-text-3 ml-1.5">({fmtPct(share, 1)})</span>}
        </span>
      </div>
      <p className="text-[10px] p-text-3 leading-relaxed mt-0.5">
        {over
          ? "The local estimate exceeds what the provider charged. This prompt packs more characters into each token than the divisor assumes, so dividing by it over-counts."
          : "No provider reports which parts of a prompt its tokens came from, so the breakdown is measured locally and the remainder is left named rather than spread across the rows."}
      </p>
    </div>
  );
}

function Line({ label, value, source }: { label: string; value: string; source: "API" | "est" }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="text-[11px] p-text-2">{label}</span>
      <Source kind={source} />
      <Num className="text-[11px] p-text ml-auto">{value}</Num>
    </div>
  );
}

/* ── cost ───────────────────────────────────────────────────────── */

function CostBlock({ snap }: { snap: ActivitySnapshot }) {
  const { telemetry, budgets } = snap;
  const priced = telemetry.pricedSteps > 0;
  return (
    <section>
      <BlockHeader
        icon={CurrencyDollarIcon}
        title="Cost"
        note={`${telemetry.steps} steps · window ${telemetry.windowLimit}`}
      />
      {priced ? (
        <div className="flex items-end gap-2">
          <Num className="text-[20px] leading-none p-text">{fmtUsd(telemetry.usd)}</Num>
          <span className="text-[11px] p-text-2 pb-px">over {telemetry.pricedSteps} priced steps</span>
        </div>
      ) : (
        <Empty>
          No step in the window carried a catalog price, so no cost is shown. Nothing here is
          estimated from a blended rate.
        </Empty>
      )}

      {telemetry.unpricedSteps > 0 && (
        <p className="flex items-start gap-1.5 text-[10px] p-warning mt-1.5">
          <WarningCircleIcon size={12} className="shrink-0 mt-px" />
          <span>
            {telemetry.unpricedSteps} step{telemetry.unpricedSteps === 1 ? "" : "s"} had no
            models.dev rate and {priced ? "are excluded from the total above" : "cannot be priced"}.
          </span>
        </p>
      )}

      {telemetry.steps > 0 && (
      <dl className="grid grid-cols-4 gap-x-3 gap-y-1 mt-3">
        <Stat label="Input" value={fmtTokens(telemetry.tokens.input)} />
        <Stat label="Cached" value={fmtTokens(telemetry.tokens.cached)} />
        <Stat label="Output" value={fmtTokens(telemetry.tokens.output)} />
        <Stat label="Reasoning" value={fmtTokens(telemetry.tokens.reasoning)} />
      </dl>
      )}

      {budgets.length > 0 && (
        <div className="mt-3 pt-2.5 border-t p-border">
          <h4 className="text-[11px] font-semibold p-text-2 mb-1.5">Mission budgets</h4>
          {budgets.map((budget) => (
            <div key={budget.label} className="flex items-baseline gap-2 py-0.5">
              <span className="text-[11px] p-text truncate">{budget.label}</span>
              <span
                className={`text-[9px] px-1 rounded ${budget.pricing.source === "catalog" ? "p-badge-neutral" : "p-badge-warning"}`}
                title={budget.pricing.source === "catalog"
                  ? "Every token priced from the models.dev catalog."
                  : `${budget.pricing.blendedTokens.toLocaleString()} tokens priced at the blended fallback rate, not catalog rates.`}
              >{budget.pricing.source}</span>
              {budget.exhausted && <span className="text-[9px] px-1 rounded p-badge-danger">exhausted</span>}
              <Num className="text-[11px] p-text ml-auto">{fmtUsd(budget.spent.usd)}</Num>
              {budget.limits.usd !== undefined && (
                <Num className="text-[10px] p-text-3">/ {fmtUsd(budget.limits.usd)}</Num>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[10px] p-text-3 uppercase tracking-wide">{label}</dt>
      <dd><Num className="text-[13px] p-text">{value}</Num></dd>
    </div>
  );
}

/* ── cache ──────────────────────────────────────────────────────── */

function CacheBlock({ snap }: { snap: ActivitySnapshot }) {
  const { cacheHit } = snap.telemetry;
  return (
    <section>
      <BlockHeader
        icon={LightningIcon}
        title="Prompt cache"
        note={`${cacheHit.samples} sampled step${cacheHit.samples === 1 ? "" : "s"}`}
      />
      {cacheHit.samples === 0 ? (
        <Empty>No step in the window reported input tokens, so there is no hit rate to show.</Empty>
      ) : (
        <>
          <dl className="grid grid-cols-4 gap-x-3 gap-y-1">
            <Stat label="Last" value={fmtPct(cacheHit.last, 1)} />
            <Stat label="EMA" value={fmtPct(cacheHit.ema, 1)} />
            <Stat label="Mean" value={fmtPct(cacheHit.mean, 1)} />
            <Stat label="p95" value={fmtPct(cacheHit.p95, 1)} />
          </dl>
          <p className="text-[10px] p-text-3 mt-2 leading-relaxed">
            Cached input over total input, per step. The cached tokens are a subset of the input the
            provider billed. The EMA weights recent steps at α={cacheHit.emaAlpha}; the mean and p95
            are over the {cacheHit.samples} step{cacheHit.samples === 1 ? "" : "s"} retained in the
            run-event log, not all time.
          </p>
        </>
      )}
    </section>
  );
}
