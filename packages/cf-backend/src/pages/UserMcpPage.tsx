import { PlugsConnectedIcon } from "@phosphor-icons/react";
import { McpServersSection } from "@/components/account/McpServersPanel";
import { Page } from "@/components/ui/PageHeader";

export default function UserMcpPage() {
  return <Page icon={<PlugsConnectedIcon size={22} />} title="MCP servers"><McpServersSection /></Page>;
}
