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

function refusalOf(result) {
  const refused = (value) => value && typeof value === 'object' && typeof value.error === 'string'
    && (value.success === false || typeof value.reason === 'string');
  if (refused(result)) return result.error;
  if (typeof result === 'string' && result.startsWith('{')) {
    try {
      const parsed = JSON.parse(result);
      if (refused(parsed)) return parsed.error;
    } catch {
      return null;
    }
  }
  return null;
}

/** A relative path joined onto the working root, as the host would resolve it; an absolute or empty one as given. */
function resolveAt(cwd, path) {
  const text = String(path);
  if (text === '' || text.startsWith('/')) return text;
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
  const error = new Error(code + ': ' + text + (path === undefined || text.includes("'" + path + "'") ? '' : ", '" + path + "'"));
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
  return json !== undefined && json.length <= 80 ? json : '…';
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

const EXIT_PREFIX = /^Error \(exit (\d+)\)\n?/;
const STDERR_LABEL = '\n--- stderr ---\n';

function parseExec(rendered) {
  const text = typeof rendered === 'string' ? rendered : JSON.stringify(rendered);
  const refused = refusalOf(text);
  if (refused) return { exitCode: 126, stdout: '', stderr: refused };
  const exit = EXIT_PREFIX.exec(text);
  let body = exit ? text.slice(exit[0].length) : text;
  let stdout = body;
  let stderr = '';
  const split = body.indexOf(STDERR_LABEL);
  if (split >= 0) {
    stdout = body.slice(0, split);
    stderr = body.slice(split + STDERR_LABEL.length);
  } else if (exit && body.startsWith('--- stderr ---\n')) {
    stdout = '';
    stderr = body.slice('--- stderr ---\n'.length);
  }
  if (stdout.startsWith('--- stdout ---\n')) stdout = stdout.slice('--- stdout ---\n'.length);
  if (stdout === '(no output)') stdout = '';
  return { exitCode: exit ? Number(exit[1]) : 0, stdout, stderr };
}

function makeFs(workspace, cwd) {
  const toText = (data) => typeof data === 'string' ? data : new TextDecoder().decode(data);
  const encodingOf = (options) => typeof options === 'string' ? options : options && options.encoding;

  async function readFile(path, options) {
    const target = resolveAt(cwd, path);
    const raw = await workspace.readFile(target);
    const refused = refusalOf(raw);
    if (refused) throw fsError('ENOENT', refused, target, 'open');
    const text = typeof raw === 'string' ? raw : JSON.stringify(raw);
    const encoding = encodingOf(options);
    if (encoding === undefined || encoding === null) return new TextEncoder().encode(text);
    return text;
  }
  async function writeFile(path, data) {
    const target = resolveAt(cwd, path);
    const result = await workspace.writeFile(target, toText(data));
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
    await writeFile(path, current + toText(data));
  }
  async function readdir(path, options) {
    const target = resolveAt(cwd, path);
    const entries = await workspace.readdir(target);
    const refused = refusalOf(entries);
    if (refused) throw fsError('ENOENT', refused, target, 'scandir');
    const names = Array.isArray(entries) ? entries.map(String) : [];
    if (!(options && options.withFileTypes)) return names;
    const base = target.replace(/\/+$/, '');
    return await Promise.all(names.map(async (name) => {
      const info = await stat(base + '/' + name);
      return { name, isFile: () => info.isFile(), isDirectory: () => info.isDirectory() };
    }));
  }
  async function stat(path) {
    const target = resolveAt(cwd, path);
    let directory = false;
    let size = 0;
    try {
      const entries = await workspace.readdir(target);
      directory = Array.isArray(entries);
    } catch {
      directory = false;
    }
    if (!directory) {
      const text = await readFile(target, 'utf8');
      size = new TextEncoder().encode(text).byteLength;
    }
    return {
      size,
      mtimeMs: 0,
      mtime: new Date(0),
      isFile: () => !directory,
      isDirectory: () => directory,
      isSymbolicLink: () => false,
    };
  }
  async function run(command, path, syscall) {
    const outcome = parseExec(await workspace.exec(command));
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
    const target = resolveAt(cwd, path);
    const present = await workspace.exists(target);
    if (present !== true) throw fsError('ENOENT', 'no such file or directory', target, 'access');
  }
  const promises = {
    readFile, writeFile, appendFile, readdir, stat, lstat: stat, mkdir, rm, unlink, rmdir,
    copyFile, rename, access,
    exists: async (path) => (await workspace.exists(resolveAt(cwd, path))) === true,
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
    const promise = (async () => {
      const outcome = parseExec(await workspace.exec(String(command)));
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
    return exec([file, ...argv].map(shellQuote).join(' '), callback);
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
