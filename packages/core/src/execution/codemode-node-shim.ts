/**
 * The Node-convenience module beside an `eval` program, plain JS for the sandbox isolate: `fs` and
 * `child_process` over `workspace`, `process.cwd()` at the working root, `workspace.slates` objects,
 * a `fetch` that rejects the egress entrypoint's marked 502, and isolated crafted tools.
 */

import { SLATE_PROGRAM_MEMBERS } from '../slates/rpc';

export const KINU_NODE_MODULE_NAME = 'kinu-node.js';

export const KINU_NODE_MODULE_SOURCE = String.raw`
const BUILTINS = [
  'node:path', 'node:url', 'node:util', 'node:crypto', 'node:buffer', 'node:events',
  'node:assert', 'node:stream', 'node:string_decoder', 'node:querystring', 'node:zlib',
  'node:os', 'node:timers', 'node:async_hooks', 'node:stream/web', 'node:stream/promises',
  'node:util/types', 'node:timers/promises',
];

export async function loadBuiltins() {
  const loaded = {};
  const missing = [];
  await Promise.all(BUILTINS.map(async (name) => {
    try {
      loaded[name] = await import(name);
    } catch (cause) {
      missing.push(name + ': ' + (cause && cause.message ? cause.message : String(cause)));
    }
  }));
  return { loaded, missing };
}

/** The error a member refused with, or null for a value. Refusals are objects; text is never read as one. */
function refusalOf(result) {
  return result && typeof result === 'object' && typeof result.error === 'string'
    && (result.success === false || typeof result.reason === 'string') ? result.error : null;
}

/** A relative path joined onto the working root, as the host would resolve it; an absolute, empty or root:// one as given. */
function resolveAt(cwd, path) {
  const text = String(path);
  if (text === '' || text.startsWith('/') || /^[^\s/:]+:\/\//.test(text)) return text;
  const segments = [];
  for (const segment of (cwd + '/' + text).split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') segments.pop();
    else segments.push(segment);
  }
  return '/' + segments.join('/');
}

/** The platform's process object plus a working directory: the root relative paths resolve against. */
export function createProcess(cwd) {
  const own = { cwd: () => cwd };
  return globalThis.process ? Object.setPrototypeOf(own, globalThis.process) : own;
}

/** A refusal's error and its reason, or null for a value. */
function refusedOf(result) {
  const error = refusalOf(result);
  return error === null ? null : { error, reason: typeof result.reason === 'string' ? result.reason : null };
}

/** The errno a refusal's reason stands for when its text names none. Only a stated absence is ENOENT: a read that was
 *  refused or could not be made says nothing of whether the file is there, so an append never reads it as empty. */
const ERRNO_OF_REASON = { missing: 'ENOENT', denied: 'EACCES', bad_input: 'EINVAL', unsupported: 'ENOTSUP', timeout: 'ETIMEDOUT', cancelled: 'ECANCELED' };

/** A Node-shaped error from a host refusal: the errno its text names, else its reason's, else EIO; and the path. */
function fsError(refused, path, syscall) {
  const named = /^(E[A-Z]+): /.exec(refused.error);
  const code = named ? named[1] : (ERRNO_OF_REASON[refused.reason] || 'EIO');
  const text = named ? refused.error.slice(named[0].length) : refused.error;
  const error = new Error(code + ': ' + text + (path === undefined || text.includes("'" + path + "'") ? '' : ', ' + syscall + " '" + path + "'"));
  error.code = code;
  error.errno = -1;
  error.syscall = syscall;
  error.path = path;
  return error;
}

function shellQuote(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

/** An argument as a suggestion can repeat it: short JSON, else an ellipsis. */
function shownArg(value) {
  const json = typeof value === 'function' ? undefined : JSON.stringify(value);
  return json !== undefined && json.length <= 80 ? json : '...';
}

/**
 * A synchronous or streaming Node call. Nothing in the sandbox can block on the workspace (workerd,
 * 2026-09-23: "Atomics.wait cannot be called in this context"), so it names the awaited replacement.
 */
function asyncOnly(name, rewrite) {
  return (...args) => {
    throw new Error(name + ' cannot run here: this sandbox reaches your workspace only asynchronously. Write instead: ' + rewrite(args));
  };
}

/**
 * A command's result as Node reports it, asked for as the command wrote it (parts). A refusal ran nothing (126).
 */
async function execParts(workspace, command, options) {
  const result = await workspace.exec(command, { ...options, parts: true });
  const refused = refusalOf(result);
  if (refused !== null) return { exitCode: 126, stdout: '', stderr: refused };
  return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
}

/** Bytes as base64, chunked so a large file does not overflow String.fromCharCode's arguments. */
function toBase64(bytes) {
  let binary = '';
  for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(binary);
}

function fromBase64(text) {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let at = 0; at < binary.length; at++) bytes[at] = binary.charCodeAt(at);
  return bytes;
}

/** Data a program writes, as the bytes it holds: a string as UTF-8, a view of bytes as they are. */
function bytesOf(data) {
  if (typeof data === 'string') return new TextEncoder().encode(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new TextEncoder().encode(String(data));
}

function makeFs(workspace, cwd) {
  const encodingOf = (options) => typeof options === 'string' ? options : options && options.encoding;

  /** The file's bytes exactly, as the file plane reads them (file.text with base64), for a file that is not text too. */
  async function readBase64(path) {
    const target = resolveAt(cwd, path);
    const read = await workspace.fs.text(target, { encoding: 'base64' });
    const refused = refusedOf(read);
    if (refused) throw fsError(refused, target, 'open');
    return read;
  }
  async function readFile(path, options) {
    const encoding = encodingOf(options);
    if (encoding === undefined || encoding === null) return fromBase64(await readBase64(path));
    if (encoding === 'base64') return await readBase64(path);
    const target = resolveAt(cwd, path);
    const text = await workspace.fs.text(target);
    const refused = refusedOf(text);
    if (refused) throw fsError(refused, target, 'open');
    return text;
  }
  /** A string is written as its text; bytes, or a string named base64, as the bytes exactly. */
  async function writeFile(path, data, options) {
    const target = resolveAt(cwd, path);
    const encoding = encodingOf(options);
    const result = typeof data === 'string' && encoding !== 'base64'
      ? await workspace.fs.write(target, data)
      : await workspace.fs.write(target, typeof data === 'string' ? data : toBase64(bytesOf(data)), { encoding: 'base64' });
    const refused = refusedOf(result);
    if (refused) throw fsError(refused, target, 'open');
  }
  // Read, joined, written whole: a file that is not there starts empty, and any other failed read fails the append
  // before anything is written.
  async function appendFile(path, data) {
    let current = new Uint8Array(0);
    try {
      current = await readFile(path);
    } catch (cause) {
      if (!cause || cause.code !== 'ENOENT') throw cause;
    }
    const added = bytesOf(data);
    const joined = new Uint8Array(current.length + added.length);
    joined.set(current);
    joined.set(added, current.length);
    await writeFile(path, joined);
  }
  async function readdir(path, options) {
    const target = resolveAt(cwd, path);
    const names = [];
    // A listing comes a page at a time; Node's is the whole directory.
    for (let offset = 0; ;) {
      const page = await workspace.fs.list(target, { offset });
      const refused = refusedOf(page);
      if (refused) throw fsError(refused, target, 'scandir');
      names.push(...page.entries);
      if (!page.truncated || page.truncated.next >= page.truncated.total || page.entries.length === 0) break;
      offset = page.truncated.next;
    }
    if (!(options && options.withFileTypes)) return names;
    const base = target.replace(/\/+$/, '');
    return await Promise.all(names.map(async (name) => {
      const info = await stat(base + '/' + name);
      return { name, isFile: () => info.isFile(), isDirectory: () => info.isDirectory() };
    }));
  }
  async function stat(path) {
    const target = resolveAt(cwd, path);
    const found = await workspace.fs.stat(target);
    const refused = refusedOf(found);
    if (refused) throw fsError(refused, target, 'stat');
    return {
      size: found.size,
      mtimeMs: found.mtimeMs,
      mtime: new Date(found.mtimeMs),
      isFile: () => !found.isDir,
      isDirectory: () => found.isDir,
      isSymbolicLink: () => false,
    };
  }
  async function run(command, path, syscall) {
    const outcome = await execParts(workspace, command, {});
    if (outcome.exitCode !== 0) throw fsError({ error: outcome.stderr.trim() || outcome.stdout.trim() || ('exit ' + outcome.exitCode), reason: null }, path, syscall);
  }
  const onPath = (path, command, syscall) => {
    const target = resolveAt(cwd, path);
    return run(command + shellQuote(target), target, syscall);
  };
  const mkdir = (path, options) => onPath(path, 'mkdir ' + (options && options.recursive ? '-p ' : '') + '-- ', 'mkdir');
  const rm = (path, options) => onPath(path, 'rm ' + (options && options.recursive ? '-r ' : '') + (options && options.force ? '-f ' : '') + '-- ', 'rm');
  const unlink = (path) => onPath(path, 'rm -- ', 'unlink');
  const rmdir = (path) => onPath(path, 'rmdir -- ', 'rmdir');
  const carry = (from, to, command, syscall) => {
    const source = resolveAt(cwd, from);
    return run(command + shellQuote(source) + ' ' + shellQuote(resolveAt(cwd, to)), source, syscall);
  };
  const copyFile = (from, to) => carry(from, to, 'cp -- ', 'copyfile');
  const rename = (from, to) => carry(from, to, 'mv -- ', 'rename');
  async function access(path) {
    await stat(path);
  }
  /** False only for a file stated absent; a stat that failed otherwise fails, as it says nothing either way. */
  async function exists(path) {
    try {
      await stat(path);
      return true;
    } catch (cause) {
      if (cause && cause.code === 'ENOENT') return false;
      throw cause;
    }
  }
  const promises = {
    readFile, writeFile, appendFile, readdir, stat, lstat: stat, mkdir, rm, unlink, rmdir,
    copyFile, rename, access,
    exists,
  };
  const callbackForm = (fn) => (...args) => {
    const callback = typeof args[args.length - 1] === 'function' ? args.pop() : null;
    const promise = fn(...args);
    if (!callback) return promise;
    promise.then((value) => callback(null, value), (error) => callback(error));
    return undefined;
  };
  const fs = { promises };
  for (const [name, fn] of Object.entries(promises)) {
    fs[name] = callbackForm(fn);
    fs[name + 'Sync'] = asyncOnly('fs.' + name + 'Sync', (args) => 'await require("fs/promises").' + name + '(' + args.slice(0, 2).map(shownArg).join(', ') + ')');
  }
  return { fs, promises };
}

function makeChildProcess(workspace) {
  function exec(command, optionsOrCallback, maybeCallback) {
    const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback;
    const options = typeof optionsOrCallback === 'object' && optionsOrCallback !== null ? optionsOrCallback : {};
    const promise = (async () => {
      const outcome = await execParts(workspace, String(command), options.cwd === undefined ? {} : { cwd: String(options.cwd) });
      if (outcome.exitCode !== 0) {
        const error = new Error('Command failed: ' + command + '\n' + outcome.stderr);
        error.code = outcome.exitCode;
        error.stdout = outcome.stdout;
        error.stderr = outcome.stderr;
        throw error;
      }
      return { stdout: outcome.stdout, stderr: outcome.stderr };
    })();
    if (typeof callback !== 'function') return promise;
    promise.then((out) => callback(null, out.stdout, out.stderr), (error) => callback(error, error.stdout || '', error.stderr || ''));
    return undefined;
  }
  function execFile(file, args, optionsOrCallback, maybeCallback) {
    const argv = Array.isArray(args) ? args : [];
    const callback = typeof args === 'function' ? args : (typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback);
    const options = typeof optionsOrCallback === 'object' && optionsOrCallback !== null ? optionsOrCallback : {};
    return exec([file, ...argv].map(shellQuote).join(' '), options, callback);
  }
  const viaExec = (args) => 'const { stdout } = await require("child_process").exec(' + JSON.stringify(String(args[0])) + ')';
  const viaExecFile = (args) => 'const { stdout } = await require("child_process").execFile(' + JSON.stringify(String(args[0])) + ', ' + JSON.stringify(Array.isArray(args[1]) ? args[1].map(String) : []) + ')';
  return {
    exec, execFile,
    execSync: asyncOnly('child_process.execSync', viaExec),
    execFileSync: asyncOnly('child_process.execFileSync', viaExecFile),
    spawn: asyncOnly('child_process.spawn', viaExecFile),
    spawnSync: asyncOnly('child_process.spawnSync', viaExecFile),
    fork: asyncOnly('child_process.fork', (args) => viaExec(['node ' + String(args[0])])),
  };
}

export function createRequire({ workspace, builtins, cwd }) {
  const { fs, promises } = makeFs(workspace, cwd);
  const childProcess = makeChildProcess(workspace);
  const table = {
    fs, 'fs/promises': promises, child_process: childProcess,
  };
  for (const [name, module] of Object.entries(builtins)) {
    table[name.slice('node:'.length)] = module;
  }
  const require = (specifier) => {
    const name = String(specifier).replace(/^node:/, '');
    if (Object.prototype.hasOwnProperty.call(table, name)) return table[name];
    throw new Error("Cannot find module '" + specifier + "': this sandbox has the Node builtins plus fs, fs/promises and child_process over the workspace. There is no package install here; use fetch() for HTTP and the tool namespaces for everything else.");
  };
  require.resolve = (specifier) => String(specifier);
  require.available = Object.keys(table).sort();
  return require;
}

export function createFetch(failureHeader) {
  const platformFetch = globalThis.fetch;
  return async (input, init) => {
    const response = await platformFetch(input, init);
    if (response.headers.get(failureHeader) === '1') {
      throw new TypeError('fetch failed: ' + (await response.text()));
    }
    return response;
  };
}

/**
 * workspace.slates: workspace.slates.<id> is that slate's server class, the stub its own client gets,
 * and $-named members, which no class method can take, are the lifecycle. The host's one slate
 * operation is captured here and shadowed, so a program reaches slates through these members only.
 */
export function bindSlates(workspace) {
  const operate = workspace === null ? undefined : workspace.slates;
  if (typeof operate !== 'function') return;
  const members = ${JSON.stringify(SLATE_PROGRAM_MEMBERS)};
  // Never a class method here: 'then' would make a slate look like a promise to await, and the rest
  // are what a conversion to text or JSON reaches for.
  const inert = (name) => typeof name !== 'string' || ['then', 'toJSON', 'toString', 'valueOf'].includes(name);
  const lifecycle = (on, id, name) => {
    const op = name.slice(1);
    if (!Object.hasOwn(members, op) || members[op].on !== on) return undefined;
    return (...args) => {
      const operation = members[op].params[0] === '...' ? { ...args[0], op } : { op };
      members[op].params.forEach((param, i) => { if (param !== '...' && args[i] !== undefined) operation[param] = args[i]; });
      if (id !== null) operation.id = id;
      return operate(operation);
    };
  };
  const slate = (id) => new Proxy({}, {
    get: (_, name) => {
      if (inert(name)) return undefined;
      if (name.startsWith('$')) return lifecycle('slate', id, name);
      return (...args) => operate({ op: 'call', id, method: name, args });
    },
  });
  workspace.slates = new Proxy({}, {
    get: (_, name) => {
      if (inert(name)) return undefined;
      return name.startsWith('$') ? lifecycle('directory', null, name) : slate(name);
    },
  });
}

export function defineCrafted(name, factory, reportFailure) {
  // The factory is async so a stored body may await at its top level, which
  // means it answers a promise: the source is evaluated once, on the first
  // call, and the settled value is what every later call runs. A body that
  // throws while evaluating, or evaluates to something that is not a
  // function, poisons only its own name and says so on each call.
  let loaded;
  const load = async () => {
    let impl;
    try {
      impl = await factory();
    } catch (cause) {
      throw new Error('[crafted:' + name + '] failed to load: ' + (cause && cause.message ? cause.message : String(cause)), { cause });
    }
    if (typeof impl !== 'function') {
      throw new Error('[crafted:' + name + '] is not a function: its stored source evaluates to ' + typeof impl);
    }
    return impl;
  };
  return async (...args) => {
    try {
      loaded ??= load();
      const impl = await loaded;
      return await impl(...args);
    } catch (cause) {
      const marker = '[crafted:' + name + ']';
      const error = cause instanceof Error && cause.message.startsWith(marker)
        ? cause : new Error(marker + ' ' + (cause && cause.message ? cause.message : String(cause)), { cause });
      if (reportFailure === undefined) throw error;
      let code = null;
      let link = cause;
      const seen = new Set();
      while (link && !seen.has(link)) {
        seen.add(link);
        if (typeof link.code === 'string') code ??= link.code;
        link = link.cause;
      }
      return reportFailure({ message: error.message, name: cause && typeof cause.name === 'string' ? cause.name : 'Error', code });
    }
  };
}
`;
