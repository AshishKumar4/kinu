import type { JsonValue } from "@kinu.run/core";
import { workspaceDisplayTitle } from "@kinu.run/core";
import { useWorkspaceRosterIfAny } from "@/hooks/use-workspace-roster";
import type { MemoryOrigin } from "@/lib/user-api";
import { ClampedText } from "@/components/ui/ClampedText";

function words(key: string): string {
  const text = key.replace(/([a-z0-9])([A-Z])/gu, '$1 $2').replace(/[_-]+/gu, ' ').trim();

  return text.length === 0 ? key : text.charAt(0).toUpperCase() + text.slice(1);
}

export function memoryLabel(key: string): string {
  return key.split('.').map(words).join(' / ');
}

function MemoryLabel({ factKey }: { factKey: string }) {
  return <span title={factKey}>{memoryLabel(factKey)}</span>;
}

export function MemoryValue({ value }: { value: JsonValue }) {
  if (value === null) return <span className="t-meta p-text-3">Not set</span>;

  if (typeof value === 'string') {
    return value === ''
      ? <span className="t-meta p-text-3">Empty text</span>
      : <ClampedText text={value} quiet={false} />;
  }

  if (typeof value === 'boolean') return <span>{value ? 'Yes' : 'No'}</span>;

  if (typeof value === 'number') return <span>{String(value)}</span>;

  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="t-meta p-text-3">No items</span>;

    return (
      <ul className="min-w-0 list-disc space-y-1 pl-4">
        {value.map((item, index) => <li key={index} className="min-w-0 wrap-anywhere"><MemoryValue value={item} /></li>)}
      </ul>
    );
  }

  const fields = Object.entries(value);

  if (fields.length === 0) return <span className="t-meta p-text-3">No fields</span>;

  return (
    <dl className="min-w-0 space-y-2">
      {fields.map(([key, item]) => (
        <div key={key} className="min-w-0">
          <dt className="t-meta p-text-3 wrap-anywhere" title={key}>{memoryLabel(key)}</dt>
          <dd className="min-w-0 wrap-anywhere"><MemoryValue value={item} /></dd>
        </div>
      ))}
    </dl>
  );
}

export function MemoryFact({ factKey, value }: { factKey: string; value: JsonValue }) {
  return (
    <div className="min-w-0 space-y-1">
      <div className="t-label wrap-anywhere"><MemoryLabel factKey={factKey} /></div>
      <div className="t-body p-text wrap-anywhere"><MemoryValue value={value} /></div>
    </div>
  );
}

export function MemoryProvenance({ origin }: { origin: MemoryOrigin }) {
  const roster = useWorkspaceRosterIfAny();

  if (origin === null) return <>Origin not recorded</>;
  const workspace = origin.workspace === undefined ? undefined : roster?.entries.find((entry) => entry.name === origin.workspace);
  const name = workspace === undefined ? origin.workspace : workspaceDisplayTitle(workspace);
  const where = name === undefined ? '' : ` in ${name}`;

  if (origin.by === 'owner') return <>{name === undefined ? 'You, in Settings' : `You promoted it from ${name}`}</>;

  if (origin.by === 'agent') return <>Said{where}, kept by {origin.agent ?? 'an agent'}</>;

  if (origin.by === 'import' && name === undefined) return <>Read from a document you imported</>;

  return <>{origin.by === 'background' ? `Noticed${where} in your own words` : `Copied${where}`}</>;
}
