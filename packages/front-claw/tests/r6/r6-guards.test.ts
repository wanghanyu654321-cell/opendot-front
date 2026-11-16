import { describe, expect, it } from 'vitest';
import { isUnixSocketUrl, resolveSourceConnection, assertSafeUrl } from '../../src/migration/guards.js';
import { SOURCE_HOST_ENV, SOURCE_PORT_ENV, ALLOWED_ENV, SOURCE_ENV, TARGET_ENV, runCli } from '../../src/migration/cli.js';

const lookup = async (host: string) => {
  if (host === 'safe.internal' || host === '127.0.0.1') return [{ address: '127.0.0.1' }];
  if (host === 'alias-for-shared') return [{ address: '10.8.0.5' }];
  if (host === '10.8.0.5') return [{ address: '10.8.0.5' }];
  if (host === 'evil.example') return [{ address: '203.0.113.9' }];
  throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
};

describe('R6 M08-01：源库主机端口只从固定配置读，解析 IP 对白名单，拒绝 socket', () => {
  const base = {
    url: 'postgres://frontclaw@ignored.example:5432/copy_db',
    host: 'safe.internal',
    port: 55432,
    allowed: ['127.0.0.1'],
    lookup,
  };

  it('成功：配置主机解析到白名单 IP，连接串用配置主机和端口而不是 URL 里的主机', async () => {
    const got = await resolveSourceConnection(base);
    expect(got.address).toBe('127.0.0.1');
    expect(got.host).toBe('safe.internal');
    expect(got.port).toBe(55432);
    expect(got.database).toBe('copy_db');
    expect(got.connectionUrl).toBe('postgres://frontclaw@safe.internal:55432/copy_db');
    expect(got.connectionUrl).not.toContain('ignored.example');
  });

  it('白名单为空失败关闭；IP 不在名单拒绝；主机解析失败拒绝', async () => {
    await expect(resolveSourceConnection({ ...base, allowed: [] })).rejects.toThrow(/empty_allowlist_source/);
    await expect(resolveSourceConnection({ ...base, allowed: undefined })).rejects.toThrow(/empty_allowlist_source/);
    await expect(resolveSourceConnection({ ...base, allowed: ['203.0.113.9'] })).rejects.toThrow(/forbidden_source_database/);
    await expect(resolveSourceConnection({ ...base, host: 'no-such-host.invalid' })).rejects.toThrow(/unresolved_source_host/);
    await expect(resolveSourceConnection({ ...base, host: '' })).rejects.toThrow(/missing_source_host/);
    await expect(resolveSourceConnection({ ...base, port: 'abc' })).rejects.toThrow(/missing_source_port/);
  });

  it('绕过：URL 写共享库 IP / 别名 / 双重编码仍被拒绝；unix socket 一律拒绝', async () => {
    await expect(resolveSourceConnection({
      ...base, url: 'postgres://u@10.8.0.5:5432/front', host: '10.8.0.5', allowed: ['127.0.0.1'],
    })).rejects.toThrow(/forbidden_source_database/);
    await expect(resolveSourceConnection({
      ...base, url: 'postgres://u@alias-for-shared:5432/front', host: 'alias-for-shared', allowed: ['127.0.0.1'],
    })).rejects.toThrow(/forbidden_source_database/);
    expect(() => assertSafeUrl('postgres://u@h/%256Cegacy_appointment_db', 'source')).toThrow('forbidden_source_database');
    for (const url of [
      'postgres:///copy_db',
      'postgres://frontclaw@localhost/copy_db?host=/tmp',
      'postgres://frontclaw@%2Fvar%2Frun%2Fpostgresql/copy_db',
    ]) {
      expect(isUnixSocketUrl(url), url).toBe(true);
      await expect(resolveSourceConnection({ ...base, url }), url).rejects.toThrow(/unix_socket_forbidden_source/);
    }
  });

  it('CLI 源库缺主机或白名单时不发起连接', async () => {
    const open = async () => { throw Error('should_not_connect'); };
    const missing = await runCli(['import'], {
      [TARGET_ENV]: 'postgres://u@t/a',
      [SOURCE_ENV]: 'postgres://frontclaw@ignored/copy_db',
    }, { open, lookup });
    expect(missing.code).toBe(1);
    expect(String((missing.report as { error?: string }).error)).toMatch(/missing_source_host|empty_allowlist/);
    const blocked = await runCli(['import'], {
      [TARGET_ENV]: 'postgres://u@t/a',
      [SOURCE_ENV]: 'postgres://frontclaw@ignored/copy_db',
      [SOURCE_HOST_ENV]: 'evil.example',
      [SOURCE_PORT_ENV]: '5432',
      [ALLOWED_ENV]: '127.0.0.1',
    }, { open, lookup });
    expect(blocked.code).toBe(1);
    expect(String((blocked.report as { error?: string }).error)).toMatch(/forbidden_source_database/);
  });
});
