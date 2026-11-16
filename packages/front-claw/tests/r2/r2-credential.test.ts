// R2-5（D46）：凭据文件读取规则。全部用合成连接串（SYNTHETIC），文件建在仓库外的 R2/tmp 下；不读任何真实 env 文件。
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CredentialError, DATABASE_URL_FILE, MIGRATION_DATABASE_URL_FILE, readCredentialFile, readOnlyMountFromInfo, resetCredentialCacheForTests,
  resolveBusinessDatabaseUrl, type CredentialDeps,
} from '../../src/role-eval/credential-file.js';
import { runCli } from '../../src/migration/cli.js';

const SECRET = 'SYNTHETIC-PW-7f3a';
const BIZ = `postgres://fc_biz:${SECRET}@127.0.0.1:1/fc`;
const MIG = `postgres://fc_migrate:${SECRET}-m@127.0.0.1:1/fc`;
const dir = mkdtempSync(join(process.env.TMPDIR && !process.env.TMPDIR.includes('repo-r2') ? process.env.TMPDIR : tmpdir(), 'r2-cred-'));
const ok: CredentialDeps = { readOnlyMount: () => true };
let n = 0;
function file(content: string, mode = 0o600): string {
  const path = join(dir, `cred-${++n}`);
  writeFileSync(path, content, { mode }); chmodSync(path, mode);
  return path;
}
const issue = (fn: () => unknown) => { try { fn(); } catch (error) { expect(error).toBeInstanceOf(CredentialError); expect(String((error as Error).message)).not.toContain(SECRET); return (error as CredentialError).issue; } return 'no_error'; };
beforeEach(() => resetCredentialCacheForTests());
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('R2 D46 凭据文件', () => {
  it('合规文件（0600、本人、只读挂载、单行 URL）→ 读出；启动后只读一次（改文件不生效，重启才生效 = 轮换）', () => {
    const path = file(`${BIZ}\n`);
    expect(readCredentialFile(path, ok)).toBe(BIZ);
    writeFileSync(path, `${MIG}\n`);
    expect(readCredentialFile(path, ok)).toBe(BIZ);
    resetCredentialCacheForTests();
    expect(readCredentialFile(path, ok)).toBe(MIG);
  });
  it('权限/属主/挂载/路径/符号链接/内容 不合规 → 固定错误码，错误里不含连接串', () => {
    expect(issue(() => readCredentialFile(file(BIZ, 0o640), ok))).toBe('mode_too_open');
    expect(issue(() => readCredentialFile(file(BIZ, 0o604), ok))).toBe('mode_too_open');
    expect(issue(() => readCredentialFile(file(BIZ), { ...ok, uid: 4242 }))).toBe('wrong_owner');
    expect(issue(() => readCredentialFile(file(BIZ), { readOnlyMount: () => false }))).toBe('not_readonly_mount');
    expect(issue(() => readCredentialFile(file(BIZ)))).toBe('not_readonly_mount'); // 默认读 /proc/self/mountinfo：R2/tmp 是可写挂载
    expect(issue(() => readCredentialFile('relative/cred', ok))).toBe('not_absolute');
    expect(issue(() => readCredentialFile(join(process.cwd(), 'never-created-cred'), ok))).toBe('inside_repo');
    const target = file(BIZ); const link = join(dir, `link-${++n}`); symlinkSync(target, link);
    expect(issue(() => readCredentialFile(link, ok))).toBe('symlink');
    expect(issue(() => readCredentialFile(dir, ok))).toBe('not_regular');
    expect(issue(() => readCredentialFile(join(dir, 'missing'), ok))).toBe('unreadable');
    expect(issue(() => readCredentialFile(file(''), ok))).toBe('empty');
    expect(issue(() => readCredentialFile(file(`${BIZ}\n${MIG}\n`), ok))).toBe('multi_line');
    expect(issue(() => readCredentialFile(file(`PGPASSWORD=${SECRET}`), ok))).toBe('not_postgres_url');
    expect(issue(() => readCredentialFile(file(` ${BIZ}`), ok))).toBe('not_postgres_url');
    expect(issue(() => readCredentialFile(file(`postgres://x:${'a'.repeat(5000)}@h/d`), ok))).toBe('too_large');
  });
  it('mountinfo 解析：取最长前缀挂载点的 ro 选项', () => {
    const info = ['22 1 0:1 / / rw,relatime - ext4 /dev/a rw', '30 22 0:2 / /run/secrets ro,nosuid - tmpfs t ro', '31 30 0:3 / /run/secrets/rw rw - tmpfs t rw'].join('\n');
    expect(readOnlyMountFromInfo(info, '/run/secrets/db')).toBe(true);
    expect(readOnlyMountFromInfo(info, '/run/secrets/rw/db')).toBe(false);
    expect(readOnlyMountFromInfo(info, '/run/secretsX/db')).toBe(false);
    expect(readOnlyMountFromInfo(info, '/home/a')).toBe(false);
  });
  it('业务/迁移账号必须不同；生产拒绝直接 env 连接串；非生产 env 兼容（测试/本地）', () => {
    const biz = file(BIZ), mig = file(MIG), same = file(BIZ.replace(SECRET, 'other'));
    expect(resolveBusinessDatabaseUrl({ [DATABASE_URL_FILE]: biz, [MIGRATION_DATABASE_URL_FILE]: mig }, ok)).toEqual({ url: BIZ, source: 'file' });
    expect(issue(() => resolveBusinessDatabaseUrl({ [DATABASE_URL_FILE]: biz, [MIGRATION_DATABASE_URL_FILE]: same }, ok))).toBe('same_account');
    expect(issue(() => resolveBusinessDatabaseUrl({ NODE_ENV: 'production', FRONT_CLAW_DATABASE_URL: BIZ }, ok))).toBe('env_url_forbidden');
    expect(resolveBusinessDatabaseUrl({ NODE_ENV: 'production', [DATABASE_URL_FILE]: biz, FRONT_CLAW_DATABASE_URL: 'postgres://ignored@h/d' }, ok)).toEqual({ url: BIZ, source: 'file' });
    expect(resolveBusinessDatabaseUrl({ FRONT_CLAW_DATABASE_URL: BIZ }, ok)).toEqual({ url: BIZ, source: 'env' });
    expect(resolveBusinessDatabaseUrl({}, ok)).toEqual({ url: '', source: 'none' });
  });
  it('值不写进 process.env、子进程环境里没有它（只有文件路径）', () => {
    const path = file(BIZ);
    const before = { ...process.env };
    resolveBusinessDatabaseUrl({ [DATABASE_URL_FILE]: path }, ok);
    expect(JSON.stringify(process.env)).not.toContain(SECRET);
    expect(process.env).toEqual(before);
    const child = spawnSync(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(process.env))'], { env: { ...process.env, [DATABASE_URL_FILE]: path }, encoding: 'utf8' });
    expect(child.stdout).toContain(path); expect(child.stdout).not.toContain(SECRET);
  });
  it('迁移 CLI：目标库读迁移账号文件；与业务账号同名 → 拒绝且不连库；输出不含连接串', async () => {
    const open = vi.fn(async () => { throw Error('should_not_connect'); });
    const biz = file(BIZ), same = file(BIZ.replace(SECRET, 'x2'));
    const r = await runCli(['schema-status'], { [DATABASE_URL_FILE]: biz, [MIGRATION_DATABASE_URL_FILE]: same }, { open, credentials: ok });
    expect(r.code).toBe(1); expect(JSON.stringify(r.report)).toContain('SAME_ACCOUNT'); expect(open).not.toHaveBeenCalled();
    const mig = file(MIG);
    const used: string[] = [];
    const r2 = await runCli(['schema-status'], { [DATABASE_URL_FILE]: biz, [MIGRATION_DATABASE_URL_FILE]: mig }, { credentials: ok, open: async url => { used.push(url); throw Object.assign(Error(`connect ${url}`), {}); } });
    expect(used).toEqual([MIG]); expect(JSON.stringify(r2.report)).not.toContain(SECRET);
  });
});
