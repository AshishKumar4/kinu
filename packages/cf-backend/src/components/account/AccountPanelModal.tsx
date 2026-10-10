import type { ComponentType } from "react";
import { Button } from "@cloudflare/kumo";
import { PlugIcon, PlugsConnectedIcon, TerminalIcon } from "@phosphor-icons/react";
import { Modal } from "@/components/ui/Modal";
import { ProvidersPanel } from "@/components/account/ProvidersPanel";
import { McpServersPanel, McpServersSection } from "@/components/account/McpServersPanel";
import type { McpServers } from "@/hooks/use-mcp-servers";
import { CliInstallCard } from "@/components/account/CliInstallCard";

export const ACCOUNT_PANELS = ['providers', 'mcp', 'cli'] as const;

export type AccountPanel = (typeof ACCOUNT_PANELS)[number];

const PANEL_HEADS = {
  providers: { title: "Providers", Icon: PlugIcon },
  mcp: { title: "MCP servers", Icon: PlugsConnectedIcon },
  cli: { title: "Install the CLI", Icon: TerminalIcon },
} satisfies Record<AccountPanel, { title: string; Icon: ComponentType<{ size?: number; className?: string }> }>;

export function AccountPanelModal({ panel, returnTo, onClose, mcp }: {
  panel: AccountPanel;
  returnTo: string;
  onClose: () => void;
  /** The page's own MCP read, when the page shows the same servers: a change here is a change there. */
  mcp?: McpServers;
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
      {panel === 'mcp' && (mcp === undefined ? <McpServersSection /> : <McpServersPanel mcp={mcp} />)}
      {panel === 'cli' && <CliInstallCard />}
    </Modal>
  );
}
