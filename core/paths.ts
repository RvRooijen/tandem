// Paths on disk are the platform's (backslashes and any case on Windows); a
// path in a project, as git, the commands and the conversation have it, is
// always relative with forward slashes.
import { isAbsolute, relative, sep } from 'node:path';

/**
 * Where an absolute path is in a folder, as a path in it ('' for the folder itself); undefined when it is not in
 * it, or not absolute.
 */
export function within(dir: string, path: string): string | undefined {
  if (!path || !isAbsolute(path)) return undefined;
  const rel = relative(dir, path);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return undefined;
  return rel.split(sep).join('/');
}
