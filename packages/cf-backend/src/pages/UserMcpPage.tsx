import { PlugsConnectedIcon } from "@phosphor-icons/react";
import { McpServersSection } from "@/components/account/McpServersPanel";
import { FormPage } from "@/components/ui/PageHeader";

export default function UserMcpPage() {
  return <FormPage icon={<PlugsConnectedIcon size={22} />} title="MCP servers"><McpServersSection /></FormPage>;
}
