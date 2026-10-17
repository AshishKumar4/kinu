import type { EsbuildReadFs } from '@nimbus-sh/core/runtime/esbuild-service.js';
import type { NamespaceFs } from '@nimbus-sh/core/runtime/process-files.js';

function normalPath(path: string): string {
  const parts: string[] = [];

  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue;

    if (part === '..') parts.pop();
    else parts.push(part);
  }

  return `/${parts.join('/')}`;
}

/** A build's entire source reader: only resolved paths in its tree and generated runtime are visible. */
export function confinedTo(fs: Pick<NamespaceFs, 'exists' | 'resolveSymlink' | 'isDirectory' | 'readFile' | 'readFileString'>, roots: readonly string[], files: readonly string[]): EsbuildReadFs {
  const inside = (path: string): boolean => {
    const at = normalPath(path);
    const real = fs.exists(at) ? fs.resolveSymlink(at) : at;

    if (real === null) return false;
    const resolved = normalPath(real);

    return files.includes(resolved) || roots.some((root) => resolved === root || resolved.startsWith(`${root}/`));
  };

  return {
    exists: (path) => inside(path) && fs.exists(path),
    isDirectory: (path) => inside(path) && fs.isDirectory(path),
    readFile: (path) => (inside(path) ? fs.readFile(path) : new Uint8Array()),
    readFileString: (path) => (inside(path) ? fs.readFileString(path) : ''),
  };
}
