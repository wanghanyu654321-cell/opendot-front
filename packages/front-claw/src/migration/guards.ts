/**
 * M08 / R6 守卫：
 * - 迁移源地址不接受任意 URL：主机和端口只从固定配置读（FRONT_CLAW_MIGRATE_SOURCE_HOST / PORT）。
 * - 连接前把配置主机解析成 IP，再和白名单比对；白名单为空则失败关闭。
 * - 拒绝 unix socket。
 * - 仍保留对共用库名/主机名的拒绝名单（双保险）。
 */
import { promises as dns } from 'node:dns';

const FORBIDDEN = [/legacy-shared-pg/i, /legacy_appointment_db/i];

export type AddressLookup = (host: string) => Promise<readonly { address: string; family?: number }[]>;

export const defaultLookup: AddressLookup = async host => {
  const rows = await dns.lookup(host, { all: true });
  return rows.map(row => ({ address: row.address, family: row.family }));
};

export function assertSafeUrl(url: string, role: string): void {
  if (!url.trim()) throw Error(`missing_${role}_url`);
  let decoded = url;
  try { decoded = decodeURIComponent(url); } catch { /* keep raw */ }
  let twice = decoded;
  try { twice = decodeURIComponent(decoded); } catch { /* keep */ }
  if (FORBIDDEN.some(pattern => pattern.test(url) || pattern.test(decoded) || pattern.test(twice))) {
    throw Error(`forbidden_${role}_database`);
  }
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw Error(`invalid_${role}_url`); }
  if (!/^postgres(ql)?:$/.test(parsed.protocol)) throw Error(`invalid_${role}_url`);
}

/** 同一库（主机+端口+库名）→ 拒绝（源与目标、目标与回退目的库必须不同）。 */
export function sameDatabase(a: string, b: string): boolean {
  const key = (url: string) => { const u = new URL(url); return `${u.hostname.toLowerCase()}:${u.port || '5432'}/${decodeURIComponent(u.pathname.replace(/^\//, '')) || u.username}`; };
  return key(a) === key(b);
}

export function isUnixSocketUrl(url: string): boolean {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return false; }
  const queryHost = parsed.searchParams.get('host') ?? '';
  const host = parsed.hostname;
  if (!host && !queryHost) return true;
  const candidates = [host, queryHost, safeDecode(host), safeDecode(queryHost)];
  return candidates.some(value => value.startsWith('/') || value.startsWith('%2f') || value.startsWith('%2F'));
}

function safeDecode(value: string): string {
  try { return decodeURIComponent(value); } catch { return value; }
}

export function parseAllowlist(text: string | undefined): string[] {
  return (text ?? '').split(/[,;\s]+/).map(item => item.trim()).filter(Boolean);
}

export interface SourceConnectConfig {
  /** 凭据与库名可从 URL 读；主机和端口一律忽略，改用 host/port。 */
  url: string;
  host: string;
  port: number | string;
  allowed?: readonly string[] | string | undefined;
  lookup?: AddressLookup | undefined;
  role?: string;
}

export interface ResolvedSource {
  connectionUrl: string;
  address: string;
  host: string;
  port: number;
  database: string;
}

/**
 * 解析源库连接：主机和端口只来自固定配置；解析 IP 后与白名单比对；拒绝 unix socket。
 * 白名单为空、解析失败、IP 不在名单里一律拒绝（失败关闭）。
 */
export async function resolveSourceConnection(input: SourceConnectConfig): Promise<ResolvedSource> {
  const role = input.role ?? 'source';
  assertSafeUrl(input.url, role);
  if (isUnixSocketUrl(input.url)) throw Error(`unix_socket_forbidden_${role}`);
  const host = (input.host ?? '').trim();
  const port = Number(input.port);
  if (!host) throw Error(`missing_${role}_host`);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw Error(`missing_${role}_port`);
  if (host.startsWith('/') || host.startsWith('@')) throw Error(`unix_socket_forbidden_${role}`);

  const allowedRaw = Array.isArray(input.allowed) ? [...input.allowed] : parseAllowlist(typeof input.allowed === 'string' ? input.allowed : undefined);
  if (!allowedRaw.length) throw Error(`empty_allowlist_${role}`);

  const lookup = input.lookup ?? defaultLookup;
  let resolved: readonly { address: string }[];
  try {
    resolved = await lookup(host);
  } catch {
    throw Error(`unresolved_${role}_host`);
  }
  const addresses = [...new Set(resolved.map(row => row.address).filter(Boolean))];
  if (!addresses.length) throw Error(`unresolved_${role}_host`);

  const allowedIps = new Set<string>();
  for (const item of allowedRaw) {
    const parsed = parseAllowedItem(item);
    try {
      const rows = isBareIp(parsed.host) ? [{ address: parsed.host }] : await lookup(parsed.host);
      for (const row of rows) allowedIps.add(row.address);
    } catch {
      if (isBareIp(parsed.host)) allowedIps.add(parsed.host);
    }
  }
  const portsInList = allowedRaw.map(parseAllowedItem).filter(item => item.port !== undefined);
  if (portsInList.length && portsInList.every(item => item.port !== port)) {
    throw Error(`forbidden_${role}_database`);
  }
  const dbsInList = allowedRaw.map(parseAllowedItem).filter(item => item.dbname);
  let parsedUrl: URL;
  try { parsedUrl = new URL(input.url); } catch { throw Error(`invalid_${role}_url`); }
  const database = decodeURIComponent(parsedUrl.pathname.replace(/^\//, '')) || parsedUrl.username;
  if (dbsInList.length && dbsInList.every(item => item.dbname !== database)) {
    throw Error(`forbidden_${role}_database`);
  }

  const matched = addresses.filter(ip => allowedIps.has(ip));
  if (!matched.length) throw Error(`forbidden_${role}_database`);

  const user = decodeURIComponent(parsedUrl.username || '');
  const password = decodeURIComponent(parsedUrl.password || '');
  const auth = user ? `${encodeURIComponent(user)}${password ? `:${encodeURIComponent(password)}` : ''}@` : '';
  const connectionUrl = `postgres://${auth}${host}:${port}/${encodeURIComponent(database)}`;
  return { connectionUrl, address: matched[0]!, host, port, database };
}

function isBareIp(value: string): boolean {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) return true;
  if (/^[0-9a-fA-F:]+$/.test(value) && value.includes(':')) return true;
  return false;
}

function parseAllowedItem(item: string): { host: string; port?: number; dbname?: string } {
  const trimmed = item.trim();
  const [hostPort, ...dbParts] = trimmed.split('/');
  const dbname = dbParts.join('/') || undefined;
  const raw = hostPort ?? trimmed;
  const out: { host: string; port?: number; dbname?: string } = { host: raw };
  if (dbname) out.dbname = dbname;
  if (raw.startsWith('[')) {
    const end = raw.indexOf(']');
    const host = raw.slice(1, end);
    const rest = raw.slice(end + 1);
    const port = rest.startsWith(':') ? Number(rest.slice(1)) : undefined;
    const itemOut: { host: string; port?: number; dbname?: string } = { host };
    if (Number.isInteger(port) && port !== undefined) itemOut.port = port;
    if (dbname) itemOut.dbname = dbname;
    return itemOut;
  }
  if (isBareIp(raw)) {
    const itemOut: { host: string; dbname?: string } = { host: raw };
    if (dbname) itemOut.dbname = dbname;
    return itemOut;
  }
  const colon = raw.lastIndexOf(':');
  if (colon > 0) {
    const port = Number(raw.slice(colon + 1));
    if (Number.isInteger(port)) {
      const itemOut: { host: string; port: number; dbname?: string } = { host: raw.slice(0, colon), port };
      if (dbname) itemOut.dbname = dbname;
      return itemOut;
    }
  }
  return out;
}
