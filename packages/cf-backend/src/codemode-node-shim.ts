/**
 * The Node-style conveniences a program run by `execute_tools` gets, as the
 * source of a module the dynamic Worker loads beside the model's program.
 *
 * Plain JavaScript in a string, because it runs INSIDE the sandbox isolate and
 * nothing here is compiled by this package. The sandbox has `nodejs_compat`,
 * so the real Node builtins (`node:path`, `node:crypto`, `node:util`, …) are
 * importable there; what Node has and a Worker has not is a filesystem and a
 * process table, and those two are shimmed over the `workspace` namespace:
 *
 *   require('fs/promises').readFile('notes.md')   →  workspace.readFile
 *   require('fs/promises').writeFile(p, text)     →  workspace.writeFile
 *   require('child_process').exec('ls -la')       →  workspace.exec
 *
 * `createFetch` is the program's `fetch`: the platform's own, except that the
 * loopback egress entrypoint answers a network failure with a marked 502 (an
 * exception thrown inside it would reach here as an opaque `internal error`),
 * and this turns that back into the rejection a Node program expects.
 *
 * `defineCrafted` is how a crafted tool becomes `tools.<name>`: the stored
 * source is evaluated per tool inside its own try, so a tool whose source
 * throws when evaluated, or evaluates to something that is not a function,
 * poisons only its own name and reports why on its first call. The failure
 * marker is core's `craftFailureMarker` shape (`[crafted:<name>]`), which the
 * in-episode fitness reads to blame the right artifact.
 */

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
  if (result && typeof result === 'object' && typeof result.error === 'string' && typeof result.reason === 'string') {
    return result.error;
  }
  if (typeof result === 'string' && result.startsWith('{')) {
    try {
      const parsed = JSON.parse(result);
      if (parsed && typeof parsed.error === 'string' && typeof parsed.reason === 'string') return parsed.error;
    } catch {
      return null;
    }
  }
  return null;
}

function fsError(code, message, path, syscall) {
  const error = new Error(code + ': ' + message + (path === undefined ? '' : ", '" + path + "'"));
  error.code = code;
  error.errno = -1;
  error.syscall = syscall;
  error.path = path;
  return error;
}

function shellQuote(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
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

function makeFs(workspace) {
  const toText = (data) => typeof data === 'string' ? data : new TextDecoder().decode(data);
  const encodingOf = (options) => typeof options === 'string' ? options : options && options.encoding;

  async function readFile(path, options) {
    const raw = await workspace.readFile(String(path));
    const refused = refusalOf(raw);
    if (refused) throw fsError('ENOENT', refused, String(path), 'open');
    const text = typeof raw === 'string' ? raw : JSON.stringify(raw);
    const encoding = encodingOf(options);
    if (encoding === undefined || encoding === null) return new TextEncoder().encode(text);
    return text;
  }
  async function writeFile(path, data) {
    const result = await workspace.writeFile(String(path), toText(data));
    const refused = refusalOf(result);
    if (refused) throw fsError('EACCES', refused, String(path), 'open');
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
    const entries = await workspace.readdir(String(path));
    const refused = refusalOf(entries);
    if (refused) throw fsError('ENOENT', refused, String(path), 'scandir');
    const names = Array.isArray(entries) ? entries.map(String) : [];
    if (!(options && options.withFileTypes)) return names;
    const base = String(path).replace(/\/+$/, '');
    return await Promise.all(names.map(async (name) => {
      const info = await stat(base + '/' + name);
      return { name, isFile: () => info.isFile(), isDirectory: () => info.isDirectory() };
    }));
  }
  async function stat(path) {
    const target = String(path);
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
  const mkdir = (path, options) => run('mkdir ' + (options && options.recursive ? '-p ' : '') + '-- ' + shellQuote(path), String(path), 'mkdir');
  const rm = (path, options) => run('rm ' + (options && options.recursive ? '-r ' : '') + (options && options.force ? '-f ' : '') + '-- ' + shellQuote(path), String(path), 'rm');
  const unlink = (path) => run('rm -- ' + shellQuote(path), String(path), 'unlink');
  const rmdir = (path) => run('rmdir -- ' + shellQuote(path), String(path), 'rmdir');
  const copyFile = (from, to) => run('cp -- ' + shellQuote(from) + ' ' + shellQuote(to), String(from), 'copyfile');
  const rename = (from, to) => run('mv -- ' + shellQuote(from) + ' ' + shellQuote(to), String(from), 'rename');
  async function access(path) {
    const present = await workspace.exists(String(path));
    if (present !== true) throw fsError('ENOENT', 'no such file or directory', String(path), 'access');
  }
  const promises = {
    readFile, writeFile, appendFile, readdir, stat, lstat: stat, mkdir, rm, unlink, rmdir,
    copyFile, rename, access,
    exists: async (path) => (await workspace.exists(String(path))) === true,
  };
  const unavailable = (name) => () => {
    throw new Error('fs.' + name + ' is not available in this sandbox: use await require("fs/promises").' + name.replace(/Sync$/, '') + '(...)');
  };
  const callbackForm = (fn) => (...args) => {
    const callback = typeof args[args.length - 1] === 'function' ? args.pop() : null;
    const promise = fn(...args);
    if (!callback) return promise;
    promise.then((value) => callback(null, value), (error) => callback(error));
    return undefined;
  };
  const fs = { promises };
  for (const [name, fn] of Object.entries(promises)) fs[name] = callbackForm(fn);
  for (const name of ['readFileSync', 'writeFileSync', 'readdirSync', 'statSync', 'existsSync', 'mkdirSync', 'rmSync', 'unlinkSync']) {
    fs[name] = unavailable(name);
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
  const unavailable = (name) => () => {
    throw new Error('child_process.' + name + ' is not available in this sandbox: use await require("child_process").exec(command) or workspace.exec(command)');
  };
  return { exec, execFile, spawn: unavailable('spawn'), execSync: unavailable('execSync'), spawnSync: unavailable('spawnSync'), fork: unavailable('fork') };
}

export function createRequire({ workspace, builtins }) {
  const { fs, promises } = makeFs(workspace);
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

export function defineCrafted(name, factory) {
  let impl;
  try {
    impl = factory();
  } catch (cause) {
    return async () => {
      throw new Error('[crafted:' + name + '] failed to load: ' + (cause && cause.message ? cause.message : String(cause)), { cause });
    };
  }
  if (typeof impl !== 'function') {
    return async () => {
      throw new Error('[crafted:' + name + '] is not a function: its stored source evaluates to ' + typeof impl);
    };
  }
  return async (...args) => {
    try {
      return await impl(...args);
    } catch (cause) {
      throw new Error('[crafted:' + name + '] ' + (cause && cause.message ? cause.message : String(cause)), { cause });
    }
  };
}
`;
