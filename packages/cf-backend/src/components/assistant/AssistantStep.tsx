/**
 * Setup's personal assistant step: Yes is chosen when it opens, so Next installs it; Not now leaves Home as it is, and
 * Explore keeps it for later. What it will reach is read from the tools the step before connected.
 */
import { useState, type ReactNode } from "react";
import { CloudIcon, EnvelopeSimpleIcon, GithubLogoIcon, HandPalmIcon, SunHorizonIcon } from "@phosphor-icons/react";
import { mcpPresetById } from "@kinu.run/core";
import { useMcpServers } from "@/hooks/use-mcp-servers";
import { lastValue } from "@/hooks/use-async-resource";
import { ChatMascot } from "@/components/Marks";
import { Choice, inputCls } from "@/components/ui/form";
import { Status } from "@/components/ui/Status";

export interface AssistantChoice {
  readonly install: boolean;
  readonly name: string;
  /** `HH:MM`, weekdays. */
  readonly brief: string;
}

export const DEFAULT_ASSISTANT: AssistantChoice = { install: true, name: "Kinu", brief: "08:00" };

/** Its mascot's seed: the assistant workspace's main chat, so setup shows the face Home will. */
export const ASSISTANT_SEED = "personal-assistant/main";

/** The workspace blueprint Kinu keeps for it (Explore). */
export const PERSONAL_ASSISTANT = "personal-assistant";

const BRIEF_TIMES = ["07:00", "07:30", "08:00", "08:30", "09:00", "09:30"] as const;

function Tile({ chosen, onChoose, title, badge, about, value }: {
  chosen: boolean; onChoose: () => void; title: string; badge?: string; about: string; value: string;
}) {
  return (
    <label data-assistant-tile={value}
      className="relative block cursor-pointer rounded-[14px] border p-border px-4 py-3 transition-colors hover:border-[var(--c-border-strong)] has-[:checked]:border-[var(--c-accent)] has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-[var(--c-accent-subtle)]">
      <input type="radio" name="assistant" value={value} checked={chosen} onChange={onChoose} className="sr-only" />
      <span className="flex items-baseline justify-between gap-2">
        <span className="p-row-text font-medium p-text">{title}</span>
        {badge !== undefined && <span className="p-meta p-text-3">{badge}</span>}
      </span>
      <span className="mt-1 block p-meta p-text-3">{about}</span>
    </label>
  );
}

function Reach({ icon, title, children, connected }: { icon: ReactNode; title: string; children: ReactNode; connected?: boolean | null }) {
  return (
    <li className="flex items-start gap-2.5">
      <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md bg-[var(--c-neutral-tint)] p-text-2">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-x-2">
          <span className="p-row-text font-medium p-text">{title}</span>
          {connected === true && <Status tone="success">Connected</Status>}
          {connected === false && <span className="p-meta p-text-3">connect it later</span>}
        </span>
        <span className="block p-meta p-text-3">{children}</span>
      </span>
    </li>
  );
}

export function AssistantStep({ email, choice, onChange }: { email: string; choice: AssistantChoice; onChange: (choice: AssistantChoice) => void }) {
  const servers = lastValue(useMcpServers().servers.resource) ?? [];
  const has = (preset: string) => servers.some((server) => server.presetId === preset && (server.status === "ready" || server.status === "connected"));
  const [address] = useState(() => `${email.split("@")[0] ?? "you"}@kinu.run`);

  return (
    <div className="space-y-5" data-assistant-step>
      <div role="radiogroup" aria-label="A personal assistant" className="grid gap-3 sm:grid-cols-[3fr_2fr]">
        <Tile value="yes" chosen={choice.install} onChoose={() => onChange({ ...choice, install: true })} title="Yes, set one up" badge="Recommended"
          about="Home becomes its chat. It reads your mail and GitHub, briefs you each morning, and runs bigger work in workspaces of its own." />
        <Tile value="no" chosen={!choice.install} onChoose={() => onChange({ ...choice, install: false })} title="Not now"
          about="Home stays as it is. Add it any time from Explore." />
      </div>

      {choice.install && (
        <div className="rounded-[14px] border p-border p-4" data-assistant-preview>
          <div className="flex items-center gap-3">
            <ChatMascot seed={ASSISTANT_SEED} colour={0} activity="idle" size={34} />
            <label className="flex min-w-0 flex-1 items-center gap-2">
              <span className="shrink-0 p-meta p-text-3">Its name</span>
              <input value={choice.name} maxLength={40} onChange={(event) => onChange({ ...choice, name: event.target.value })}
                aria-label="Its name" className={`${inputCls} h-8 max-w-56`} />
            </label>
          </div>
          <ul className="mt-4 grid gap-x-5 gap-y-3 sm:grid-cols-2">
            <Reach icon={<EnvelopeSimpleIcon size={14} />} title="Mail" connected={has("google") ? true : null}>
              {address} comes to {choice.name.trim() || "it"}{has("google") ? ", and it reads your Gmail" : ""}. It drafts; you send.
            </Reach>
            <Reach icon={<GithubLogoIcon size={14} />} title={mcpPresetById("github")?.title ?? "GitHub"} connected={has("github")}>
              Reviews, mentions and repositories, to read.
            </Reach>
            <Reach icon={<CloudIcon size={14} />} title={mcpPresetById("cloudflare")?.title ?? "Cloudflare"} connected={has("cloudflare")}>
              Your Workers' errors and deploys, to read.
            </Reach>
            <Reach icon={<SunHorizonIcon size={14} />} title="A brief each weekday">
              <span className="mt-1 inline-flex items-center gap-2">
                <Choice label="Brief time" size="sm" className="w-24" value={choice.brief}
                  options={BRIEF_TIMES.map((time) => ({ value: time, label: time }))}
                  onChange={(brief) => onChange({ ...choice, brief })} />
                on Home
              </span>
            </Reach>
          </ul>
          <p className="mt-4 flex items-start gap-2 border-t p-border pt-3 p-meta p-text-2">
            <HandPalmIcon size={13} className="mt-0.5 shrink-0 p-accent" />
            It asks you first, on a card, before it sends mail, creates a workspace, or starts work in one.
          </p>
        </div>
      )}
    </div>
  );
}
