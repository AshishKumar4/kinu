/** Sections live in the URL hash (`/user/settings#devices`); each section owns its own reads. */
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
import { AccountUsageCard } from "@/components/account/AccountUsageCard";
import { renderThrownChain } from '@kinu.run/core/obs';

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

function PageHeader() {
  return (
    <header className="border-b p-border pb-6">
      <Link to="/" className="p-btn-ghost -ml-2 mb-4 inline-flex h-6.5 items-center gap-1 rounded-md px-2 text-xs">
        <ArrowLeftIcon size={12} /> Home
      </Link>
      <p className="p-eyebrow">Account</p>
      <h1 className="p-display mt-1 text-[26px] leading-8">Account settings</h1>
      <p className="mt-1.5 p-row-text p-text-3">
        What you set here applies to every workspace you own.
      </p>
    </header>
  );
}

export default function UserSettingsPage() {
  const profile = useAsyncResource(getProfile);

  // Section state lives in the URL so deep links, reloads and Back agree.
  const section = settingsSection(useLocation().hash);

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

        {section === "usage" && <AccountUsageCard />}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
