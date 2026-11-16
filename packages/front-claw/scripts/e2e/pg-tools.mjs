import path from 'node:path';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';

const isExecutable = async file => { try { await access(file, constants.X_OK); return true; } catch { return false; } };

/** A server-only binary directory is valid: backup clients may come from PATH. */
export async function resolvePgTool(env, tool, executable = isExecutable) {
  if (!['pg_dump', 'pg_restore'].includes(tool)) throw Error('unsupported_pg_tool');
  const key = tool.toUpperCase();
  const explicit = env[key];
  const candidates = explicit
    ? (explicit.includes(path.sep) ? [explicit] : (env.PATH ?? '').split(path.delimiter).filter(Boolean).map(directory => path.join(directory, explicit)))
    : [...(env.PG_BIN ? [path.join(env.PG_BIN, tool)] : []), ...(env.PATH ?? '').split(path.delimiter).filter(Boolean).map(directory => path.join(directory, tool))];
  for (const candidate of candidates) if (await executable(candidate)) return candidate;
  throw Object.assign(Error(`${key}_NOT_FOUND: set ${key}, provide ${tool} in PG_BIN, or install it on PATH`), { code: `${key}_NOT_FOUND` });
}
