import * as v from 'valibot';
import type { VfsExportPage, VfsExportRow } from '@nimbus-sh/core/vfs/sqlite-vfs.js';

/** Checked off every transfer's wire; Nimbus checks it again on import. */
const VfsExportRowSchema: v.GenericSchema<VfsExportRow> = v.object({
  path: v.string(),
  ino: v.number(),
  kind: v.picklist(['file', 'directory', 'symlink']),
  size: v.number(),
  mode: v.number(),
  uid: v.number(),
  gid: v.number(),
  defaultAcl: v.nullable(v.number()),
  atime: v.number(),
  mtime: v.number(),
  contentKey: v.nullable(v.string()),
  pieceOffset: v.number(),
  manifest: v.boolean(),
  pieces: v.array(v.tuple([v.string(), v.number()])),
});

export const VfsExportPageSchema: v.GenericSchema<VfsExportPage> = v.object({
  schema: v.number(),
  source: v.string(),
  root: v.string(),
  nextIno: v.number(),
  after: v.nullable(v.string()),
  rows: v.array(VfsExportRowSchema),
  next: v.nullable(v.string()),
});
