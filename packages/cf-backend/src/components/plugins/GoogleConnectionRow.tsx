/**
 * The Google connection: one grant to Gmail, Calendar, Drive (its Docs, Sheets and Slides) and contacts, which every
 * agent of the account reaches Google through. Shown where this deployment offers it: its operators, for now. Not an MCP
 * server, but a row like one: Connected and its ⋯ while held, `+` while offered.
 */
import { useState } from "react";
import { LinkBreakIcon, PlusIcon } from "@phosphor-icons/react";
import { GOOGLE_CONNECTION, GOOGLE_OAUTH_CRED_KEY, googleConnectPath, type ConnectEnded } from "@kinu.run/core";
import { beginConnect } from "@/lib/connect-window";
import { deleteCredential } from "@/lib/user-api";
import { lastValue, type AsyncResourceControl } from "@/hooks/use-async-resource";
import type { GoogleConnectionRead } from "@/hooks/use-mcp-servers";
import { useConfirmation } from "@/components/ui/ConfirmDialog";
import { BrandMark } from "@/components/ui/BrandMark";
import { Row, RowAction } from "@/components/ui/Row";
import { Menu } from "@/components/ui/Menu";
import { LoadFailure } from "@/components/ui/LoadFailure";
import { PluginStatusText, type RowErrors } from "@/components/plugins/McpPresetCards";
import { CONNECTED, NOT_ADDED } from "@/components/plugins/mcp-status";

/** Which of Plugins' lists the row is drawn in: Connected while held, Add while offered or while a first read that
 *  failed offers its retry, and neither where the deployment does not offer it to this account. */
export function googleList(google: AsyncResourceControl<GoogleConnectionRead>): "connected" | "add" | null {
  const read = lastValue(google.resource);

  if (read === null) return google.resource.status === "error" ? "add" : null;

  if (!read.available) return null;

  return read.connection === null ? "add" : "connected";
}

/** `google`: the page's one read of the connection (`McpServers.google`), which this row reads again after a change. */
export function GoogleConnectionRow({ google, errors }: {
  google: AsyncResourceControl<GoogleConnectionRead>;
  /** Where the rows keep their failures, when the row moves between lists; else the row keeps its own. */
  errors?: RowErrors;
}) {
  const { resource, reload } = google;
  const read = lastValue(resource);
  // How the last connect or disconnect ended, in Google's or Kinu's words: the finish page closed with the only copy.
  const [own, setOwn] = useState<string | null>(null);
  const said = errors === undefined ? own : errors.of(GOOGLE_CONNECTION);
  const setSaid = (text: string | null) => { if (errors === undefined) setOwn(text); else errors.set(GOOGLE_CONNECTION, text); };

  const { ask, dialog } = useConfirmation();

  // A read that failed with nothing shown yet says so, with a retry: hidden, the row could never be reached again.
  if (read === null && resource.status === "error") return <LoadFailure what="your Google connection" message={resource.message} onRetry={reload} />;

  if (read === null || !read.available) return null;
  const { connection } = read;

  const connect = () => {
    setSaid(null);
    const started = beginConnect();

    started.start(googleConnectPath(started.id), (ended: ConnectEnded) => {
      if (ended.error !== null) setSaid(`Google did not connect: ${ended.error}`);
      reload();
    });
  };

  const leave = (revoke: boolean) => async () => {
    const { unrevoked } = await deleteCredential(GOOGLE_OAUTH_CRED_KEY, revoke);

    setSaid(unrevoked === null ? null : `Google is disconnected from Kinu but not revoked. ${unrevoked}`);
    reload();
  };

  const disconnect = () => ask({
    title: "Disconnect Google?",
    body: "Your agents lose Gmail, Calendar, Drive and contacts. Disconnect removes Kinu's copy of the sign-in; revoking also asks Google to end it.",
    action: "Disconnect", failed: "Could not disconnect",
    run: leave(false),
    alternate: { action: "Disconnect and revoke at Google", run: leave(true) },
  });

  return (
    <>
      {dialog}
      <Row attributes={{ "data-plugin": "Google", "data-plugin-source": GOOGLE_CONNECTION, "data-plugin-state": connection === null ? NOT_ADDED : CONNECTED.label }}
        title="Google" meta={connection === null ? "Gmail, Calendar, Drive, contacts" : connection.account}
        tile={<BrandMark brand="google" size={18} />}
        status={connection === null ? undefined : <PluginStatusText shown={CONNECTED} />}
        action={connection === null
          ? (
            <RowAction data-plugin-add onClick={connect} aria-label="Connect Google" title="Connect Google">
              <PlusIcon size={16} />
            </RowAction>
          )
          : <Menu name="Google" items={[{ label: "Disconnect", icon: <LinkBreakIcon size={16} />, onSelect: disconnect, danger: true, marker: "data-plugin-disconnect" }]} />}
        below={said === null ? undefined : <p className="t-status p-danger" data-plugin-error>{said}</p>} />
    </>
  );
}
