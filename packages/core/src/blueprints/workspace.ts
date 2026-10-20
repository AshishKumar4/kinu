/**
 * Workspace blueprints: what a new workspace starts from, whole (its soul, its main agent's name, its layout, its
 * schedules, what it needs of the owner's and what it asks before acting). Installing one makes a workspace of the
 * owner's own; a later version never changes it. Kinu keeps its own here, in code (docs/HOME-EXPLORE.md §4).
 */
import * as v from 'valibot';
import { GALLERY_CATEGORIES, type BlueprintPage, type WorkspaceCard } from '../slates/gallery-api';
import { WORKSPACE_LAYOUTS, type WorkspaceLayout } from '../config/workspace-layout';

/** `HH:MM`, 24-hour. */
const ClockSchema = v.pipe(v.string(), v.regex(/^([01]\d|2[0-3]):[0-5]\d$/));

/** When a schedule runs, in the owner's own time: each day at a time, or every so many minutes. */
const WhenSchema = v.variant('kind', [
  v.strictObject({ kind: v.literal('daily'), at: ClockSchema }),
  v.strictObject({ kind: v.literal('every'), minutes: v.pipe(v.number(), v.integer(), v.minValue(5), v.maxValue(720)) }),
]);

export type BlueprintWhen = v.InferOutput<typeof WhenSchema>;

/** A schedule the new workspace holds: its main agent wakes with `prompt` each time it runs. `brief`: the one the
 *  installer's brief time moves. */
const AutomationSchema = v.strictObject({
  label: v.pipe(v.string(), v.nonEmpty()),
  /** What it does, as the blueprint's page says it. */
  about: v.pipe(v.string(), v.nonEmpty()),
  when: WhenSchema,
  prompt: v.pipe(v.string(), v.nonEmpty()),
  brief: v.optional(v.boolean()),
});

/** What it reaches of its owner's: a connection (an MCP preset id) or a secret by name, read or written, and why. */
const BlueprintNeedSchema = v.strictObject({
  connection: v.nullable(v.string()),
  secret: v.nullable(v.string()),
  access: v.picklist(['read', 'write']),
  why: v.string(),
});

export type BlueprintNeed = v.InferOutput<typeof BlueprintNeedSchema>;

export const WorkspaceBlueprintSchema = v.strictObject({
  id: v.pipe(v.string(), v.regex(/^[a-z0-9][a-z0-9-]{0,62}$/)),
  version: v.string(),
  title: v.pipe(v.string(), v.nonEmpty()),
  line: v.pipe(v.string(), v.nonEmpty()),
  category: v.picklist(GALLERY_CATEGORIES),
  /** SOUL.md; `{{owner}}` is the installer's name. */
  soul: v.pipe(v.string(), v.nonEmpty()),
  /** The main agent's name. */
  agent: v.pipe(v.string(), v.nonEmpty()),
  layout: v.picklist(WORKSPACE_LAYOUTS),
  automations: v.array(AutomationSchema),
  needs: v.array(BlueprintNeedSchema),
  /** What it stops and asks before doing, as its page lists it. */
  asks: v.array(v.string()),
  /** What it does, as its page says it. */
  about: v.array(v.strictObject({ title: v.string(), body: v.string() })),
  /** Its picture on Explore, by name. */
  picture: v.nullable(v.string()),
});

export type WorkspaceBlueprint = v.InferOutput<typeof WorkspaceBlueprintSchema>;

/** What an install chose: the main agent's name, and the time of the brief in the owner's own day. */
export interface BlueprintInstall {
  readonly agent?: string;
  readonly brief?: string;
  /** The owner's offset from UTC in minutes (`-new Date().getTimezoneOffset()`), so their 08:00 is theirs. */
  readonly utcOffsetMinutes: number;
  readonly owner: string;
}

/** What a new workspace is seeded with before its first turn: the orchestrator's `seedBlueprint`. */
export interface WorkspaceSeed {
  readonly blueprint: string;
  readonly layout: WorkspaceLayout;
  readonly agent: string;
  readonly schedules: readonly { readonly label: string; readonly cron: string; readonly prompt: string }[];
}

/** A daily `HH:MM` of the owner's, as the UTC cron the trigger hub reads (hour and minute fields only). */
function dailyCron(at: string, utcOffsetMinutes: number): string {
  const [hours = 0, minutes = 0] = at.split(':').map(Number);
  const utc = (((hours * 60 + minutes - utcOffsetMinutes) % 1440) + 1440) % 1440;

  return `${String(utc % 60)} ${String(Math.floor(utc / 60))} * * *`;
}

function everyCron(minutes: number): string {
  return minutes < 60 ? `*/${String(minutes)} * * * *` : `0 */${String(Math.round(minutes / 60))} * * *`;
}

/** What a blueprint installs as, for one owner and what they chose. */
export interface BlueprintBirth {
  readonly soul: string;
  readonly seed: WorkspaceSeed;
}

/** The soul and the seed a blueprint installs as, for this owner and what they chose. */
export function blueprintSeed(blueprint: WorkspaceBlueprint, install: BlueprintInstall): BlueprintBirth {
  const named = install.agent?.trim();
  const agent = named === undefined || named === '' ? blueprint.agent : named;
  const fill = (text: string) => text.replaceAll('{{owner}}', install.owner).replaceAll('{{agent}}', agent);

  return {
    soul: fill(blueprint.soul),
    seed: {
      blueprint: blueprint.id,
      layout: blueprint.layout,
      agent,
      schedules: blueprint.automations.map(({ label, when, prompt, brief }) => ({
        label,
        cron: when.kind === 'every' ? everyCron(when.minutes) : dailyCron(brief === true ? install.brief ?? when.at : when.at, install.utcOffsetMinutes),
        prompt: fill(prompt),
      })),
    },
  };
}

/** When a schedule runs, as a blueprint's page says it. */
function whenText(automation: WorkspaceBlueprint['automations'][number]): string {
  const { when } = automation;

  if (when.kind === 'every') return `Every ${String(when.minutes)} minutes`;

  return automation.brief === true ? `Each day at ${when.at}, or the time you choose` : `Each day at ${when.at}`;
}

/** A blueprint's page, from the blueprint and its listing. Its soul reads as installed, for "the owner". */
export function blueprintPage(blueprint: WorkspaceBlueprint, card: WorkspaceCard): BlueprintPage {
  return {
    workspace: card,
    about: blueprint.about,
    inside: {
      agents: [{ name: blueprint.agent, about: blueprint.line }],
      automations: blueprint.automations.map((automation) => ({ label: automation.label, when: whenText(automation), does: automation.about })),
      slates: [],
      layout: blueprint.layout,
      soul: blueprintSeed(blueprint, { owner: 'the owner', utcOffsetMinutes: 0 }).soul,
    },
    asks: blueprint.asks,
    version: blueprint.version,
    updatedAt: card.listedAt,
  };
}
