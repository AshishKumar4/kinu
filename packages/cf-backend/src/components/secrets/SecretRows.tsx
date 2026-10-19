/**
 * Secrets as the owner writes them, one row each (a name, its value, the hosts it may be sent to), and the workspaces
 * they go to. Settings adds them through these, and so does the chat's offer to move a pasted one out of the message.
 */
import { useEffect, useState } from "react";
import { Combobox } from "@cloudflare/kumo";
import { TrashIcon } from "@phosphor-icons/react";
import { detach, diagnostics, toKinuError } from "@kinu.run/core/obs";
import { secretProvider } from "@kinu.run/core";
import { Cause, Effect } from "effect";
import { inputCls } from "@/components/ui/form";
import { listWorkspaces, type SecretEntry } from "@/lib/user-api";

/** A row being written: its hosts as typed, one or several, split on spaces and commas. */
export interface SecretDraft {
  readonly name: string;
  readonly value: string;
  readonly hosts: string;
}

/** A workspace the secrets will be allowed in, by its name and the title the roster shows. */
export interface ChosenWorkspace {
  readonly workspace: string;
  readonly title: string;
}

/** The same shape a variable takes in a shell; the server holds the rule, this only says it as the owner types. */
const VARIABLE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function hostList(typed: string): string[] {
  return typed.split(/[\s,]+/).filter((host) => host !== "");
}

/** What the server is sent; a row with no name and no value is a blank the owner left. */
export function secretEntries(rows: readonly SecretDraft[]): SecretEntry[] {
  return rows.filter((row) => row.name.trim() !== "" || row.value !== "")
    .map((row) => ({ name: row.name.trim(), value: row.value, hosts: hostList(row.hosts) }));
}

/** What is still missing from a row, in words, or null when it can be saved. */
function rowProblem(row: SecretDraft): string | null {
  if (row.name.trim() === "" && row.value === "") return null;

  if (!VARIABLE.test(row.name.trim())) return "Name it as a variable: letters, digits and _, not starting with a digit.";

  if (row.value === "") return "Paste its value.";

  return hostList(row.hosts).length === 0 ? "Name a host it may be sent to, such as api.example.com." : null;
}

export function rowsReady(rows: readonly SecretDraft[]): boolean {
  return secretEntries(rows).length > 0 && rows.every((row) => rowProblem(row) === null);
}

/** A value whose shape names its provider fills a blank name and blank hosts with that provider's own. */
export function withProvider(row: SecretDraft): SecretDraft {
  const provider = secretProvider(row.value.trim());

  if (provider === null) return row;

  return {
    ...row,
    name: row.name.trim() === "" ? provider.variable : row.name,
    hosts: row.hosts.trim() === "" ? provider.hosts.join(", ") : row.hosts,
  };
}

export function SecretRows({ rows, onChange, removable }: {
  rows: readonly SecretDraft[];
  onChange: (rows: SecretDraft[]) => void;
  removable: boolean;
}) {
  const edit = (index: number, next: SecretDraft) => onChange(rows.map((row, at) => (at === index ? next : row)));

  return (
    <div className="space-y-3" data-secret-rows>
      {rows.map((row, index) => {
        const problem = rowProblem(row);

        return (
          <div key={index} className="space-y-1.5" data-secret-row={index}>
            <div className="flex flex-wrap gap-2 [&>input]:h-9">
              <input value={row.name} onChange={(e) => edit(index, { ...row, name: e.target.value })} placeholder="NAME"
                aria-label="Secret name" spellCheck={false} autoCapitalize="characters" className={`${inputCls} basis-full font-mono sm:basis-auto sm:max-w-56`} />
              <input type="password" value={row.value} autoComplete="off"
                onChange={(e) => edit(index, withProvider({ ...row, value: e.target.value }))}
                placeholder="Value" aria-label={`Value of ${row.name || "this secret"}`} className={`${inputCls} min-w-0 flex-1 basis-full sm:basis-0`} />
              <input value={row.hosts} onChange={(e) => edit(index, { ...row, hosts: e.target.value })} placeholder="api.example.com"
                aria-label={`Hosts ${row.name || "this secret"} may be sent to`} spellCheck={false} className={`${inputCls} basis-full sm:basis-auto sm:max-w-64`} />
              {removable && (
                <button type="button" onClick={() => onChange(rows.filter((_, at) => at !== index))} aria-label={`Leave out ${row.name || "this row"}`}
                  className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md p-text-3 hover:p-danger">
                  <TrashIcon size={14} />
                </button>
              )}
            </div>
            {problem !== null && <p className="p-meta p-warning">{problem}</p>}
          </div>
        );
      })}
    </div>
  );
}

/** The owner's workspaces matching what is typed, read as the roster search reads them. */
function useWorkspaceSearch(query: string): ChosenWorkspace[] {
  const [found, setFound] = useState<ChosenWorkspace[]>([]);

  useEffect(() => {
    let current = true;

    detach(Effect.catchCause(Effect.map(Effect.promise(() => listWorkspaces({ q: query, limit: 20 })), (page) => {
      if (current) setFound(page.entries.map((entry) => ({ workspace: entry.name, title: entry.displayName })));
    }), (failed) => Effect.sync(() => {
      // Nothing to offer is what an unanswered search shows; the reason goes to the page's diagnostics.
      diagnostics.failure('secrets.workspace_search_failed', toKinuError({ doing: 'searching workspaces', cause: Cause.squash(failed), otherwise: 'unavailable' }));

      if (current) setFound([]);
    })));

    return () => { current = false; };
  }, [query]);

  return found;
}

/** One workspace to add, searched by name; those already chosen are not offered. */
export function WorkspaceAdder({ held, onAdd, placeholder }: {
  held: readonly string[];
  onAdd: (workspace: ChosenWorkspace) => void;
  placeholder: string;
}) {
  const [query, setQuery] = useState("");
  const items = useWorkspaceSearch(query).filter((entry) => !held.includes(entry.workspace));

  return (
    <Combobox items={items} value={null} onValueChange={(next: ChosenWorkspace | null) => { if (next !== null) onAdd(next); }}
      onInputValueChange={(typed: string) => setQuery(typed)}
      itemToStringLabel={(item: ChosenWorkspace) => item.title}
      itemToStringValue={(item: ChosenWorkspace) => item.workspace}>
      <Combobox.TriggerInput placeholder={placeholder} />
      <WorkspaceOptions />
    </Combobox>
  );
}

function WorkspaceOptions() {
  return (
    <Combobox.Content>
      <Combobox.Empty>No workspace by that name.</Combobox.Empty>
      <Combobox.List>
        {(item: ChosenWorkspace) => (
          <Combobox.Item key={item.workspace} value={item}>
            <span className="flex w-full items-baseline gap-2">
              <span className="truncate">{item.title}</span>
              <span className="ml-auto shrink-0 font-mono p-meta p-text-3">{item.workspace}</span>
            </span>
          </Combobox.Item>
        )}
      </Combobox.List>
    </Combobox.Content>
  );
}

/** The workspaces chosen, as chips, and a search to add another. */
export function WorkspaceChooser({ chosen, onChange, placeholder }: {
  chosen: readonly ChosenWorkspace[];
  onChange: (chosen: ChosenWorkspace[]) => void;
  placeholder: string;
}) {
  const [query, setQuery] = useState("");
  const found = useWorkspaceSearch(query);
  // Chosen ones stay among the items, so their chips keep a label while the search shows others.
  const items = [...chosen, ...found.filter((entry) => !chosen.some((held) => held.workspace === entry.workspace))];

  return (
    <Combobox multiple items={items} value={[...chosen]}
      onValueChange={(next: ChosenWorkspace[]) => onChange(next)}
      onInputValueChange={(typed: string) => setQuery(typed)}
      itemToStringLabel={(item: ChosenWorkspace) => item.title}
      itemToStringValue={(item: ChosenWorkspace) => item.workspace}
      isItemEqualToValue={(item: ChosenWorkspace, value: ChosenWorkspace) => item.workspace === value.workspace}>
      <Combobox.TriggerMultipleWithInput<ChosenWorkspace> placeholder={placeholder} value={[...chosen]}
        renderItem={(item) => <Combobox.Chip removeLabel={`Not in ${item.title}`}>{item.title}</Combobox.Chip>} />
      <WorkspaceOptions />
    </Combobox>
  );
}
