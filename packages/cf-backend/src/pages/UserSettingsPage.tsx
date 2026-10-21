/** Sections live in the URL hash (`/user/settings#devices`); each section owns its own reads. */
import { Effect } from 'effect';
import { useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { Loader } from "@cloudflare/kumo";
import { Button, buttonClass } from "@/components/ui/Button";
import { ArrowSquareOutIcon, GearSixIcon } from "@phosphor-icons/react";
import { setDisplayName, type UserProfile } from "../lib/user-api";
import { Card } from "@/components/ui/form";
import { Page } from "@/components/ui/PageHeader";
import { CardSlot } from "@/components/ui/CardSlot";
import { LoadFailure } from "@/components/ui/LoadFailure";
import { useAccount } from "@/hooks/use-account";
import { SettingsRail, settingsSection } from "@/components/SettingsRail";
import { ProfileCatalogSettings } from "@/components/ProfileCatalogSettings";
import { ProvidersPanel } from "@/components/account/ProvidersPanel";
import { SecretsPanel } from "@/components/account/SecretsPanel";
import { DisplayNameField } from "@/components/account/DisplayNameField";
import { CliInstallCard } from "@/components/account/CliInstallCard";
import { DeleteAccountCard } from "@/components/account/DeleteAccountCard";
import { InviteCard } from "@/components/account/InviteCard";
import { DevicesCard } from "@/components/devices/DevicesCard";
import { AccountUsageCard } from "@/components/account/AccountUsageCard";
import { ComputerSizeSettings } from "@/components/ComputerSize";
import { BetaSettings } from "@/components/BetaSettings";
import { AccountMemoryCard } from "@/components/account/AccountMemoryCard";
import { AppearanceCard } from "@/components/account/AppearanceCard";
import { WebSearchSettings } from "@/components/account/WebSearchSettings";
import { showing, detach } from '@kinu.run/core/obs';

function ProfileNameEditor({ profile, onSaved }: {
  profile: { email: string; displayName: string | null } | null;
  onSaved: (saved: UserProfile | null) => void;
}) {
  const [name, setName] = useState(profile?.displayName ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const stored = profile?.displayName ?? '';
  const changed = name.trim() !== stored.trim();

  const save = () => Effect.gen(function* () {
    setSaving(true);
    setError(null);

    return yield* Effect.ensuring(Effect.catchCause(Effect.gen(function* () { onSaved(yield* Effect.promise(async () => setDisplayName(name))); }), showing(setError)), Effect.sync(() => { setSaving(false); }));
  });

  return (
    <div className="space-y-2">
      <div className="flex items-end gap-2">
        <div className="flex-1">
          <DisplayNameField value={name} onChange={setName} saving={saving} />
        </div>
        <Button variant="secondary" disabled={!changed || saving} onClick={() => detach(save())}>
          {saving ? <Loader size="sm" /> : null} Save
        </Button>
      </div>
      {error && <p className="t-meta p-danger">{error}</p>}
    </div>
  );
}

export default function UserSettingsPage() {
  // The shell's one profile read: a name saved here is the name the bar and the sidebar show.
  const { profile: resource, reload, set } = useAccount();
  const profile = { resource, reload };

  // Section state lives in the URL so deep links, reloads and Back agree.
  const section = settingsSection(useLocation().hash);

  if (profile.resource.status === "loading" || profile.resource.status === "error") {
    return (
      <Page icon={<GearSixIcon size={22} />} title="Settings">
        {profile.resource.status === "loading"
          ? <div className="flex justify-center py-8"><Loader size="base" /></div>
          : <LoadFailure what="your account" message={profile.resource.message} onRetry={profile.reload} />}
      </Page>
    );
  }

  return (
    <Page icon={<GearSixIcon size={22} />} title="Settings" rule="wide">
        {/* The rail and the section's column fill the frame: 192 + 48 + 848. The active rail item names the section. */}
        <div className="flex flex-col gap-8 lg:flex-row lg:gap-12">
          <div className="lg:sticky lg:top-8 lg:w-48 lg:shrink-0 lg:self-start">
            <SettingsRail active={section} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="space-y-5">

        {section === "account" && (
          <>
            <Card title="Profile">
              <CardSlot resource={profile.resource} what="your profile" onRetry={profile.reload}>
                {(p) => (
                  <div className="space-y-5">
                    <ProfileNameEditor profile={p} onSaved={set} />
                    <dl className="grid gap-5 sm:grid-cols-2">
                      <div>
                        <dt className="t-meta p-text-3">Email</dt>
                        <dd className="t-body t-mono mt-1 p-text">{p?.email ?? 'Not available'}</dd>
                      </div>
                      <div>
                        <dt className="t-meta p-text-3">Member since</dt>
                        <dd className="t-body mt-1 p-text">{p?.createdAt ? new Date(p.createdAt).toLocaleDateString() : 'Not available'}</dd>
                      </div>
                    </dl>
                  </div>
                )}
              </CardSlot>
            </Card>

            <InviteCard />

            {profile.resource.value !== null && <DeleteAccountCard email={profile.resource.value.email} />}
          </>
        )}

        {section === "appearance" && <AppearanceCard />}

        {section === "cli" && <CliInstallCard />}

        {section === "devices" && <DevicesCard />}

        {section === "providers" && (
          <>
            <ProvidersPanel returnTo="/user/settings" />

            <Card title="MCP servers">
              <Link
                to="/user/settings/mcp"
                className={buttonClass({ size: "sm" })}
              >Manage MCP servers <ArrowSquareOutIcon size={12} /></Link>
            </Card>
          </>
        )}

        {section === "secrets" && <SecretsPanel />}

        {section === "models" && <ProfileCatalogSettings />}

        {section === "search" && <WebSearchSettings place="settings" returnTo="/user/settings#search" />}

        {section === "computer" && <ComputerSizeSettings />}

        {section === "beta" && <BetaSettings />}

        {section === "memory" && <AccountMemoryCard />}

        {section === "usage" && <AccountUsageCard />}
            </div>
          </div>
        </div>
    </Page>
  );
}
