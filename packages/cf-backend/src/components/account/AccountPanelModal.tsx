/**
 * The three account panels, hosted in the one Modal shell, so a surface that
 * points at setup work — the home card, the plugins page, the onboarding
 * wizard — opens it in place instead of navigating away.
 */
import type { ComponentType } from "react";
import { Button } from "@cloudflare/kumo";
import { PlugIcon, PlugsConnectedIcon, TerminalIcon } from "@phosphor-icons/react";
import { Modal } from "@/components/ui/Modal";
import { ProvidersPanel } from "@/components/account/ProvidersPanel";
import { McpServersPanel } from "@/components/account/McpServersPanel";
import { CliInstallCard } from "@/components/account/CliInstallCard";

export const ACCOUNT_PANELS = ['providers', 'mcp', 'cli'] as const;

export type AccountPanel = (typeof ACCOUNT_PANELS)[number];

const PANEL_HEADS = {
  providers: { title: "Providers", Icon: PlugIcon },
  mcp: { title: "MCP servers", Icon: PlugsConnectedIcon },
  cli: { title: "Install the CLI", Icon: TerminalIcon },
} satisfies Record<AccountPanel, { title: string; Icon: ComponentType<{ size?: number; className?: string }> }>;

export function AccountPanelModal({ panel, returnTo, onClose }: {
  panel: AccountPanel;
  returnTo: string;
  onClose: () => void;
}) {
  const { title, Icon } = PANEL_HEADS[panel];

  return (
    <Modal
      title={title}
      onClose={onClose}
      icon={<Icon size={18} className="p-accent" />}
      maxWidthClass="max-w-2xl"
      footer={<Button variant="ghost" size="sm" onClick={onClose}>Done</Button>}
    >
      {panel === 'providers' && <ProvidersPanel returnTo={returnTo} />}
      {panel === 'mcp' && <McpServersPanel />}
      {panel === 'cli' && <CliInstallCard />}
    </Modal>
  );
}
