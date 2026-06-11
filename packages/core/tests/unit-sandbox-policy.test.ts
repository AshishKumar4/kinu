import { describe, expect, test } from 'bun:test';
import {
  clampSandboxMode,
  resolveSandboxPolicy,
  isPathWritable,
  normalizePosixPath,
  detectSandboxDenial,
  escalationForWrite,
  formatSandboxEscalation,
  parseSandboxEnforcementReport,
  buildSandboxedSpawn,
  buildSeatbeltProfile,
  type SandboxPolicy,
} from '../src/safety/index.js';

const ws = (over: Partial<{ network: boolean; extra: string[] }> = {}): SandboxPolicy =>
  resolveSandboxPolicy({
    mode: 'workspace-write',
    workspaceRoot: '/work/project',
    tmpDir: '/tmp',
    extraWritableRoots: over.extra,
    network: over.network,
  });

describe('clampSandboxMode (downward-only override)', () => {
  test('a request can lower the granted mode', () => {
    expect(clampSandboxMode('workspace-write', 'read-only')).toBe('read-only');
    expect(clampSandboxMode('full', 'workspace-write')).toBe('workspace-write');
  });

  test('a request can never raise the granted mode', () => {
    expect(clampSandboxMode('workspace-write', 'full')).toBe('workspace-write');
    expect(clampSandboxMode('read-only', 'full')).toBe('read-only');
    expect(clampSandboxMode('read-only', 'workspace-write')).toBe('read-only');
  });

  test('invalid or absent requests keep the granted mode', () => {
    expect(clampSandboxMode('workspace-write')).toBe('workspace-write');
    expect(clampSandboxMode('workspace-write', 'danger-full-access')).toBe('workspace-write');
    expect(clampSandboxMode('full', null)).toBe('full');
  });
});

describe('resolveSandboxPolicy', () => {
  test('workspace-write defaults: cwd + tmp writable, network OFF', () => {
    const p = ws();
    expect(p.mode).toBe('workspace-write');
    expect(p.writableRoots).toEqual(['/work/project', '/tmp']);
    expect(p.network).toBe(false);
  });

  test('read-only writes nowhere and never has network', () => {
    const p = resolveSandboxPolicy({ mode: 'read-only', workspaceRoot: '/work', network: true });
    expect(p.writableRoots).toEqual([]);
    expect(p.network).toBe(false);
  });

  test('full always has network', () => {
    expect(resolveSandboxPolicy({ mode: 'full', workspaceRoot: '/work' }).network).toBe(true);
  });

  test('extra roots are normalized and deduped', () => {
    const p = ws({ extra: ['/data//sets/', '/tmp'] });
    expect(p.writableRoots).toEqual(['/work/project', '/tmp', '/data/sets']);
  });
});

describe('isPathWritable', () => {
  test('workspace-write allows inside roots, blocks outside', () => {
    const p = ws();
    expect(isPathWritable(p, '/work/project/src/a.ts')).toBe(true);
    expect(isPathWritable(p, '/work/project')).toBe(true);
    expect(isPathWritable(p, '/tmp/x')).toBe(true);
    expect(isPathWritable(p, '/work/project-evil/a')).toBe(false);
    expect(isPathWritable(p, '/home/user/.ssh/config')).toBe(false);
  });

  test('.. traversal cannot escape a root', () => {
    expect(isPathWritable(ws(), '/work/project/../other')).toBe(false);
  });

  test('relative paths fail closed', () => {
    expect(isPathWritable(ws(), 'src/a.ts')).toBe(false);
  });

  test('read-only blocks everything, full allows everything', () => {
    const ro = resolveSandboxPolicy({ mode: 'read-only', workspaceRoot: '/work' });
    const full = resolveSandboxPolicy({ mode: 'full', workspaceRoot: '/work' });
    expect(isPathWritable(ro, '/work/a')).toBe(false);
    expect(isPathWritable(full, '/etc/passwd')).toBe(true);
  });
});

describe('normalizePosixPath', () => {
  test('collapses dot segments and duplicate slashes', () => {
    expect(normalizePosixPath('/a//b/./c/../d')).toBe('/a/b/d');
    expect(normalizePosixPath('/..')).toBe('/');
    expect(normalizePosixPath('a/../../b')).toBe('../b');
  });
});

describe('detectSandboxDenial', () => {
  const enforcedAll = { filesystem: true, network: true } as const;

  test('maps EROFS to a filesystem escalation with the active mode', () => {
    const esc = detectSandboxDenial(ws(), {
      exitCode: 1,
      stderr: "touch: cannot touch '/home/u/x': Read-only file system",
    }, enforcedAll);
    expect(esc?.blocked).toBe('filesystem');
    expect(esc?.mode).toBe('workspace-write');
    expect(esc?.detail).toContain('Read-only file system');
  });

  test('maps network failures to a network escalation when network is off', () => {
    const esc = detectSandboxDenial(ws(), {
      exitCode: 7,
      stderr: 'curl: (7) Failed to connect to 127.0.0.1 port 8080 after 0 ms: Could not connect to server',
    }, enforcedAll);
    expect(esc?.blocked).toBe('network');
  });

  test('no escalation on success, when network is allowed, or when unenforced', () => {
    expect(detectSandboxDenial(ws(), { exitCode: 0, stderr: 'Read-only file system' }, enforcedAll)).toBeNull();
    expect(detectSandboxDenial(ws({ network: true }), { exitCode: 7, stderr: 'Network is unreachable' }, enforcedAll)).toBeNull();
    expect(detectSandboxDenial(ws(), { exitCode: 1, stderr: 'Read-only file system' }, { filesystem: false, network: false })).toBeNull();
  });

  test('format embeds a machine-parsable JSON line', () => {
    const text = formatSandboxEscalation(escalationForWrite(ws(), '/etc/x'));
    const json = JSON.parse(text.split('\n').pop()!) as { kind: string; blocked: string };
    expect(json.kind).toBe('sandbox_escalation');
    expect(json.blocked).toBe('filesystem');
    expect(text).toContain('mode=workspace-write');
  });
});

describe('buildSandboxedSpawn', () => {
  test('full mode never wraps', () => {
    const full = resolveSandboxPolicy({ mode: 'full', workspaceRoot: '/w' });
    const launch = buildSandboxedSpawn(full, 'bwrap', ['/bin/sh', '-c', 'x']);
    expect(launch.argv).toEqual(['/bin/sh', '-c', 'x']);
    expect(launch.enforced).toEqual({ filesystem: false, network: false });
    expect(launch.warning).toBeUndefined();
  });

  test('bwrap workspace-write: ro / with writable roots bound, net unshared', () => {
    const launch = buildSandboxedSpawn(ws(), 'bwrap', ['/bin/sh', '-c', 'x']);
    const argv = launch.argv.join(' ');
    expect(launch.argv[0]).toBe('bwrap');
    expect(argv).toContain('--ro-bind / /');
    expect(argv).toContain('--bind /work/project /work/project');
    expect(argv).toContain('--bind /tmp /tmp');
    expect(argv).toContain('--unshare-net');
    expect(launch.enforced).toEqual({ filesystem: true, network: true });
  });

  test('bwrap workspace-write with network on omits --unshare-net', () => {
    const launch = buildSandboxedSpawn(ws({ network: true }), 'bwrap', ['true']);
    expect(launch.argv).not.toContain('--unshare-net');
    expect(launch.enforced.network).toBe(false);
  });

  test('bwrap read-only: tmpfs /tmp, no binds, requested files ro-bound back', () => {
    const ro = resolveSandboxPolicy({ mode: 'read-only', workspaceRoot: '/w' });
    const launch = buildSandboxedSpawn(ro, 'bwrap', ['bun', 'run', '/tmp/f.mjs'], { readOnlyFiles: ['/tmp/f.mjs'] });
    const argv = launch.argv.join(' ');
    expect(argv).toContain('--tmpfs /tmp');
    expect(argv).toContain('--ro-bind /tmp/f.mjs /tmp/f.mjs');
    expect(argv).not.toContain('--bind /');
  });

  test('unshare fallback: network-only enforcement with a loud filesystem warning', () => {
    const launch = buildSandboxedSpawn(ws(), 'unshare', ['/bin/sh', '-c', 'x']);
    expect(launch.argv.slice(0, 2)).toEqual(['unshare', '-Ucn']);
    expect(launch.enforced).toEqual({ filesystem: false, network: true });
    expect(launch.warning).toContain('bwrap');
    expect(launch.warning).toContain('NOT enforced');
  });

  test('no backend: unsandboxed with a warning naming what is missing', () => {
    const launch = buildSandboxedSpawn(ws(), 'none', ['/bin/sh', '-c', 'x']);
    expect(launch.argv).toEqual(['/bin/sh', '-c', 'x']);
    expect(launch.warning).toContain('UNSANDBOXED');
    expect(launch.warning).toContain('bwrap');
    expect(launch.warning).toContain('sandbox-exec');
  });

  // Seatbelt is generated on this Linux host but cannot run here — shape only.
  test('seatbelt profile shape (UNTESTED on this host: no macOS)', () => {
    const profile = buildSeatbeltProfile(ws());
    expect(profile).toContain('(deny default)');
    expect(profile).toContain('(allow file-read*)');
    expect(profile).toContain('(allow file-write* (subpath "/work/project") (subpath "/tmp"))');
    expect(profile).not.toContain('(allow network*)');
    expect(buildSeatbeltProfile(ws({ network: true }))).toContain('(allow network*)');
    const launch = buildSandboxedSpawn(ws(), 'seatbelt', ['/bin/sh', '-c', 'x']);
    expect(launch.argv[0]).toBe('sandbox-exec');
    expect(launch.argv[1]).toBe('-p');
  });
});

describe('parseSandboxEnforcementReport', () => {
  test('round-trips a daemon HELLO sandbox field', () => {
    const report = parseSandboxEnforcementReport({
      mode: 'workspace-write',
      writableRoots: ['/home/u', '/tmp'],
      network: false,
      backend: 'bwrap',
      enforced: { filesystem: true, network: true },
    });
    expect(report).toEqual({
      mode: 'workspace-write',
      writableRoots: ['/home/u', '/tmp'],
      network: false,
      backend: 'bwrap',
      enforced: { filesystem: true, network: true },
    });
  });

  test('rejects malformed values', () => {
    expect(parseSandboxEnforcementReport(null)).toBeNull();
    expect(parseSandboxEnforcementReport({ mode: 'yolo', backend: 'bwrap' })).toBeNull();
    expect(parseSandboxEnforcementReport({ mode: 'full' })).toBeNull();
  });
});
