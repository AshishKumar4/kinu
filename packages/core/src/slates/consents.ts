import * as v from 'valibot';
import type { SqlExec, SqlExecRow } from '../types/primitives';
import { parseJsonValue } from '../utils/json';
import { SlateConsentSchema, type SlateConsent } from './share-modes';
import { canonicalRoot } from './share-policy';
import type { ConsentAsk, EffectAsk } from './personal-parts';
import type { SlateSurfaceValue } from './rpc';

/** One account's answer to a personal part's call, never a shared server's answer. */
export type PartConnectionAnswer<Value = SlateSurfaceValue> =
  | { readonly kind: 'ran'; readonly value: Value }
  | { readonly kind: 'needs-consent'; readonly ask: ConsentAsk }
  | { readonly kind: 'needs-approval'; readonly ask: EffectAsk }
  | { readonly kind: 'missing'; readonly message: string };

/** The account's AI stays with its own model service: it needs consent, never a per-call approval. */
export type PartAiAnswer = Extract<PartConnectionAnswer, { readonly kind: 'ran' | 'needs-consent' }>;

const ConsentRow = v.object({
  workspace: v.string(), slate: v.string(), server: v.string(), root: v.string(), tools: v.string(),
  effects: v.picklist([0, 1]), revision: v.string(),
});

function consentOf(raw: SqlExecRow): SlateConsent {
  const row = v.parse(ConsentRow, raw);

  return v.parse(SlateConsentSchema, { ...row, root: parseJsonValue(row.root), tools: parseJsonValue(row.tools), effects: row.effects === 1 });
}

/** The viewer's consent rows, keyed by slate, connection and canonical root in their own account. */
export class SlateConsentStore {
  constructor(private readonly sql: SqlExec) {}

  forSlate(workspace: string, slate: string): SlateConsent[] {
    return this.sql.exec('SELECT * FROM slate_consents WHERE workspace = ? AND slate = ? ORDER BY server, root', workspace, slate).toArray().map(consentOf);
  }

  find(workspace: string, slate: string, server: string, root: Readonly<Record<string, string>>): SlateConsent | null {
    const [row] = this.sql.exec('SELECT * FROM slate_consents WHERE workspace = ? AND slate = ? AND server = ? AND root = ?', workspace, slate, server, canonicalRoot(root)).toArray();

    return row === undefined ? null : consentOf(row);
  }

  /** A new decision replaces every grant field, including its revision; nothing is unioned with an old consent. */
  put(consent: SlateConsent): void {
    this.sql.exec(
      `INSERT INTO slate_consents (workspace, slate, server, root, tools, effects, revision) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (workspace, slate, server, root) DO UPDATE SET tools = excluded.tools, effects = excluded.effects, revision = excluded.revision`,
      consent.workspace, consent.slate, consent.server, canonicalRoot(consent.root), JSON.stringify(consent.tools), consent.effects ? 1 : 0, consent.revision,
    );
  }

  withdraw(workspace: string, slate: string, server: string, root: Readonly<Record<string, string>>): boolean {
    return this.sql.exec('DELETE FROM slate_consents WHERE workspace = ? AND slate = ? AND server = ? AND root = ? RETURNING workspace', workspace, slate, server, canonicalRoot(root)).toArray().length > 0;
  }
}
