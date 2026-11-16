import { expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const read = (file: string) => readFileSync(file, 'utf8');

it('requires writable temporary mounts for read-only runtime and maintenance containers', async () => {
  const { validateComposePair } = await import('../../scripts/deploy/validate-compose.mjs');
  const production = JSON.parse(read('deploy/compose.json')), offline = JSON.parse(read('deploy/compose.e2e.json'));
  for (const service of [production.services.core, production.services.admin, offline.services.core, offline.services.driver]) {
    expect(service.read_only).toBe(true);
    expect(service.tmpfs).toContain('/tmp');
  }
  production.services.admin.tmpfs = [];
  expect(validateComposePair(production, offline)).toContain('writable_temporary_directory');
});

it('isolates management credentials from the core container', async () => {
  const production = JSON.parse(read('deploy/compose.json'));
  expect(production.services.core.env_file).toEqual(['${CORE_ENV_FILE:?required}']);
  expect(production.services.admin.env_file).toEqual(['${ADMIN_ENV_FILE:?required}']);
  expect(JSON.stringify(production.services.core)).not.toMatch(/ADMIN_URL|ADMIN_PASSWORD|DB_PASSWORD|ADMIN_ENV_FILE/);
  const { validateCompose } = await import('../../scripts/deploy/validate-compose.mjs');
  production.services.core.environment.DATABASE_ADMIN_URL = '${DATABASE_ADMIN_URL:?required}';
  expect(validateCompose(production)).toContain('management_credentials_in_core');
});

it('defaults records to an ignored directory and keeps sample records out of the repository', () => {
  expect(read('scripts/e2e/run.mjs')).toContain('`.e2e-records/${timestamp}`');
  expect(read('.gitignore')).toContain('.e2e-records/');
  expect(existsSync('docs/e2e/records/local/steps.json')).toBe(false);
  expect(existsSync('docs/e2e/records/local/summary.json')).toBe(false);
});

it.each(['host', 'deploy', 'rollback', 'backup', 'restore', 'firewall'])('reports Node requirements before doing any work in %s', async script => {
  // Isolate PATH without creating files outside the repository or invoking any host service.
  const code = `function dirname() { printf '%s\\n' scripts/deploy; }; export -f dirname; PATH=/nonexistent; source scripts/deploy/${script}.sh`;
  await expect(exec('/bin/bash', ['-c', code])).rejects.toMatchObject({ code: 2, stderr: expect.stringContaining('需要 Node 22+') });
});

it('rejects an installed Node version below the minimum', async () => {
  const code = "function dirname() { printf '%s\\n' scripts/deploy; }; function node() { printf '%s\\n' v20.0.0; }; export -f dirname node; PATH=/nonexistent; source scripts/deploy/host.sh";
  await expect(exec('/bin/bash', ['-c', code])).rejects.toMatchObject({ code: 2, stderr: expect.stringContaining('需要 Node 22+') });
});

it.each(['0.0.0.0/1,128.0.0.0/1', '192.0.0.0/7', '2000::/7', '::/1,8000::/1', '10.0.0.0/15', '2001:db8::/31'])('rejects overly broad SSH sources: %s', async cidrs => {
  await expect(exec('bash', ['scripts/deploy/firewall.sh'], { env: { PATH: process.env.PATH, SSH_ALLOW_CIDRS: cidrs } })).rejects.toMatchObject({
    code: 2, stderr: expect.stringContaining('IPv4 prefix >= 16 and IPv6 prefix >= 32'),
  });
});

it.each(['10.1.0.0/16', '2001:db8::/32'])('accepts the minimum SSH source prefix: %s', async cidrs => {
  const { stdout } = await exec('bash', ['scripts/deploy/firewall.sh'], { env: { PATH: process.env.PATH, SSH_ALLOW_CIDRS: cidrs } });
  expect(stdout).toContain(`ufw allow from ${cidrs} to any port 22 proto tcp`);
  expect(stdout.indexOf('ufw allow from')).toBeLessThan(stdout.indexOf('ufw --force enable'));
});

it('accepts all five default terminal proxy subnets before enabling the firewall', async () => {
  const { stdout } = await exec('bash', ['scripts/deploy/firewall.sh'], { env: { PATH: process.env.PATH } });
  const sources = stdout.split('\n').filter(line => line.startsWith('ufw allow from '));
  expect(sources).toHaveLength(5);
  for (const source of sources) {
    expect(source).toMatch(/\/24 to any port 22 proto tcp$/);
    expect(stdout.indexOf(source)).toBeLessThan(stdout.indexOf('ufw --force enable'));
  }
});
