#!/usr/bin/env node
/**
 * M08 迁移命令（离线工具；默认 dry-run，写入必须加 --apply）。连接串只从 env 读，不打印：
 *   FRONT_CLAW_MIGRATE_SOURCE_URL    旧 Front Claw PG 的授权副本（只读连接）
 *   FRONT_CLAW_MIGRATE_TARGET_URL    OpenDot 侧专用 Front Claw PG
 *   FRONT_CLAW_MIGRATE_ROLLBACK_URL  R2 回退导出的新隔离库
 * postflight 默认严格（导入后任何行被改都报错）；切换营业后复核加 --allow-changed。
 * 命令：schema-status | schema-up | schema-down | preflight | import | postflight | export-rollback
 * 源库主机和端口只从 FRONT_CLAW_MIGRATE_SOURCE_HOST / PORT 读，连接前解析 IP 与 FRONT_CLAW_MIGRATE_ALLOWED 比对；
 * 拒绝 unix socket；源库连接后校验专用只读角色（无写权限）。目标/回退仍拒绝共用库名。源=目标、目标=回退库也拒绝。
 */
import { migrateDown, migrateUp, schemaVersion } from '../role-eval/schema-migrations.js';
import { assertSafeUrl, resolveSourceConnection, sameDatabase } from './guards.js';
import { importData, postflight, preflight } from './import.js';
import { openSql, type OpenedSql, type OpenSqlOptions } from './pg.js';
import type { AddressLookup } from './guards.js';
import { resolveMigrationDatabaseUrl, type CredentialDeps } from '../role-eval/credential-file.js';
import { exportForRollback } from './rollback-export.js';

export const SOURCE_ENV = 'FRONT_CLAW_MIGRATE_SOURCE_URL';
export const TARGET_ENV = 'FRONT_CLAW_MIGRATE_TARGET_URL';
export const ROLLBACK_ENV = 'FRONT_CLAW_MIGRATE_ROLLBACK_URL';
export const SOURCE_HOST_ENV = 'FRONT_CLAW_MIGRATE_SOURCE_HOST';
export const SOURCE_PORT_ENV = 'FRONT_CLAW_MIGRATE_SOURCE_PORT';
export const ALLOWED_ENV = 'FRONT_CLAW_MIGRATE_ALLOWED';
export const COMMANDS = ['schema-status', 'schema-up', 'schema-down', 'preflight', 'import', 'postflight', 'export-rollback'] as const;
type Command = typeof COMMANDS[number];

export interface CliDeps { open?: (url: string, options: OpenSqlOptions) => Promise<OpenedSql>; credentials?: CredentialDeps; lookup?: AddressLookup }
export async function runCli(argv: readonly string[], env: Readonly<Record<string, string | undefined>>, deps: CliDeps = {}): Promise<{ code: number; report: unknown }> {
  const command = argv[0] as Command;
  if (!COMMANDS.includes(command)) return { code: 2, report: { error: 'usage', commands: COMMANDS } };
  const apply = argv.includes('--apply');
  const label = argv.find(arg => arg.startsWith('--source-label='))?.slice('--source-label='.length) ?? 'unlabelled-copy';
  const batch = Number(argv.find(arg => arg.startsWith('--batch='))?.slice('--batch='.length) ?? '200');
  const open = deps.open ?? openSql;
  const url = (name: string, role: string) => { const value = env[name]?.trim() ?? ''; assertSafeUrl(value, role); return value; };
  const opened: OpenedSql[] = [];
  const connect = async (value: string, options: OpenSqlOptions = {}) => { const handle = await open(value, options); opened.push(handle); return handle.client; };
  try {
    // R2（D46）：目标库优先用迁移账号凭据文件（FRONT_CLAW_MIGRATION_DATABASE_URL_FILE），与业务账号用户名必须不同。
    const fromFile = resolveMigrationDatabaseUrl(env, TARGET_ENV, deps.credentials);
    const target = fromFile.source === 'file' ? (assertSafeUrl(fromFile.url, 'target'), fromFile.url) : url(TARGET_ENV, 'target');
    if (command === 'schema-status') {
      const client = await connect(target, { readOnly: true });
      return { code: 0, report: { command, version: await schemaVersion(client.query.bind(client)) } };
    }
    if (command === 'schema-up') return { code: 0, report: { command, ...(await migrateUp(await connect(target), { apply })) } };
    if (command === 'schema-down') return { code: 0, report: { command, ...(await migrateDown(await connect(target), { apply })) } };
    if (command === 'export-rollback') {
      const dest = url(ROLLBACK_ENV, 'rollback');
      if (sameDatabase(target, dest)) throw Error('rollback_same_as_target');
      const from = await connect(target, { readOnly: true });
      const result = await exportForRollback(from, await connect(dest), { apply });
      return { code: result.dryRun || result.verified ? 0 : 1, report: { command, ...result } };
    }
    const sourceUrl = url(SOURCE_ENV, 'source');
    const resolved = await resolveSourceConnection({
      url: sourceUrl,
      host: env[SOURCE_HOST_ENV] ?? '',
      port: env[SOURCE_PORT_ENV] ?? '',
      allowed: env[ALLOWED_ENV],
      lookup: deps.lookup,
    });
    if (sameDatabase(resolved.connectionUrl, target)) throw Error('source_same_as_target');
    const source = await connect(resolved.connectionUrl, { readOnly: true, requireReadonlyRole: true });
    if (command === 'preflight') {
      const tgt = await connect(target, { readOnly: true });
      const result = await preflight(source.query.bind(source), tgt.query.bind(tgt));
      return { code: result.ok ? 0 : 1, report: { command, ...result } };
    }
    if (command === 'postflight') {
      const tgt = await connect(target, { readOnly: true });
      const result = await postflight(source.query.bind(source), tgt.query.bind(tgt), { allowChanged: argv.includes('--allow-changed') });
      return { code: result.ok ? 0 : 1, report: { command, ...result } };
    }
    const result = await importData(source, await connect(target), { apply, sourceLabel: label, batchSize: Number.isSafeInteger(batch) ? batch : 200 });
    return { code: result.preflight.ok ? 0 : 1, report: { command, ...result } };
  } catch (error) {
    return { code: 1, report: { command, error: error instanceof Error ? error.message.replace(/postgres(ql)?:\/\/\S+/gi, '<url>') : 'unknown' } };
  } finally {
    await Promise.allSettled(opened.map(handle => handle.close()));
  }
}

const isMain = typeof process !== 'undefined' && process.argv[1] !== undefined && /migration[\\/]cli\.(js|ts)$/.test(process.argv[1]);
if (isMain) {
  runCli(process.argv.slice(2), process.env).then(({ code, report }) => {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = code;
  }, () => { process.exitCode = 1; });
}
