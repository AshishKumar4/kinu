/**
 * What a program changed, as the host recorded it while it ran (WEB-3; core `execution/call-effects.ts`): the files it
 * changed, the commands it ran and how each exited, and its other operations that change something. The record is the
 * host's, bound to the call's own id, so nothing the program returns can claim it. Never "changed nothing": a program's
 * own requests go untraced, so a call with no record, or an empty one, shows no receipt.
 */
import type { ProgramEffects } from "@kinu.run/core";

function plural(count: number, one: string, many = `${one}s`): string {
  return `${String(count)} ${count === 1 ? one : many}`;
}

/** The receipt in one line, or null when the record holds nothing to say. */
function receiptLine(effects: ProgramEffects): string | null {
  const failed = effects.commands.filter((command) => command.exitCode !== 0).length;
  const operations = Object.values(effects.operations).reduce((sum, count) => sum + count, 0);
  const [only] = effects.files;

  const parts = [
    effects.files.length === 1 && only !== undefined ? `Changed ${only.path}` : null,
    effects.files.length > 1 ? `Changed ${plural(effects.files.length, "file")}` : null,
    effects.commands.length > 0 ? `ran ${plural(effects.commands.length, "command")}${failed > 0 ? `, ${String(failed)} failed` : ""}` : null,
    operations > 0 ? plural(operations, "other change") : null,
    (effects.more ?? 0) > 0 ? `${String(effects.more)} more` : null,
  ].filter((part) => part !== null);

  if (parts.length === 0) return null;

  const line = parts.join(" · ");

  return `${line.charAt(0).toUpperCase()}${line.slice(1)}`;
}

/** The one line under the call's row; nothing for a call with no record. */
export function CallReceipt({ effects }: { effects: ProgramEffects | null }) {
  const line = effects === null ? null : receiptLine(effects);

  if (line === null) return null;

  return <span className="t-meta col-span-3 col-start-2 min-w-0 truncate p-text-3" data-tool-receipt title={line}>{line}</span>;
}

/** The record whole, in the opened call: each file and how it changed, each command and how it exited, each operation. */
export function ReceiptDetail({ effects }: { effects: ProgramEffects | null }) {
  if (effects === null || (receiptLine(effects) === null && (effects.unclassified ?? 0) === 0)) return null;

  const operations = Object.entries(effects.operations);

  return (
    <div data-receipt>
      <div className="t-label mb-1">What it changed</div>
      <ul className="t-meta space-y-1 p-text-2">
        {effects.files.map((file) => (
          <li key={file.path} className="flex min-w-0 items-baseline gap-2" data-receipt-file={file.path} data-change={file.change}>
            <code className="t-mono min-w-0 truncate p-text">{file.path}</code>
            <span className="shrink-0 p-text-3">{file.change}</span>
          </li>
        ))}
        {effects.commands.map((command, index) => (
          <li key={`${String(index)}:${command.command}`} className="flex min-w-0 items-baseline gap-2" data-receipt-command={command.command} data-exit={command.exitCode}>
            <code className="t-mono min-w-0 truncate p-text">$ {command.command}</code>
            <span className={`shrink-0 ${command.exitCode === 0 ? "p-text-3" : "p-danger"}`}>{command.machine} · exit {command.exitCode}</span>
          </li>
        ))}
        {operations.map(([name, count]) => (
          <li key={name} className="flex min-w-0 items-baseline gap-2" data-receipt-operation={name}>
            <code className="t-mono min-w-0 truncate p-text">{name}</code>
            {count > 1 && <span className="shrink-0 p-text-3">×{count}</span>}
          </li>
        ))}
        {(effects.unclassified ?? 0) > 0 && <li className="p-text-3">{plural(effects.unclassified ?? 0, "call")} whose effect no declaration says</li>}
        {(effects.more ?? 0) > 0 && <li className="p-text-3">and {String(effects.more)} more past the record&apos;s bounds</li>}
      </ul>
    </div>
  );
}
