import { SlateId } from '@agent-core/core/slates';
import type { VfsCred } from '@nimbus-sh/core/runtime/os-contracts.js';
import { slateDirectory, type WorkspaceSlates } from '@kinu.run/core/slates';
import {
  addressedBlock, ephemeralSlateAddress, ephemeralSlateId, pageTitle, parseSlateProject, sha256Hex, type EphemeralSlateAddress, type SlateProject,
} from '@kinu.run/core';
import type { WorkspaceSession } from '@kinu.run/core/workspace';
import { ROOT_SLATE_CALLER, type SlateCaller } from './bindings';

/** The block an ephemeral slate's id names, and the author whose authority its page runs with; null when no authority
 *  can be lent to it here, and the page is drawn with nothing it can call. */
export interface MessageBlock {
  readonly html: string;
  readonly author: SlateCaller | null;
}

/** What an unbound page runs as: nothing it can call reaches anything, so the least mode. */
const UNBOUND: SlateCaller = { ...ROOT_SLATE_CALLER, workMode: 'plan' };

/**
 * Where a slate comes from: its directory, or a `<slate-ui>` block of a stored answer, which has no class and is its own
 * page. After the source, both run the same way.
 */
export type SlateSource =
  | { readonly kind: 'files'; readonly project: SlateProject; readonly root: string }
  | {
    readonly kind: 'message'; readonly project: SlateProject; readonly root: string; readonly html: string; readonly author: SlateCaller;
    /** False for a page drawn with no authority lent to it: every call on its surface is refused. */
    readonly bound: boolean;
  };

/** Not a directory any slate's files are in: an ephemeral slate has no files. */
const EPHEMERAL_ROOT = '/usr/lib/kinu/slate/pages';

const PAGE_ENTRY = 'index.html';

/** A host that keeps no answers holds no blocks: every address is refused. */
async function noAnswers(address: EphemeralSlateAddress): Promise<MessageBlock> {
  return { html: addressedBlock([], address).html, author: ROOT_SLATE_CALLER };
}

interface SlateSourceDeps {
  /** A directory slate's package.json, read as the caller. */
  project(cred: VfsCred, id: string): Promise<SlateProject>;
  /** The caller's view of the slate trees, which digests a directory. */
  trees(cred: VfsCred): Promise<WorkspaceSlates>;
  readonly host: {
    session(): Promise<Pick<WorkspaceSession, 'vfs'>>;
    /** Refused when no stored answer holds the block; absent, no address resolves. */
    messageBlock?(address: EphemeralSlateAddress): Promise<MessageBlock>;
  };
}

/** Resolves a slate's id to its source, and reads and digests what the source holds. */
export class SlateSources {
  constructor(private readonly deps: SlateSourceDeps) {}

  async resolve(cred: VfsCred, id: string): Promise<SlateSource> {
    const address = ephemeralSlateAddress(id);

    if (address === null) return { kind: 'files', project: await this.deps.project(cred, id), root: slateDirectory(new SlateId(id)) };
    const block = this.deps.host.messageBlock === undefined ? await noAnswers(address) : await this.deps.host.messageBlock(address);

    return {
      kind: 'message', root: `${EPHEMERAL_ROOT}/${ephemeralSlateId(address)}`, html: block.html, author: block.author ?? UNBOUND,
      bound: block.author !== null, project: parseSlateProject({ browser: PAGE_ENTRY, slate: { title: pageTitle(block.html) ?? address.name } }),
    };
  }

  /** What tells one build of a slate from another: its tree's digest, or its block's. */
  async digest(cred: VfsCred, id: string, source: SlateSource): Promise<string> {
    if (source.kind === 'message') return sha256Hex(source.html);

    return (await (await this.deps.trees(cred)).synchronize(new SlateId(id))).source.digest.value;
  }

  /** An authored entry's text, read as the caller; null for one the source does not hold. */
  async reader(cred: VfsCred, source: SlateSource): Promise<(entry: string) => string | null> {
    if (source.kind === 'message') return (entry) => (entry === PAGE_ENTRY ? source.html : null);
    const files = (await this.deps.host.session()).vfs.as(cred);

    return (entry) => {
      const path = `${source.root}/${entry}`;

      return files.exists(path) ? files.readFileString(path) : null;
    };
  }
}
