/**
 * Activity — the instrument panel for the run itself.
 *
 * The raw `activity_log` dump that used to close this panel is gone. Event
 * name + detail + ms is telemetry, and everything in it a person should read
 * already lands in chat, in the Work tab's journal, or in the meters above —
 * the same argument that retired the Run Timeline. `kinu debug` prints the
 * rows for anyone who wants them; the table and its RPC are untouched.
 *
 * Provider-reported tokens and cache reads are authoritative and labelled
 * `API`. Category attribution uses the exact composed-content character counts
 * Kinu measures locally. Providers do not report per-category tokens, so
 * this surface never invents them. Anything the backend could not source
 * renders as an em dash and a reason, never as a plausible zero.
 *
 * Cost is TWO scopes and says which is which. The hero figure is this agent's
 * own turns, out of `step_finish`, because the token and cache blocks around it
 * are per-step and would be meaningless mixed with a judge's cold prompt. The
 * workspace total sits under it, grouped by the producer that spent it, with the
 * coverage fraction that says what share of the known calls the providers
 * actually measured — the panel's answer to whether the number includes the
 * async models.
 *
 * Within that table MEASUREMENT OUTRANKS DERIVATION, left to right and in tone:
 * tokens and neurons are what a provider reported, and neurons are Cloudflare's
 * own billing unit rather than a rate anyone applied, so they read at full
 * weight. The dollar column is priced from the models.dev catalog by
 * `priceCall`, is a floor whenever a call carried no rate, and is dimmed and
 * last for exactly that reason (`scripts/eval-spend.ts:12-16` is the same rule
 * one layer down: what a run MEASURED is tokens and calls, and a dollar figure
 * is a number nobody cited).
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
import { SPEND_SOURCE_DETAIL, SPEND_SOURCE_LABEL, usageTotal } from "@kinu/core";
import type {
  ContextComposition, ContextPlane, ProducerSpend, SpendSource, WorkspaceSpend,
} from "@kinu/core";
import { breakdownView, shareOfMeasured, type BreakdownPlane, type BreakdownRow } from "./activity-breakdown";

/** Live surface: a turn in flight re-measures every step. */
const STREAMING_POLL_MS = 1500;
const IDLE_POLL_MS = 10_000;

/** Planes read as one brass ramp rather than five hues — this is one quantity
 *  split by origin, not five unrelated series. */
const PLANE_LABEL = {
  system: "System prompt",
  tools: "Tool definitions",
  messages: "Conversation",
  ephemeral: "Live-state blocks",
} satisfies Record<ContextPlane, string>;
const PLANE_ALPHA = {
  system: 1, tools: 0.72, messages: 0.46, ephemeral: 0.26,
} satisfies Record<ContextPlane, number>;
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
function Num(
  { children, className = "", title }:
  { children: React.ReactNode; className?: string; title?: string },
) {
  return <span className={`font-mono tabular-nums ${className}`} title={title}>{children}</span>;
}

/** Marks a figure's provenance. The whole panel turns on this distinction. */
function Source({ kind }: { kind: "API" | "local" }) {
  return (
    <span
      className={`text-[9px] px-1 py-px rounded-sm uppercase tracking-wide ${kind === "API" ? "p-badge-info" : "p-badge-neutral"}`}
      title={kind === "API"
        ? "The provider's authoritative count for this step."
        : "Exact character counts measured from the locally composed prompt content; not provider token attribution."}
    >{kind}</span>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-[11px] p-text-3 leading-relaxed">{children}</p>;
}

/** A figure that under-counts, and why. Every gap in this panel is stated in
 *  this shape rather than absorbed into the smaller number. */
function Warning({ children }: { children: React.ReactNode }) {
  return (
    <p className="flex items-start gap-1.5 text-[10px] p-warning mt-1.5">
      <WarningCircleIcon size={12} className="shrink-0 mt-px" />
      <span>{children}</span>
    </p>
  );
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

  // Absent, not zero: `latest` is only non-null because the provider reported
  // SOMETHING, which need not have included a prompt-token count.
  const { input, cacheRead } = latest.usage;
  const windowShare = input !== undefined && contextWindow !== null && contextWindow > 0
    ? input / contextWindow
    : null;

  return (
    <section>
      <BlockHeader
        icon={GaugeIcon}
        title="Context"
        note={`step ${latest.stepIndex} · ${new Date(latest.at).toLocaleTimeString()}`}
      />

      <div className="flex items-end gap-2 mb-1">
        <Num className="text-[22px] leading-none p-text">{input === undefined ? "—" : input.toLocaleString()}</Num>
        <span className="text-[11px] p-text-2 pb-px">
          {input === undefined
            ? "input tokens not reported"
            : contextWindow !== null ? `of ${fmtTokens(contextWindow)} tokens` : "tokens"}
        </span>
        <span className="ml-auto pb-px"><Source kind="API" /></span>
      </div>

      {windowShare !== null ? (
        <>
          <Meter value={windowShare} />
          <p className="text-[10px] p-text-3 mt-1">
            {fmtPct(windowShare, 1)} of the window · {cacheRead === undefined
              ? "the provider reported no cache-read count for this step"
              : `${cacheRead.toLocaleString()} of those input tokens were a cache read`}
          </p>
        </>
      ) : (
        <p className="text-[10px] p-text-3 mt-1">
          {input === undefined
            ? "This step's provider reported no input count, so no share of the window is shown."
            : "Context window unknown. The model catalog has not answered, so no share is shown."}
        </p>
      )}

      <Breakdown context={latest.context} />
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

function Breakdown({ context }: { context: ContextComposition | null }) {
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

  const { planes, measuredChars, span } = breakdownView(context);

  return (
    <div className="mt-4">
      <div className="flex items-baseline gap-2 mb-2">
        <h4 className="text-[11px] font-semibold p-text-2">Composed content</h4>
        <Source kind="local" />
        <span className="ml-auto text-[10px] p-text-3">
          {measuredChars.toLocaleString()} exact chars
        </span>
      </div>

      <StackedBar planes={planes} span={span} />

      <table className="w-full mt-3 border-collapse">
        <tbody>
          {planes.map((plane) => (
            <PlaneRows key={plane.plane} plane={plane} measuredChars={measuredChars} />
          ))}
        </tbody>
      </table>

      <p className="text-[10px] p-text-3 leading-relaxed mt-2.5 pt-2.5 border-t p-border">
        These rows are exact character counts for the prompt content Kinu composed. Cloudflare
        reports the request&apos;s total tokens but not how those tokens divide across sections, so no
        per-section token counts are inferred.
      </p>
    </div>
  );
}

const swatch = "w-2 h-2 rounded-xs inline-block shrink-0 border p-border";

function StackedBar(
  { planes, span }: { planes: readonly BreakdownPlane[]; span: number },
) {
  return (
    <div>
      <div className="flex h-3 rounded-sm overflow-hidden" style={{ background: "var(--c-neutral-tint)" }}>
        {planes.map((row) => (
          <div
            key={row.plane}
            style={{ width: `${(row.chars / span) * 100}%`, background: planeFill(row.plane) }}
            title={`${PLANE_LABEL[row.plane]} — ${row.chars.toLocaleString()} composed-content characters`}
          />
        ))}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1 mt-1.5">
        {planes.map((row) => (
          <span key={row.plane} className="flex items-center gap-1 text-[10px] p-text-3">
            <span className={swatch} style={{ background: planeFill(row.plane) }} />
            {PLANE_LABEL[row.plane]}
          </span>
        ))}
      </div>
    </div>
  );
}

function PlaneRows({ plane, measuredChars }: { plane: BreakdownPlane; measuredChars: number }) {
  return (
    <>
      <tr className="border-t p-border">
        <td className="py-1 pr-2">
          <span className="flex items-center gap-1.5">
            <span className={swatch} style={{ background: planeFill(plane.plane) }} />
            <span className="text-[11px] font-medium p-text">{PLANE_LABEL[plane.plane]}</span>
          </span>
        </td>
        <td className="py-1 text-right w-20"><Num className="text-[11px] p-text">{plane.chars.toLocaleString()} ch</Num></td>
        <td className="py-1 text-right w-12">
          <Num className="text-[11px] p-text-2">{fmtPct(shareOfMeasured(plane.chars, measuredChars), 1)}</Num>
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
          <td className="py-px text-right"><Num className="text-[11px] p-text-3">{row.chars.toLocaleString()} ch</Num></td>
          <td className="py-px text-right">
            <Num className="text-[11px] p-text-3">{fmtPct(shareOfMeasured(row.chars, measuredChars), 1)}</Num>
          </td>
        </tr>
      ))}
    </>
  );
}

/* ── cost ───────────────────────────────────────────────────────── */

function CostBlock({ snap }: { snap: ActivitySnapshot }) {
  const { telemetry, budgets, spend } = snap;
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
          <span className="text-[11px] p-text-2 pb-px">
            over {telemetry.pricedSteps} priced steps — this agent&apos;s own turns, not the workspace
          </span>
        </div>
      ) : (
        <Empty>
          No step of this agent&apos;s own turns carried a catalog price, so no cost is shown here.
          Nothing here is estimated from a blended rate.
        </Empty>
      )}

      {telemetry.unpricedSteps > 0 && (
        <Warning>
          {telemetry.unpricedSteps} step{telemetry.unpricedSteps === 1 ? "" : "s"} had no
          models.dev rate and {priced ? "are excluded from the total above" : "cannot be priced"}.
        </Warning>
      )}

      {telemetry.stepsWithoutUsage > 0 && (
        <Warning>
          {telemetry.stepsWithoutUsage} step{telemetry.stepsWithoutUsage === 1 ? "" : "s"} reported no
          usage at all, so the token totals below under-count the window — those steps were not free,
          they were unmeasured.
        </Warning>
      )}

      {telemetry.steps > 0 && (
      <dl className="grid grid-cols-4 gap-x-3 gap-y-1 mt-3">
        <Stat label="Input" value={fmtTokens(telemetry.tokens.input)} />
        <Stat label="Cached" value={fmtTokens(telemetry.tokens.cacheRead)} />
        <Stat label="Output" value={fmtTokens(telemetry.tokens.output)} />
        <Stat label="Reasoning" value={fmtTokens(telemetry.tokens.reasoning)} />
      </dl>
      )}

      <WorkspaceSpendBlock spend={spend} />

      {budgets.length > 0 && (
        <div className="mt-3 pt-2.5 border-t p-border">
          <h4 className="text-[11px] font-semibold p-text-2 mb-1.5">Mission budgets</h4>
          {budgets.map((budget) => (
            <div key={budget.label} className="flex items-baseline gap-2 py-0.5">
              <span className="text-[11px] p-text truncate">{budget.label}</span>
              <span
                className={`text-[9px] px-1 rounded-sm ${budget.pricing.source === "catalog" ? "p-badge-neutral" : "p-badge-warning"}`}
                title={budget.pricing.source === "catalog"
                  ? "Every token priced from the models.dev catalog."
                  : `${budget.pricing.blendedTokens.toLocaleString()} tokens priced at the blended fallback rate, not catalog rates.`}
              >{budget.pricing.source}</span>
              {budget.exhausted && <span className="text-[9px] px-1 rounded-sm p-badge-danger">exhausted</span>}
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

/**
 * The workspace total, grouped by the producer that spent it.
 *
 * The figure above this block is the turn loop's own, and a reader who stops
 * there has no way to know a judge ensemble or an evolution pass ran at all.
 * These rows are the rest of the workspace; the coverage line under them is what
 * separates an answer from a number that merely looks like one, because a
 * producer whose provider reports nothing is counted in calls and absent from
 * tokens, and that gap is stated rather than rounded into the total.
 *
 * A producer with no row never ran. Every producer reports through the same
 * sink, so an absent row is silence about work that did not happen rather than a
 * wiring gap — which is why no zero row is drawn for it. The neurons column
 * obeys the same rule one axis over: a workspace whose providers never bill in
 * neurons gets no column at all, instead of a column of dashes.
 *
 * FOUR THINGS CAN QUALIFY THESE TOTALS and they arrive independently, so they
 * are composed into one caveat line by {@link spendCaveat} rather than stacked as
 * four warnings a reader learns to skip. `spend.complete` is the one that is easy
 * to miss: `windowLimit` says how deep the read went, `complete` says whether it
 * reached the end, and only the second decides whether a total is the total.
 */
function WorkspaceSpendBlock({ spend }: { spend: WorkspaceSpend }) {
  const { producers, total, coverage } = spend;
  const { reported } = coverage;
  const measuredTokens = usageTotal(total.usage);
  const neurons = total.usage.neurons !== undefined;
  const caveat = spendCaveat(spend);
  return (
    <div className="mt-3 pt-2.5 border-t p-border">
      <div className="flex items-baseline gap-2 mb-2">
        <h4 className="text-[11px] font-semibold p-text-2">Workspace spend</h4>
        <span
          className="ml-auto text-[10px] p-text-3"
          title={spend.complete
            ? "The read reached the end of the event log, so nothing was left outside it."
            : `The read stopped at ${spend.windowLimit} rows of each kind with rows still behind it, so older spend is outside this table.`}
        >
          {coverage.calls} call{coverage.calls === 1 ? "" : "s"} ·{" "}
          {spend.complete ? "whole log" : `newest ${spend.windowLimit} rows`}
        </span>
      </div>

      {reported === null ? (
        <Empty>
          No model call has been attributed yet, so there is no coverage fraction — absent, not 0%:
          a call nobody made is not a call a provider failed to report.{" "}
          {sourceList(["judge", "fast", "compaction", "head"])} and the rest all report through this
          one sink, so these rows fill in on the first call of any kind.
        </Empty>
      ) : (
        <>
          <table className="w-full border-collapse">
            <thead>
              <tr className="text-[10px] p-text-3 uppercase tracking-wide">
                <th className="text-left font-normal pb-1">Producer</th>
                <th
                  className="text-right font-normal pb-1 w-20"
                  title="Input plus output, as the provider reported them. Cache reads are already inside input."
                >Tokens</th>
                <th className="text-right font-normal pb-1 w-12" title="Share of the tokens this workspace measured.">Share</th>
                {neurons && (
                  <th
                    className="text-right font-normal pb-1 w-16"
                    title="Cloudflare's own billing unit, reported by the provider on every Workers AI call. A measurement, not a rate anyone applied."
                  >Neurons</th>
                )}
                <th
                  className="text-right font-normal pb-1 w-16"
                  title="Priced from the models.dev catalog by Kinu, not reported by any provider. Absent means unpriced, never free."
                >USD</th>
              </tr>
            </thead>
            <tbody>
              {producers.map((producer) => (
                <tr key={producer.source} className="border-t p-border">
                  <td className="py-1 pr-2">
                    <span className="flex items-baseline gap-1">
                      <span
                        className="text-[11px] p-text truncate"
                        title={SPEND_SOURCE_DETAIL[producer.source]}
                      >{SPEND_SOURCE_LABEL[producer.source]}</span>
                      <span className="text-[11px] p-text-3 shrink-0">×{producer.calls}</span>
                    </span>
                  </td>
                  <SpendCells
                    row={producer} measuredTokens={measuredTokens} neurons={neurons} className="p-text"
                  />
                </tr>
              ))}
              <tr className="border-t p-border">
                <td className="py-1 pr-2">
                  <span className="flex items-baseline gap-1">
                    <span className="text-[11px] font-semibold p-text">Workspace total</span>
                    <span className="text-[11px] p-text-3 shrink-0">×{total.calls}</span>
                  </span>
                </td>
                <SpendCells
                  row={total} measuredTokens={measuredTokens} neurons={neurons}
                  className="font-semibold p-text"
                />
              </tr>
            </tbody>
          </table>

          <p className="text-[10px] p-text-3 leading-relaxed mt-2.5 pt-2.5 border-t p-border">
            <Num className="p-text-2">{fmtPct(reported, reported === 1 ? 0 : 1)}</Num> of the{" "}
            {coverage.calls} known call{coverage.calls === 1 ? "" : "s"} reported usage.{" "}
            {reported === 1
              ? "Every producer Kinu can see measured what it spent."
              : `The other ${coverage.calls - coverage.measured} spent tokens nothing counted — unmeasured, not free.`}
            {caveat === null
              && " Nothing qualifies these totals: they are the workspace's whole spend over its whole log."}
          </p>

          {neurons && (
            <p className="text-[10px] p-text-3 leading-relaxed mt-1.5">
              Neurons are Cloudflare&apos;s own billing unit, returned by the provider on every
              Workers AI call — the one cost figure here that was measured rather than computed. The
              dollar column is priced from the models.dev catalog, which need not even carry the
              model that served the call, so on this workspace the neurons are what was billed and
              the dollars are an estimate of it.
            </p>
          )}

          {caveat !== null && (
            <Warning>
              These totals are a floor: {caveat}.
              {(total.callsWithoutUsage > 0 || total.unpricedCalls > 0) && (
                <>
                  {" "}A trailing <Num className="p-warning">+</Num> marks a figure that some of its
                  own calls are missing from.
                </>
              )}
            </Warning>
          )}
        </>
      )}
    </div>
  );
}

/**
 * Everything qualifying the totals, as one sentence instead of four warnings.
 *
 * Four qualifiers arrive independently — a window that did not reach the end of
 * the log, producers that measured nothing, producers that measured only some of
 * their calls, and calls no catalog could price — and four stacked warning
 * paragraphs is a panel a reader learns to skip. Each clause is pushed by its own
 * condition, so a live qualifier cannot be lost to the composition and an
 * inapplicable one says nothing at all.
 *
 * Widest scope first: the window bounds every figure in the table, a silent
 * producer bounds the tokens, and a missing rate bounds only the dollars. Null
 * when the totals need no qualifying, which is the one case the panel is allowed
 * to state positively.
 */
function spendCaveat(spend: WorkspaceSpend): string | null {
  const { total, coverage } = spend;
  const clauses: string[] = [];
  if (!spend.complete) {
    clauses.push("the log is longer than the window named above, so these are the workspace's newest calls and not its life");
  }
  // Passive, so one producer and four read the same. `Judges measured nothing`
  // and `Judges, MCTS rollouts measured nothing` cannot both be grammatical with
  // a pronoun in the clause, and a list this short is not worth an Oxford comma
  // formatter.
  if (coverage.silent.length > 0) {
    clauses.push(`nothing at all was measured from ${sourceList(coverage.silent)}`);
  }
  if (coverage.partial.length > 0) {
    clauses.push(`only some calls from ${sourceList(coverage.partial)} were measured`);
  }
  if (total.unpricedCalls > 0) {
    clauses.push(`${total.unpricedCalls} measured call${total.unpricedCalls === 1 ? "" : "s"} carried no models.dev rate`);
  }
  return clauses.length === 0 ? null : clauses.join("; ");
}

/** A producer's share of the tokens the workspace actually measured. Null when
 *  either side is unreported: a silent producer has no share, and no row has one
 *  when nothing at all was measured. */
const shareOfTokens = (tokens: number | undefined, measured: number | undefined): number | null =>
  tokens === undefined || measured === undefined || measured === 0 ? null : tokens / measured;

/**
 * The numeric cells every spend row carries, in provenance order: what the
 * provider measured, then what Kinu derived.
 *
 * Shared by the producer rows and the total so a floor can never be marked in
 * one and swallowed in the other. `className` carries the row's emphasis and is
 * deliberately NOT applied to the dollar cell — that figure is a catalog rate
 * applied to somebody else's measurement, and it reads one step quieter than the
 * counts beside it however important the row is.
 */
function SpendCells(
  { row, measuredTokens, neurons, className }: {
    row: Omit<ProducerSpend, "source">;
    measuredTokens: number | undefined;
    neurons: boolean;
    className: string;
  },
) {
  const tokens = usageTotal(row.usage);
  const unpriced = usdNote(row);
  return (
    <>
      <td className="py-1 text-right w-20">
        <Num
          className={`text-[11px] ${className}`}
          title={countNote(tokens, row, "No call here reported an input or output count.")}
        >
          {fmtTokens(tokens)}
          {tokens !== undefined && row.callsWithoutUsage > 0 && <Floor />}
        </Num>
      </td>
      <td className="py-1 text-right w-12">
        <Num className="text-[11px] p-text-2">{fmtPct(shareOfTokens(tokens, measuredTokens), 1)}</Num>
      </td>
      {neurons && (
        <td className="py-1 text-right w-16">
          <Num
            className={`text-[11px] ${className}`}
            title={countNote(
              row.usage.neurons, row,
              "No call from this producer reported neurons — not every provider bills in them.",
            )}
          >
            {fmtTokens(row.usage.neurons)}
            {row.usage.neurons !== undefined && row.callsWithoutUsage > 0 && <Floor />}
          </Num>
        </td>
      )}
      <td className="py-1 text-right w-16">
        <Num className="text-[11px] p-text-2" title={unpriced}>
          {row.usd === undefined ? "—" : fmtUsd(row.usd)}
          {row.usd !== undefined && unpriced !== undefined && <Floor />}
        </Num>
      </td>
    </>
  );
}

/** The figure this follows is a floor. What is missing from it is on the cell's
 *  own title, and what the mark means is stated once in the coverage note. */
function Floor() {
  return <span className="p-warning">+</span>;
}

/**
 * Why a count is short, or why there is none at all — absent when the count is a
 * whole measurement, because a tooltip on a figure with nothing to qualify is
 * noise.
 *
 * `missing` is the column's own reason for an em dash. It is only reached when
 * the provider DID report something for at least one call, since a producer that
 * reported nothing at all has one explanation covering every column.
 */
function countNote(
  value: number | undefined, row: Omit<ProducerSpend, "source">, missing: string,
): string | undefined {
  if (value === undefined) {
    return row.callsWithoutUsage === row.calls
      ? `The provider reported no usage at all for any of these ${row.calls} calls — counted, never measured.`
      : missing;
  }
  return row.callsWithoutUsage === 0
    ? undefined
    : `${row.callsWithoutUsage} of ${row.calls} calls reported no usage, so this count is a floor.`;
}

/** What a dollar figure leaves out. A call the provider reported no usage for
 *  cannot be priced either, so both gaps land on the same figure and both are
 *  named; an absent figure is unpriced, never free. */
function usdNote(row: Omit<ProducerSpend, "source">): string | undefined {
  const gaps: string[] = [];
  if (row.unpricedCalls > 0) gaps.push(`${row.unpricedCalls} carried no models.dev rate`);
  if (row.callsWithoutUsage > 0) gaps.push(`${row.callsWithoutUsage} reported no usage to price`);
  if (gaps.length === 0) return undefined;
  const missing = `Of ${row.calls} calls, ${gaps.join(" and ")}.`;
  return row.usd === undefined ? `${missing} Unpriced, never free.` : `${missing} This figure is a floor.`;
}

/** Producer names for prose, from the one label map — a second list here is how
 *  a producer added to `SPEND_SOURCES` reaches the owner as `platform`. */
const sourceList = (sources: readonly SpendSource[]): string =>
  sources.map((source) => SPEND_SOURCE_LABEL[source]).join(", ");

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
        <Empty>
          No step in the window reported BOTH an input count and a cache-read count, so there is no
          hit rate to show. A provider that never mentions its cache has no measured hit rate — 0%
          would claim a total miss on evidence that does not exist.
        </Empty>
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
