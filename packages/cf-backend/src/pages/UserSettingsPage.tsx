/**
 * User-level settings — credentials, devices and defaults that apply across
 * ALL of this user's agents. Connect ChatGPT once → every agent sees it.
 *
 * FIVE SECTIONS, ONE AT A TIME. This was one column of eight stacked cards,
 * and the owner's report was that it is hard to navigate: the thing you came
 * for is somewhere in a scroll, and a link that lands you on it lands you
 * mid-page with no way to tell where you are. The section is now in the URL
 * hash, the rail says which one you are reading, the section head says what
 * it changes, and every deep link that existed (`/user/settings#devices`)
 * opens its section instead of scrolling to it.
 *
 * One grammar inside a section: a `Card` names a group and what it applies
 * to; a `Field` names one setting and what it does; lists are `p-group` rows;
 * anything that takes something away is a quiet button in danger ink, kept
 * apart from the facts beside it.
 *
 *   #account    profile
 *   #devices    the machines linked to this account
 *   #providers  Cloudflare AI, ChatGPT, API keys, MCP servers
 *   #models     the default model and the role/tier catalog
 *   #cli        the one command that installs the CLI
 *
 * The page's own read is the profile alone, because it decides the page's
 * loading and failure states. A section's reads belong to the section: the
 * providers panel owns the connection reads, and the devices card its own
 * roster — a section switch mounts its reads fresh rather than re-reading an
 * account that has not changed.
 */
import { useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { Button, Loader } from "@cloudflare/kumo";
import {
  PlugsConnectedIcon, UserCircleIcon, ArrowSquareOutIcon,
  ArrowLeftIcon,
} from "@phosphor-icons/react";
import {
  getProfile, setDisplayName,
} from "../lib/user-api";
import { Card } from "@/components/ui/form";
import { CardSlot } from "@/components/ui/CardSlot";
import { LoadFailure } from "@/components/ui/LoadFailure";
import { useAsyncResource } from "@/hooks/use-async-resource";
import { SettingsRail, SettingsSectionHead, settingsSection } from "@/components/SettingsRail";
import { ProfileCatalogSettings } from "@/components/ProfileCatalogSettings";
import { ProvidersPanel } from "@/components/account/ProvidersPanel";
import { DisplayNameField } from "@/components/account/DisplayNameField";
import { CliInstallCard } from "@/components/account/CliInstallCard";
import { DeleteAccountCard } from "@/components/account/DeleteAccountCard";
import { DevicesCard } from "@/components/devices/DevicesCard";
import { renderThrownChain } from '@kinu.run/core/obs';

/** The Profile card's editable half: the shared DisplayNameField plus the
 *  quiet Save that stays asleep until the name actually changed. Kept out of
 *  the CardSlot body because it owns state. */
function ProfileNameEditor({ profile, onSaved }: {
  profile: { email: string; displayName: string | null } | null;
  onSaved: () => void;
}) {
  const [name, setName] = useState(profile?.displayName ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const stored = profile?.displayName ?? '';
  const changed = name.trim() !== stored.trim();

  const save = async () => {
    setSaving(true);
    setError(null);

    try { await setDisplayName(name); onSaved(); }
    catch (cause) { setError(renderThrownChain({ cause })); }
    finally { setSaving(false); }
  };

  return (
    <div className="space-y-2">
      <div className="flex items-end gap-2">
        <div className="flex-1">
          <DisplayNameField value={name} onChange={setName} saving={saving} />
        </div>
        <Button variant="secondary" size="sm" disabled={!changed || saving} onClick={save}>
          {saving ? <Loader size="sm" /> : null} Save
        </Button>
      </div>
      {error && <p className="text-xs p-danger">{error}</p>}
    </div>
  );
}

/** The page frame both states of the page share: the way back, the title,
 *  and what everything under it applies to. */
function PageHeader() {
  return (
    <header className="border-b p-border pb-6">
      <Link to="/" className="p-btn-ghost -ml-2 mb-4 inline-flex h-6.5 items-center gap-1 rounded-md px-2 text-xs">
        <ArrowLeftIcon size={12} /> Workspaces
      </Link>
      <p className="p-eyebrow">Account</p>
      {/* Page title in the display face at 26px: above the workbench scale by design. */}
      <h1 className="p-display mt-1 text-[26px] leading-8">Account settings</h1>
      <p className="mt-1.5 p-row-text p-text-3">
        What you set here applies to every workspace you own.
      </p>
    </header>
  );
}

export default function UserSettingsPage() {
  const profile = useAsyncResource(getProfile);

  // Section state lives in the URL, so a deep link, a reload and the browser's
  // Back button all land on the same section.
  const section = settingsSection(useLocation().hash);

  // Before the profile read settles there is one quiet page loader, and when it
  // fails there is one failure — a second copy of either says nothing more.
  // The sections read for themselves: each card publishes on its own.
  if (profile.resource.status === "loading" || profile.resource.status === "error") {
    return (
      <div className="h-full overflow-y-auto">
        <div className="mx-auto max-w-5xl space-y-8 px-5 py-8 sm:px-6">
          <PageHeader />
          {profile.resource.status === "loading"
            ? <div className="flex justify-center py-10"><Loader size="base" /></div>
            : <LoadFailure what="your account" message={profile.resource.message} onRetry={profile.reload} />}
        </div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl space-y-8 px-5 py-8 sm:px-6">
        <PageHeader />
        {/* A side rail needs room the workspace sidebar has already taken:
            below 64rem the same entries become a tab strip above the section. */}
        <div className="flex flex-col gap-7 lg:flex-row lg:gap-10">
          <SettingsRail active={section} />
          <div className="min-w-0 flex-1 lg:max-w-[820px]">
            <SettingsSectionHead section={section} />
            <div className="space-y-5">

        {section === "account" && (
          <>
            <Card title="Profile" icon={UserCircleIcon}>
              <CardSlot resource={profile.resource} what="your profile" onRetry={profile.reload}>
                {(p) => (
                  <div className="space-y-5">
                    <ProfileNameEditor profile={p} onSaved={profile.reload} />
                    <dl className="grid gap-5 sm:grid-cols-2">
                      <div>
                        <dt className="p-meta p-text-3">Email</dt>
                        <dd className="mt-1 font-mono p-row-text p-text">{p?.email ?? 'Not available'}</dd>
                      </div>
                      <div>
                        <dt className="p-meta p-text-3">Member since</dt>
                        <dd className="mt-1 p-row-text p-text">{p?.createdAt ? new Date(p.createdAt).toLocaleDateString() : 'Not available'}</dd>
                      </div>
                    </dl>
                  </div>
                )}
              </CardSlot>
            </Card>

            {profile.resource.value !== null && <DeleteAccountCard email={profile.resource.value.email} />}
          </>
        )}

        {section === "cli" && <CliInstallCard />}

        {/* Devices — account-level PC/device registration; every agent can use
            a connected device (with consent). The workspace surfaces open the
            same connect panel in place; this is where the roster lives. */}
        {section === "devices" && <DevicesCard />}

        {section === "providers" && (
          <>
            <ProvidersPanel returnTo="/user/settings" />

            <Card title="MCP servers" icon={PlugsConnectedIcon}>
              <Link
                to="/user/settings/mcp"
                className="p-btn-quiet inline-flex h-6.5 items-center gap-1 px-2.5 text-xs"
              >Manage MCP servers <ArrowSquareOutIcon size={12} /></Link>
            </Card>
          </>
        )}

        {section === "models" && <ProfileCatalogSettings />}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
