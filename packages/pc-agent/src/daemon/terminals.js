// Kinu PC agent — a workspace's named terminal sessions on this machine (1014-t).
//
// A session is a name and the folder it opens in, per workspace, kept in one
// file beside device.json so a daemon restart brings each back: a fresh shell,
// under its name, in its folder, as the computer's sessions come back after a
// restart (D90). The shell itself is pty.js's and lives only as long as this
// daemon does. Keying by workspace keeps one workspace from naming, listing or
// attaching to another's sessions on the same machine. The file is read for
// every call and written whole after each change, so a daemon and the successor
// an update starts beside it never act on a copy the other has moved past.
'use strict';

const crypto = require('node:crypto');

const fs = require('node:fs');

const path = require('node:path');

/** A session's name, as the strip shows it: the computer's rule (packages/devbox/src/sessions.ts). */
const NAME_MAX = 40;

/** The sessions one workspace may keep on one machine. */
const MAX_SESSIONS_PER_WORKSPACE = 16;

/** The session a workspace has before it opens another, and again when every other is closed. */
const FIRST_NAME = 'shell';

const WORKSPACE_MAX = 128;

function parseWorkspace(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > WORKSPACE_MAX) {
    throw new Error('a terminal session belongs to a workspace, and this frame names none');
  }

  return value;
}

function parseName(value) {
  const name = typeof value === 'string' ? value.trim() : '';

  if (name.length === 0 || name.length > NAME_MAX) throw new Error(`a session's name is 1 to ${NAME_MAX} characters`);

  return name;
}

/** Records as the file holds them, by workspace, in a map no workspace's name can reach past (`constructor` is a
 *  name too); one this daemon cannot read is dropped, and said. */
function readRecords(file, log) {
  const records = new Map();
  let text;

  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return records;
    throw err;
  }

  try {
    for (const [workspace, list] of Object.entries(JSON.parse(text))) {
      if (!Array.isArray(list)) continue;
      records.set(workspace, list.filter((record) => record && typeof record.id === 'string' && typeof record.name === 'string')
        .map((record) => ({ id: record.id, name: record.name, cwd: typeof record.cwd === 'string' ? record.cwd : null })));
    }
  } catch (err) {
    log('device.terminal_records_unreadable', file, err instanceof Error ? err.message : String(err));
  }

  return records;
}

/**
 * The machine's terminal sessions, by workspace, in `file`. `mint` names a new
 * session; its name is a pty.js session name and never a path.
 */
function createTerminalRecords({ file, log = () => {}, mint = () => `pty-${crypto.randomBytes(12).toString('base64url')}` }) {
  /** A complete file, renamed over the last, so a crash leaves one or the other. */
  function save(records) {
    const temporary = `${file}.${process.pid}.tmp`;

    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(temporary, `${JSON.stringify(Object.fromEntries(records), null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, file);
  }

  /** `change` over the file's records for `workspace`, its first session made when it has none; saved when asked. */
  function over(workspace, change) {
    const records = readRecords(file, log);
    const named = parseWorkspace(workspace);
    let held = records.get(named) ?? [];
    let dirty = false;

    if (held.length === 0) {
      held = [{ id: mint(), name: FIRST_NAME, cwd: null }];
      records.set(named, held);
      dirty = true;
    }

    const answer = change(held, () => { dirty = true; });

    if (dirty) save(records);

    return answer;
  }

  /** A workspace's sessions, its first made when it has none. */
  function list(workspace) {
    return over(workspace, (held) => held.map((record) => ({ ...record })));
  }

  function find(workspace, id) {
    return over(workspace, (held) => held.find((record) => record.id === id) ?? null);
  }

  function create(workspace, name) {
    return over(workspace, (held, changed) => {
      if (held.length >= MAX_SESSIONS_PER_WORKSPACE) {
        throw new Error(`this workspace keeps ${MAX_SESSIONS_PER_WORKSPACE} sessions on this machine already; close one first`);
      }

      const taken = new Set(held.map((record) => record.name));
      let next = 2;

      while (taken.has(`${FIRST_NAME} ${next}`)) next += 1;
      const record = { id: mint(), name: name === undefined || name === null ? `${FIRST_NAME} ${next}` : parseName(name), cwd: null };

      held.push(record);
      changed();

      return record;
    });
  }

  function rename(workspace, id, name) {
    return over(workspace, (held, changed) => {
      const record = held.find((candidate) => candidate.id === id);

      if (record === undefined) throw new Error('that session is gone; open a new one');
      record.name = parseName(name);
      changed();

      return record;
    });
  }

  /** The folder a session's shell opened in, kept for the shell a restart opens there again. */
  function settle(workspace, id, cwd) {
    over(workspace, (held, changed) => {
      const record = held.find((candidate) => candidate.id === id);

      if (record === undefined || record.cwd === cwd) return;
      record.cwd = cwd;
      changed();
    });
  }

  /** Forgets a session; the shell, if one runs, is the caller's to end. */
  function remove(workspace, id) {
    return over(workspace, (held, changed) => {
      const at = held.findIndex((record) => record.id === id);

      if (at < 0) return false;
      held.splice(at, 1);
      changed();

      return true;
    });
  }

  return { list, find, create, rename, settle, remove };
}

module.exports = { createTerminalRecords };
