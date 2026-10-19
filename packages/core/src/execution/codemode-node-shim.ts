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

/** A Node-shaped error from a host refusal: the errno code the refusal names (else the fallback), and the path. */
function fsError(fallback, refusal, path, syscall) {
  const named = /^(E[A-Z]+): /.exec(refusal);
  const code = named ? named[1] : fallback;
  const text = named ? refusal.slice(named[0].length) : refusal;
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

/**
 * Why a file's bytes cannot pass this fs, which reads and writes the workspace's files as text: a PNG read here came
 * back re-encoded and failed to inflate (rc22 release evals). Thrown, so a program never holds bytes that are not the
 * file's.
 */
function notText(path, syscall) {
  const error = new Error('EILSEQ: ' + path + ' is not UTF-8 text, and fs here moves text, so its bytes would not survive. '
    + 'Move a binary file\'s bytes as base64 through the shell: "base64 -w 0 ' + path + '" reads them, "base64 -d" writes them.');
  error.code = 'EILSEQ';
  error.errno = -84;
  error.syscall = syscall;
  error.path = path;
  return error;
}

function makeFs(workspace, cwd) {
  const encodingOf = (options) => typeof options === 'string' ? options : options && options.encoding;

  /** Bytes as the UTF-8 text they are, or null where they are not text. */
  const asText = (data) => {
    if (typeof data === 'string') return data;
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(data);
    } catch {
      return null;
    }
  };

  async function readFile(path, options) {
    const target = resolveAt(cwd, path);
    const text = await workspace.fs.text(target);
    const refused = refusalOf(text);
    if (refused) throw fsError('ENOENT', refused, target, 'open');
    const encoding = encodingOf(options);
    if (encoding !== undefined && encoding !== null) return text;
    // The file's bytes, which only text keeps: the text arrived decoded, and a byte that was not UTF-8 is gone from it.
    if (text.includes('\uFFFD')) throw notText(target, 'open');
    return new TextEncoder().encode(text);
  }
  function toText(data, target, syscall) {
    const text = asText(data);
    if (text === null) throw notText(target, syscall);
    return text;
  }
  async function writeFile(path, data) {
    const target = resolveAt(cwd, path);
    const result = await workspace.fs.write(target, toText(data, target, 'open'));
    const refused = refusalOf(result);
    if (refused) throw fsError('EACCES', refused, target, 'open');
  }
  async function appendFile(path, data) {
    let current = '';
    try {
      current = await readFile(path, 'utf8');
    } catch (cause) {
      if (!cause || cause.code !== 'ENOENT') throw cause;
    }
    await writeFile(path, current + toText(data, resolveAt(cwd, path), 'open'));
  }
  async function readdir(path, options) {
    const target = resolveAt(cwd, path);
    const names = [];
    // A listing comes a page at a time; Node's is the whole directory.
    for (let offset = 0; ;) {
      const page = await workspace.fs.list(target, { offset });
      const refused = refusalOf(page);
      if (refused) throw fsError('ENOENT', refused, target, 'scandir');
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
    const refused = refusalOf(found);
    if (refused) throw fsError('ENOENT', refused, target, 'stat');
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
    if (outcome.exitCode !== 0) throw fsError('EIO', outcome.stderr.trim() || outcome.stdout.trim() || ('exit ' + outcome.exitCode), path, syscall);
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
  const promises = {
    readFile, writeFile, appendFile, readdir, stat, lstat: stat, mkdir, rm, unlink, rmdir,
    copyFile, rename, access,
    exists: async (path) => refusalOf(await workspace.fs.stat(resolveAt(cwd, path))) === null,
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
