/**
 * R2（D46 默认方案）：数据库连接串只从仓库外的一个凭据文件读取。
 * - 文件：绝对路径、不在仓库内、不是符号链接、是普通文件、权限不宽于 0600、属主是当前用户、所在挂载点只读（/proc/self/mountinfo）。
 * - 内容：单行 postgres:// 或 postgresql:// URL（末尾换行可有可无）；其他一律拒绝。
 * - 启动时读一次并缓存（同一路径不重读）；值从不写进 process.env、不传给子进程、不进日志；所有错误只带固定错误码，不带路径以外的内容、不带文件内容。
 * - 轮换 = 替换文件后重启进程（运行中不重读）。
 * - 业务账号和迁移账号各一个，用户名必须不同（业务账号最小权限：不跑 DDL，只核对 schema 版本）。
 * - 生产（NODE_ENV=production）拒绝直接用 env 里的连接串（FRONT_CLAW_DATABASE_URL）。
 */
import { closeSync, fstatSync, lstatSync, openSync, readFileSync, readSync, realpathSync, constants } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DATABASE_URL_FILE = 'FRONT_CLAW_DATABASE_URL_FILE';
export const MIGRATION_DATABASE_URL_FILE = 'FRONT_CLAW_MIGRATION_DATABASE_URL_FILE';
export const DIRECT_DATABASE_URL = 'FRONT_CLAW_DATABASE_URL';

export type CredentialIssue = 'not_absolute' | 'inside_repo' | 'symlink' | 'not_regular' | 'mode_too_open' | 'wrong_owner' | 'not_readonly_mount'
  | 'unreadable' | 'empty' | 'multi_line' | 'not_postgres_url' | 'too_large' | 'same_account' | 'env_url_forbidden';
export class CredentialError extends Error {
  constructor(readonly issue: CredentialIssue) { super(`FRONT_CLAW_CREDENTIAL_${issue.toUpperCase()}`); this.name = 'CredentialError'; }
}

export interface CredentialDeps {
  /** 仓库根（默认按本文件位置推算）。 */
  repoRoot?: string;
  /** 当前 uid（默认 process.getuid()）。 */
  uid?: number;
  /** 返回该路径所在挂载点是否只读（默认读 /proc/self/mountinfo）。 */
  readOnlyMount?: (realPath: string) => boolean;
}

const MAX_BYTES = 4096;
const defaultRepoRoot = () => resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 解析 /proc/self/mountinfo：取最长前缀匹配的挂载点，看挂载选项里有没有 ro。 */
export function readOnlyMountFromInfo(info: string, realPath: string): boolean {
  let best: { point: string; ro: boolean } | null = null;
  for (const line of info.split('\n')) {
    const fields = line.split(' ');
    if (fields.length < 6) continue;
    const point = fields[4]!.replace(/\\040/g, ' ');
    const options = fields[5]!.split(',');
    const inside = point === '/' || realPath === point || realPath.startsWith(point.endsWith('/') ? point : `${point}/`);
    if (inside && (!best || point.length >= best.point.length)) best = { point, ro: options.includes('ro') };
  }
  return best?.ro ?? false;
}
function defaultReadOnlyMount(realPath: string): boolean {
  try { return readOnlyMountFromInfo(readFileSync('/proc/self/mountinfo', 'utf8'), realPath); } catch { return false; }
}

const cache = new Map<string, string>();
/** 仅测试用：清缓存（模拟“重启”）。 */
export function resetCredentialCacheForTests(): void { cache.clear(); }

/** 读取并校验一个凭据文件；同一路径只读一次。 */
export function readCredentialFile(path: string, deps: CredentialDeps = {}): string {
  const cached = cache.get(path);
  if (cached !== undefined) return cached;
  if (!isAbsolute(path)) throw new CredentialError('not_absolute');
  const root = resolve(deps.repoRoot ?? defaultRepoRoot());
  const insideRepo = (p: string) => { const rel = relative(root, p); return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel)); };
  if (insideRepo(resolve(path))) throw new CredentialError('inside_repo');
  let link;
  try { link = lstatSync(path); } catch { throw new CredentialError('unreadable'); }
  if (link.isSymbolicLink()) throw new CredentialError('symlink');
  if (!link.isFile()) throw new CredentialError('not_regular');
  let real: string;
  try { real = realpathSync(path); } catch { throw new CredentialError('unreadable'); }
  if (insideRepo(real)) throw new CredentialError('inside_repo');
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); } catch { throw new CredentialError('unreadable'); }
  let text: string;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.ino !== link.ino || stat.dev !== link.dev) throw new CredentialError('not_regular');
    if ((stat.mode & 0o077) !== 0 || (stat.mode & 0o7000) !== 0) throw new CredentialError('mode_too_open');
    const uid = deps.uid ?? (typeof process.getuid === 'function' ? process.getuid() : -1);
    if (stat.uid !== uid) throw new CredentialError('wrong_owner');
    if (!(deps.readOnlyMount ?? defaultReadOnlyMount)(real)) throw new CredentialError('not_readonly_mount');
    if (stat.size > MAX_BYTES) throw new CredentialError('too_large');
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    const n = readSync(fd, buffer, 0, buffer.length, 0);
    if (n > MAX_BYTES) throw new CredentialError('too_large');
    text = buffer.subarray(0, n).toString('utf8');
    buffer.fill(0);
  } finally { closeSync(fd); }
  const value = text.replace(/\r?\n$/, '');
  if (!value.trim()) throw new CredentialError('empty');
  if (/[\r\n]/.test(value)) throw new CredentialError('multi_line');
  if (value !== value.trim() || !/^postgres(?:ql)?:\/\/\S+$/.test(value)) throw new CredentialError('not_postgres_url');
  try { new URL(value); } catch { throw new CredentialError('not_postgres_url'); }
  cache.set(path, value);
  return value;
}

export const accountOf = (url: string): string => { try { return decodeURIComponent(new URL(url).username); } catch { return ''; } };

export interface ResolvedDatabaseUrl { url: string; source: 'file' | 'env' | 'none' }
/**
 * 业务进程的连接串：优先文件（FRONT_CLAW_DATABASE_URL_FILE）；生产拒绝直接 env；非生产保留 env 兼容（测试/本地）。
 * 若同时配置了迁移账号文件，两者用户名必须不同。
 */
export function resolveBusinessDatabaseUrl(env: Readonly<Record<string, string | undefined>>, deps: CredentialDeps = {}): ResolvedDatabaseUrl {
  const file = env[DATABASE_URL_FILE]?.trim() ?? '';
  const direct = env[DIRECT_DATABASE_URL]?.trim() ?? '';
  if (file) {
    const url = readCredentialFile(file, deps);
    const migration = env[MIGRATION_DATABASE_URL_FILE]?.trim() ?? '';
    if (migration) {
      const other = readCredentialFile(migration, deps);
      if (!accountOf(url) || accountOf(url) === accountOf(other)) throw new CredentialError('same_account');
    }
    return { url, source: 'file' };
  }
  if (direct) {
    if (env.NODE_ENV === 'production') throw new CredentialError('env_url_forbidden');
    return { url: direct, source: 'env' };
  }
  return { url: '', source: 'none' };
}
/** 迁移工具的目标库连接串：优先文件（FRONT_CLAW_MIGRATION_DATABASE_URL_FILE）；配置了业务文件时用户名必须不同。 */
export function resolveMigrationDatabaseUrl(env: Readonly<Record<string, string | undefined>>, fallbackEnv: string, deps: CredentialDeps = {}): ResolvedDatabaseUrl {
  const file = env[MIGRATION_DATABASE_URL_FILE]?.trim() ?? '';
  if (file) {
    const url = readCredentialFile(file, deps);
    const business = env[DATABASE_URL_FILE]?.trim() ?? '';
    if (business && (!accountOf(url) || accountOf(url) === accountOf(readCredentialFile(business, deps)))) throw new CredentialError('same_account');
    return { url, source: 'file' };
  }
  const direct = env[fallbackEnv]?.trim() ?? '';
  return direct ? { url: direct, source: 'env' } : { url: '', source: 'none' };
}
/** 是否配置了业务数据库（文件或 env），不读文件。 */
export const databaseConfigured = (env: Readonly<Record<string, string | undefined>>): boolean =>
  !!(env[DATABASE_URL_FILE]?.trim() || env[DIRECT_DATABASE_URL]?.trim());
