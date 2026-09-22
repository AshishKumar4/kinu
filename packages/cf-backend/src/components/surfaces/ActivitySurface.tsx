/**
 * Provider-reported figures are labelled `API`; unsourced figures render as an em dash and a reason, never zero.
 * The dollar column (`priceCall`) is a floor when a rate is missing, so it is dimmed and last.
 */
import { useCallback } from "react";
import {
  GaugeIcon, CurrencyDollarIcon, LightningIcon, WarningCircleIcon,
  ClockCounterClockwiseIcon,
} from "@phosphor-icons/react";
import { Loader } from "@cloudflare/kumo";
import { LoadFailure } from "@/components/ui/LoadFailure";
import { useAsyncResource, lastValue } from "@/hooks/use-async-resource";
import { fmtTokens, fmtUsd, fmtPct } from "@kinu.run/core";
import type { ActivitySnapshot, CacheHitStats, Rpc } from "@kinu.run/core";
import { SPEND_SOURCE_DETAIL, SPEND_SOURCE_LABEL, usageTotal } from "@kinu.run/core";
import type {
  ActivityLogEntry, ContextComposition, ContextPlane, ProducerSpend, SpendSource, WorkspaceSpend,
} from "@kinu.run/core";
import { breakdownView, shareOfMeasured, type BreakdownPlane, type BreakdownRow } from "@kinu.run/core";

const STREAMING_POLL_MS = 1500;

const IDLE_POLL_MS = 10_000;

/** One brass ramp, not five hues: one quantity split by origin. */
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
      <CacheBlock cacheHit={snap.telemetry.cacheHit} />
      <LogBlock log={snap.log} />
    </div>
  );
}


function BlockHeader(
  { icon: Icon, title, note }: { icon: React.ComponentType<{ size?: number; className?: string }>; title: string; note?: string },
) {
  return (
    <div className="flex items-baseline gap-2 mb-2.5">
      <Icon size={13} className="p-accent self-center" />
      <h3 className="p-title p-text">{title}</h3>
      {note && <span className="p-meta p-text-3 ml-auto text-right">{note}</span>}
    </div>
  );
}

function Num(
  { children, className = "", title }:
  { children: React.ReactNode; className?: string; title?: string },
) {
  return <span className={`font-mono tabular-nums ${className}`} title={title}>{children}</span>;
}

function Source({ kind }: { kind: "API" | "local" }) {
  return (
    <span
      className={`px-1 py-px rounded-sm uppercase tracking-wide ${kind === "API" ? "p-badge-info" : "p-badge-neutral"}`}
      title={kind === "API"
        ? "The provider's own count for this step."
        : "Character counts from the prompt Kinu composed, not provider tokens."}
    >{kind}</span>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="p-row-text p-text-3">{children}</p>;
}

function Warning({ children }: { children: React.ReactNode }) {
  return (
    <p className="flex items-start gap-1.5 p-meta p-warning mt-1.5">
      <WarningCircleIcon size={12} className="shrink-0 mt-px" />
      <span>{children}</span>
    </p>
  );
}


function ContextBlock({ snap }: { snap: ActivitySnapshot }) {
  const { latest, contextWindow } = snap;

  if (latest === null) {
    return (
      <section>
        <BlockHeader icon={GaugeIcon} title="Context" />
        <Empty>No model step has reported usage yet. The next turn fills this in.</Empty>
      </section>
    );
  }

  // Absent, not zero: the provider may have reported usage without a prompt-token count.
  const { input, cacheRead } = latest.usage;

  const windowShare = input !== undefined && contextWindow !== null && contextWindow > 0
    ? input / contextWindow
    : null;

  const measure = contextWindow !== null ? `of ${fmtTokens(contextWindow)} tokens` : "tokens";

  return (
    <section>
      <BlockHeader
        icon={GaugeIcon}
        title="Context"
        note={`step ${latest.stepIndex} · ${new Date(latest.at).toLocaleTimeString()}`}
      />

      <div className="flex items-end gap-2 mb-1">
        <Num className="text-[22px] leading-none p-text">{input === undefined ? "—" : input.toLocaleString()}</Num>
        <span className="p-meta p-text-2 pb-px">
          {input === undefined ? "input tokens not reported" : measure}
        </span>
        <span className="ml-auto pb-px"><Source kind="API" /></span>
      </div>

      {windowShare !== null ? (
        <>
          <Meter value={windowShare} />
          <p className="p-meta p-text-3 mt-1">
            {fmtPct(windowShare, 1)} of the window · {cacheRead === undefined
              ? "the provider reported no cache-read count for this step"
              : `${cacheRead.toLocaleString()} of those input tokens were a cache read`}
          </p>
        </>
      ) : (
        <p className="p-meta p-text-3 mt-1">
          {input === undefined
            ? "This provider reported no input count."
            : "Context window unknown."}
        </p>
      )}

      <Breakdown context={latest.context} />
    </section>
  );
}

function Meter({ value }: { value: number }) {
  const pct = Math.min(Math.max(value, 0), 1) * 100;
  const belowDanger = value >= 0.7 ? "var(--c-warning)" : "var(--c-accent)";
  const tone = value >= 0.9 ? "var(--c-danger)" : belowDanger;

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
          This step recorded no breakdown.
        </Empty>
      </div>
    );
  }

  const { planes, measuredChars, span } = breakdownView(context);

  return (
    <div className="mt-4">
      <div className="flex items-baseline gap-2 mb-2">
        <h4 className="p-title p-text-2">Composed content</h4>
        <Source kind="local" />
        <span className="ml-auto p-meta p-text-3">
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

      <p className="p-meta p-text-3 mt-2.5 pt-2.5 border-t p-border">
        These rows count characters in the prompt content Kinu composed.
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
            title={`${PLANE_LABEL[row.plane]}: ${row.chars.toLocaleString()} composed characters`}
          />
        ))}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1 mt-1.5">
        {planes.map((row) => (
          <span key={row.plane} className="flex items-center gap-1 p-meta p-text-3">
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
            <span className="p-row-text font-medium p-text">{PLANE_LABEL[plane.plane]}</span>
          </span>
        </td>
        <td className="py-1 text-right w-20"><Num className="p-row-text p-text">{plane.chars.toLocaleString()} ch</Num></td>
        <td className="py-1 text-right w-12">
          <Num className="p-row-text p-text-2">{fmtPct(shareOfMeasured(plane.chars, measuredChars), 1)}</Num>
        </td>
      </tr>
      {plane.rows.map((row: BreakdownRow) => (
        <tr key={`${plane.plane}:${row.label}`}>
          <td className="py-px pr-2 pl-[14px]">
            <span className="p-row-text p-text-3 truncate block" title={row.label}>
              {row.label}
              {row.items > 1 && <span className="p-text-3"> ×{row.items}</span>}
            </span>
          </td>
          <td className="py-px text-right"><Num className="p-row-text p-text-3">{row.chars.toLocaleString()} ch</Num></td>
          <td className="py-px text-right">
            <Num className="p-row-text p-text-3">{fmtPct(shareOfMeasured(row.chars, measuredChars), 1)}</Num>
          </td>
        </tr>
      ))}
    </>
  );
}


function CostBlock({ snap }: { snap: ActivitySnapshot }) {
  const { telemetry, spend } = snap;
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
          <span className="p-meta p-text-2 pb-px">
            over {telemetry.pricedSteps} priced steps from this agent&apos;s turns
          </span>
        </div>
      ) : (
        <Empty>
          No step of this agent&apos;s turns carried a catalog price.
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
          usage. The token totals below are a floor.
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
    </section>
  );
}

/** Producer rows cover the header's window; mission rows cover each label's whole life
 *  (what its cap is enforced against), so the halves do not sum. */
function WorkspaceSpendBlock({ spend }: { spend: WorkspaceSpend }) {
  const { producers, total, coverage } = spend;
  const { reported } = coverage;
  const measuredTokens = usageTotal(total.usage);
  const neurons = total.usage.neurons !== undefined;
  const caveat = spendCaveat(spend);

  return (
    <div className="mt-3 pt-2.5 border-t p-border">
      <div className="flex items-baseline gap-2 mb-2">
        <h4 className="p-title p-text-2">Workspace spend</h4>
        <span
          className="ml-auto p-meta p-text-3"
          title="Every recorded call in this workspace, summed over the whole log."
        >
          {coverage.calls} call{coverage.calls === 1 ? "" : "s"} · whole log
        </span>
      </div>

      {reported === null ? (
        <Empty>
          No model call has reported yet. The first call fills these rows.
        </Empty>
      ) : (
        <>
          <table className="w-full border-collapse">
            <thead>
              <tr className="p-meta p-text-3 uppercase tracking-wide">
                <th className="text-left font-normal pb-1">Producer</th>
                <th
                  className="text-right font-normal pb-1 w-20"
                  title="Input plus output, as the provider reported them. Cache reads are inside input."
                >Tokens</th>
                <th className="text-right font-normal pb-1 w-12" title="Share of the tokens this workspace measured.">Share</th>
                {neurons && (
                  <th
                    className="text-right font-normal pb-1 w-16"
                    title="Cloudflare's billing unit, reported on every Workers AI call."
                  >Neurons</th>
                )}
                <th
                  className="text-right font-normal pb-1 w-16"
                  title="Priced from the models.dev catalog. Absent means unpriced."
                >USD</th>
              </tr>
            </thead>
            <tbody>
              {producers.map((producer) => (
                <tr key={producer.source} className="border-t p-border">
                  <td className="py-1 pr-2">
                    <span className="flex items-baseline gap-1">
                      <span
                        className="p-row-text p-text truncate"
                        title={SPEND_SOURCE_DETAIL[producer.source]}
                      >{SPEND_SOURCE_LABEL[producer.source]}</span>
                      <span className="p-row-text p-text-3 shrink-0">×{producer.calls}</span>
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
                    <span className="p-row-text font-semibold p-text">Workspace total</span>
                    <span className="p-row-text p-text-3 shrink-0">×{total.calls}</span>
                  </span>
                </td>
                <SpendCells
                  row={total} measuredTokens={measuredTokens} neurons={neurons}
                  className="font-semibold p-text"
                />
              </tr>
            </tbody>
            {spend.missions.length > 0 && (
              <tbody>
                <tr>
                  <th
                    colSpan={neurons ? 5 : 4}
                    className="text-left font-normal pt-3 pb-1 p-meta p-text-3 uppercase tracking-wide"
                    title="Each mission's whole life, because a cap is cumulative."
                  >
                    By mission · whole life
                  </th>
                </tr>
                {spend.missions.map((mission) => (
                  <tr key={mission.label} className="border-t p-border">
                    <td className="py-1 pr-2">
                      <span className="flex items-baseline gap-1">
                        <span
                          className="p-row-text p-text truncate"
                          title={mission.parent === null
                            ? "A top-level mission. Everything it delegates debits it."
                            : `Nested under "${mission.parent}", which every debit here also charges.`}
                        >{mission.label}</span>
                        <span className="p-row-text p-text-3 shrink-0">×{mission.calls}</span>
                        {mission.exhausted && (
                          <span className="px-1 rounded-sm p-badge-danger shrink-0">spent</span>
                        )}
                      </span>
                    </td>
                    <td className="py-1 text-right w-20">
                      <Num
                        className="p-row-text p-text"
                        title={mission.limits.tokens === undefined
                          ? "Metered, uncapped in tokens."
                          : `${mission.remaining.tokens?.toLocaleString() ?? 0} of ${mission.limits.tokens.toLocaleString()} tokens left.`}
                      >{fmtTokens(mission.spent.tokens)}</Num>
                    </td>
                    <td className="py-1 text-right w-12">
                      <Num
                        className="p-row-text p-text-3"
                        title="This row is cumulative; the total above is a window."
                      >—</Num>
                    </td>
                    {neurons && <td className="py-1 text-right w-16"><Num className="p-row-text p-text-3">—</Num></td>}
                    <td className="py-1 text-right w-16">
                      <Num
                        className="p-row-text p-text-2"
                        title={mission.pricing.source === "catalog"
                          ? "Every token priced from the models.dev catalog."
                          : `${mission.pricing.blendedTokens.toLocaleString()} of these tokens used the blended fallback rate, not catalog rates.`}
                      >
                        {fmtUsd(mission.spent.usd)}
                        {mission.limits.usd !== undefined && (
                          <span className="p-text-3"> / {fmtUsd(mission.limits.usd)}</span>
                        )}
                      </Num>
                    </td>
                  </tr>
                ))}
              </tbody>
            )}
          </table>

          <p className="p-meta p-text-3 mt-2.5 pt-2.5 border-t p-border">
            <Num className="p-text-2">{fmtPct(reported, reported === 1 ? 0 : 1)}</Num> of the{" "}
            {coverage.calls} known call{coverage.calls === 1 ? "" : "s"} reported usage.{" "}
            {reported === 1
              ? "Every call reported usage."
              : `The other ${coverage.calls - coverage.measured} reported none.`}
            {caveat === null
              && " These totals cover the whole log."}
          </p>

          {spend.offTurnShare !== null && (
            <p className="p-meta p-text-3 mt-1.5">
              <Num className="p-text-2">{fmtPct(spend.offTurnShare, 1)}</Num> of the measured tokens
              went on work outside this agent&apos;s turns. The figure above counts none of it.
            </p>
          )}

          {neurons && (
            <p className="p-meta p-text-3 mt-1.5">
              Neurons are Cloudflare&apos;s billing unit, reported on every Workers AI call. The
              dollar column is priced from the models.dev catalog, so it is an estimate.
            </p>
          )}

          {caveat !== null && (
            <Warning>
              These totals are a floor: {caveat}.
              {(total.callsWithoutUsage > 0 || total.unpricedCalls > 0) && (
                <>
                  {" "}A trailing <Num className="p-warning">+</Num> means some of that figure&apos;s
                  own calls reported nothing.
                </>
              )}
            </Warning>
          )}
        </>
      )}
    </div>
  );
}

function spendCaveat(spend: WorkspaceSpend): string | null {
  const { total, coverage } = spend;
  const clauses: string[] = [];

  if (coverage.silent.length > 0) {
    clauses.push(`nothing at all was measured from ${sourceList(coverage.silent)}`);
  }

  if (coverage.partial.length > 0) {
    clauses.push(`only some calls from ${sourceList(coverage.partial)} were measured`);
  }

  if (total.unpricedCalls > 0) {
    clauses.push(`${total.unpricedCalls} measured call${total.unpricedCalls === 1 ? "" : "s"} carried no models.dev rate`);
  }

  // The catalog publishes one cache-write rate; these calls used the pricier longer-retention tier.
  if (total.floorPricedCalls > 0) {
    clauses.push(`${total.floorPricedCalls} priced call${total.floorPricedCalls === 1 ? "" : "s"} wrote cache at a retention tier the catalog does not rate`);
  }

  return clauses.length === 0 ? null : clauses.join("; ");
}

const shareOfTokens = (tokens: number | undefined, measured: number | undefined): number | null =>
  tokens === undefined || measured === undefined || measured === 0 ? null : tokens / measured;

/** `className` is deliberately not applied to the dollar cell: a derived figure reads quieter. */
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
          className={`p-row-text ${className}`}
          title={countNote(tokens, row, "No call here reported an input or output count.")}
        >
          {fmtTokens(tokens)}
          {tokens !== undefined && row.callsWithoutUsage > 0 && <Floor />}
        </Num>
      </td>
      <td className="py-1 text-right w-12">
        <Num className="p-row-text p-text-2">{fmtPct(shareOfTokens(tokens, measuredTokens), 1)}</Num>
      </td>
      {neurons && (
        <td className="py-1 text-right w-16">
          <Num
            className={`p-row-text ${className}`}
            title={countNote(
              row.usage.neurons, row,
              "No call from this producer reported neurons.",
            )}
          >
            {fmtTokens(row.usage.neurons)}
            {row.usage.neurons !== undefined && row.callsWithoutUsage > 0 && <Floor />}
          </Num>
        </td>
      )}
      <td className="py-1 text-right w-16">
        <Num className="p-row-text p-text-2" title={unpriced}>
          {row.usd === undefined ? "—" : fmtUsd(row.usd)}
          {row.usd !== undefined && unpriced !== undefined && <Floor />}
        </Num>
      </td>
    </>
  );
}

function Floor() {
  return <span className="p-warning">+</span>;
}

function countNote(
  value: number | undefined, row: Omit<ProducerSpend, "source">, missing: string,
): string | undefined {
  if (value === undefined) {
    return row.callsWithoutUsage === row.calls
      ? `The provider reported no usage for these ${row.calls} calls.`
      : missing;
  }

  return row.callsWithoutUsage === 0
    ? undefined
    : `${row.callsWithoutUsage} of ${row.calls} calls reported no usage, so this count is a floor.`;
}

function usdNote(row: Omit<ProducerSpend, "source">): string | undefined {
  const gaps: string[] = [];

  if (row.unpricedCalls > 0) gaps.push(`${row.unpricedCalls} carried no models.dev rate`);

  if (row.floorPricedCalls > 0) gaps.push(`${row.floorPricedCalls} wrote cache at an unrated retention tier`);

  if (row.callsWithoutUsage > 0) gaps.push(`${row.callsWithoutUsage} reported no usage to price`);

  if (gaps.length === 0) return undefined;
  const missing = `Of ${row.calls} calls, ${gaps.join(" and ")}.`;

  return row.usd === undefined ? `${missing} Unpriced.` : `${missing} This figure is a floor.`;
}

/** From the one label map, so a producer added to `SPEND_SOURCES` gets its name. */
const sourceList = (sources: readonly SpendSource[]): string =>
  sources.map((source) => SPEND_SOURCE_LABEL[source]).join(", ");

function Stat({ label, value, size = "normal" }: { label: string; value: string; size?: "normal" | "small" }) {
  return (
    <div>
      <dt className="p-meta p-text-3 uppercase tracking-wide">{label}</dt>
      <dd><Num className={size === "small" ? "p-meta p-text-2" : "p-row-text p-text"}>{value}</Num></dd>
    </div>
  );
}


export function CacheBlock({ cacheHit }: { cacheHit: CacheHitStats }) {
  return (
    <section>
      <BlockHeader
        icon={LightningIcon}
        title="Prompt cache"
        note={`${cacheHit.samples} sampled step${cacheHit.samples === 1 ? "" : "s"}`
          + (cacheHit.warms > 0 ? ` · warmed ${cacheHit.warms}` : "")}
      />
      {cacheHit.samples === 0 ? (
        <Empty>
          No step in the window reported both an input count and a cache-read count, so there is no
          hit rate.
        </Empty>
      ) : (
        <>
          <dl className="mb-3">
            <dt className="p-meta p-text-3 uppercase tracking-wide">EMA</dt>
            <dd><Num className="text-[22px] leading-none p-text">{fmtPct(cacheHit.ema, 1)}</Num></dd>
          </dl>
          <dl className="grid grid-cols-4 gap-x-3 gap-y-1">
            <Stat label="Last" value={fmtPct(cacheHit.last, 1)} />
            <Stat label="Mean" value={fmtPct(cacheHit.mean, 1)} />
            <Stat label="p95" value={fmtPct(cacheHit.p95, 1)} size="small" />
            <Stat label="p99" value={fmtPct(cacheHit.p99, 1)} size="small" />
          </dl>
          <p className="p-meta p-text-3 mt-2">
            Cached input over total input, per step. Cached tokens are a subset of the billed input.
            The EMA weights recent steps at α={cacheHit.emaAlpha}. The mean, p95 and p99 cover the
            {" "}{cacheHit.samples} retained step{cacheHit.samples === 1 ? "" : "s"}
            {cacheHit.warms > 0
              ? `, and exclude the ${cacheHit.warms} idle refresh${cacheHit.warms === 1 ? "" : "es"} that kept the prefix warm`
              : ""}.
          </p>
        </>
      )}
    </section>
  );
}


/** `elapsedMs` is 0 when no turn was in flight, so zero renders as an em dash, not 0 ms. */
export function LogBlock({ log }: { log: readonly ActivityLogEntry[] }) {
  const rows: React.ReactNode[] = [];

  for (let i = log.length - 1; i >= 0; i -= 1) {
    const row = log[i];

    rows.push(<LogRow key={`${String(row.createdAt)}:${String(i)}`} row={row} />);
  }

  return (
    <section>
      <BlockHeader
        icon={ClockCounterClockwiseIcon}
        title="Activity log"
        note={log.length === 0 ? undefined
          : `${log.length} row${log.length === 1 ? "" : "s"} · newest first`}
      />
      {log.length === 0 ? (
        <Empty>
          Nothing has been logged yet. The first turn starts the log.
        </Empty>
      ) : (
        <ol className="max-h-72 overflow-y-auto rounded-lg border p-border p-surface m-0 list-none p-0">
          {rows}
        </ol>
      )}
    </section>
  );
}

function LogRow({ row }: { row: ActivityLogEntry }) {
  const outsideTurn = row.elapsedMs === 0;

  return (
    <li className="flex items-baseline gap-2 px-2 py-1 border-b p-border last:border-0">
      <Num className="p-meta p-text-3 shrink-0">
        {new Date(row.createdAt).toLocaleTimeString()}
      </Num>
      <span className="p-annotation p-text shrink-0">{row.event}</span>
      {row.detail === null ? null : (
        <span className="p-meta p-text-3 min-w-0 flex-1 truncate" title={row.detail}>
          {row.detail}
        </span>
      )}
      <Num
        className={`p-meta shrink-0 ${row.detail === null ? "ml-auto" : ""} ${outsideTurn ? "p-text-3" : "p-text-2"}`}
        title={outsideTurn
          ? "Written outside a turn, so there is no elapsed time to report."
          : "Milliseconds into the turn that wrote this row."}
      >{outsideTurn ? "—" : `${String(row.elapsedMs)} ms`}</Num>
    </li>
  );
}
