import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const read = (file: string) => readFileSync(file, 'utf8');

describe('deployment contract', () => {
  it('checks both Compose documents together for PG version, private core and production isolation', async () => {
    const { validateComposePair } = await import('../../scripts/deploy/validate-compose.mjs');
    const production = JSON.parse(read('deploy/compose.json'));
    const offline = JSON.parse(read('deploy/compose.e2e.json'));
    expect(validateComposePair(production, offline)).toEqual([]);
    offline.services.pg.image = 'postgres:18.1-bookworm';
    offline.services.core.ports = ['8080:8080'];
    production.services.core.environment.AUDIT_PG_ALLOW = 'isolated-synthetic';
    expect(validateComposePair(production, offline)).toEqual(expect.arrayContaining([
      'pg_major_mismatch', 'private_service_ports', 'synthetic_switch',
    ]));
  });
  it('validates the actual Compose document and rejects public database ports', async () => {
    const { validateCompose } = await import('../../scripts/deploy/validate-compose.mjs');
    const compose = JSON.parse(read('deploy/compose.json'));
    expect(validateCompose(compose)).toEqual([]);
    compose.services.pg.ports = ['5432:5432'];
    expect(validateCompose(compose)).toContain('private_service_ports');
  });
  it('rejects a second consumer, floating images and an offline production default', async () => {
    const { validateCompose } = await import('../../scripts/deploy/validate-compose.mjs');
    const compose = JSON.parse(read('deploy/compose.json'));
    compose.services.core.deploy.replicas = 2;
    compose.services.core.environment.FRONT_DOT_CHANNEL = 'offline';
    compose.services.pg.image = 'postgres:latest';
    expect(validateCompose(compose)).toEqual(expect.arrayContaining(['single_consumer', 'production_channel', 'pg17']));
  });
  it('lists credential names and purposes without assignments', () => {
    const text = read('docs/deploy/credentials.md');
    expect(text).toContain('权限 600');
    expect(text).toContain('APP_DATABASE_URL');
    expect(text).not.toMatch(/(?:PASSWORD|SECRET|TOKEN|DATABASE_URL)\s*=/);
    for (const row of text.split('\n').filter(line => line.startsWith('| `'))) {
      expect(row).toMatch(/^\| `[A-Z][A-Z0-9_]+` \| [^|]+ \|$/);
    }
  });
  it('documents independent rollback for all seven layers', () => {
    const text = read('docs/deploy/rollback.md');
    for (const layer of ['主机', 'PG', 'OpenDot 核心', '主站', 'CRM / 只读登录', '企微长连接', '真模型']) {
      expect(text).toContain(`## ${layer}`);
    }
  });
  it('generates configurable SSH rules before enabling the firewall', async () => {
    const cidrs = ['192.0.2.0/24', '2001:db8::/64'];
    const result = await exec('bash', ['scripts/deploy/firewall.sh'], { env: { PATH: process.env.PATH, SSH_ALLOW_CIDRS: cidrs.join(', ') } });
    expect(result.stdout).toContain('dry-run');
    expect(result.stdout).toContain('default deny incoming');
    expect(result.stdout).toContain('default allow outgoing');
    for (const cidr of cidrs) {
      const rule = `allow from ${cidr} to any port 22 proto tcp`;
      expect(result.stdout).toContain(rule);
      expect(result.stdout.indexOf(rule)).toBeLessThan(result.stdout.indexOf('ufw --force enable'));
    }
    expect(result.stdout).toContain('cloud security group: manual');
    expect(result.stdout).not.toMatch(/allow (?:[0-9]+)\/tcp/);
  });
  it.each(['0.0.0.0/0', '::/0', '192.0.2.0/00', '2001:db8::/000', '', 'bad', '192.0.2.0/33', '::/129'])('rejects invalid or unrestricted SSH sources: %s', async source => {
    await expect(exec('bash', ['scripts/deploy/firewall.sh'], { env: { PATH: process.env.PATH, SSH_ALLOW_CIDRS: source } })).rejects.toMatchObject({ code: 2 });
  });
  it('previews the documented default SSH networks', async () => {
    const result = await exec('bash', ['scripts/deploy/firewall.sh'], { env: { PATH: process.env.PATH } });
    expect(result.stdout.match(/to any port 22 proto tcp/g)).toHaveLength(5);
  });
  it.each(['does-not-exist', 'tests/deploy/fixtures/no-previous', 'tests/deploy/fixtures/invalid-state'])('reports unusable rollback state without a stack: %s', async directory => {
    await expect(exec('bash', ['scripts/deploy/rollback.sh'], { env: { PATH: process.env.PATH, DEPLOY_DIR: directory } })).rejects.toMatchObject({ code: 2, stderr: expect.stringMatching(/rollback state unavailable/) });
    try { await exec('bash', ['scripts/deploy/rollback.sh'], { env: { PATH: process.env.PATH, DEPLOY_DIR: directory } }); }
    catch (error) { expect((error as { stderr: string }).stderr).not.toMatch(/at |Error:|node:|ENOENT/); }
  });
  it('rejects unknown arguments', async () => {
    await expect(exec('bash', ['scripts/deploy/host.sh', '--unknown'])).rejects.toMatchObject({ code: 2 });
  });
  it('previews rollback to the saved previous sha without changing the state file', async () => {
    const file = 'tests/deploy/fixtures/state.json';
    const before = read(file);
    const result = await exec('bash', ['scripts/deploy/rollback.sh'], {
      env: { PATH: process.env.PATH, DEPLOY_DIR: 'tests/deploy/fixtures' },
    });
    expect(result.stdout).toContain('dry-run');
    expect(result.stdout).toContain('front-dot:' + 'b'.repeat(40));
    expect(read(file)).toBe(before);
  });
  it('previews stop, consumer absence check and start in order for deployment and rollback', async () => {
    for (const script of ['deploy', 'rollback']) {
      const result = await exec('bash', [`scripts/deploy/${script}.sh`, ...(script === 'deploy' ? ['--allow-dirty', '--allow-non-main'] : [])], {
        env: { PATH: process.env.PATH, DEPLOY_DIR: 'tests/deploy/fixtures' },
      });
      const stop = result.stdout.indexOf('stop old');
      const check = result.stdout.indexOf('confirm no consumer');
      const start = result.stdout.indexOf('start new');
      expect(stop).toBeGreaterThan(-1);
      expect(check).toBeGreaterThan(stop);
      expect(start).toBeGreaterThan(check);
    }
    const common = read('scripts/deploy/common.sh');
    expect(common).toContain('compose stop core');
    expect(common).toContain('verify-consumer');
  });
  it('packages runtime policy files, pins all images and requires reviewed upgrades', () => {
    expect(read('deploy/Dockerfile')).toContain('COPY config ./config');
    const bases = read('deploy/Dockerfile').split('\n').filter(line => line.startsWith('FROM '));
    for (const base of bases) expect(base).toMatch(/^FROM node:\d+\.\d+\.\d+-/);
    expect(read('.dockerignore')).toContain('!config/');
    expect(read('docs/deploy/README.md')).toContain('升级必须走 PR，CI 绿才能合');
    expect(read('docs/deploy/README.md')).toContain('需仓库所有者手动操作');
    expect(read('.github/workflows/ci.yml')).toMatch(/npx vitest run tests\/e2e(?:\s|\/entry-boundary\.test\.ts)/);
  });
  it('previews backup and restore without invoking host tools', async () => {
    for (const script of ['backup', 'restore']) {
      const result = await exec('bash', [`scripts/deploy/${script}.sh`]);
      expect(result.stdout).toContain('dry-run');
    }
  });
  it('refuses tagging a dirty tree and supports an explicit preview override', async () => {
    await expect(exec('bash', ['scripts/deploy/deploy.sh'])).rejects.toThrow();
    const result = await exec('bash', ['scripts/deploy/deploy.sh', '--allow-dirty', '--allow-non-main']);
    expect(result.stdout).toMatch(/front-dot:[a-f0-9]{40}/);
    expect(result.stdout).toContain('dry-run');
  });
  it('rejects non-main and dirty image tags unless each exception is explicit', async () => {
    const { assertImageVersion } = await import('../../scripts/deploy/image-version.mjs');
    const sha = 'a'.repeat(40);
    expect(() => assertImageVersion({ sha, branch: 'topic', dirty: false })).toThrow('MAIN_REQUIRED');
    expect(() => assertImageVersion({ sha, branch: 'main', dirty: true })).toThrow('CLEAN_TREE_REQUIRED');
    expect(() => assertImageVersion({ sha: 'latest', branch: 'main', dirty: false })).toThrow('INVALID_SHA');
    expect(assertImageVersion({ sha, branch: 'topic', dirty: true }, { allowNonMain: true, allowDirty: true })).toBe(sha);
  });
});

it('keeps production and synthetic Compose services separate without public ports', () => {
  const production = JSON.parse(read('deploy/compose.json'));
  const offline = JSON.parse(read('deploy/compose.e2e.json'));
  expect(production.services.core.environment.FRONT_DOT_CHANNEL).toBe('wecom');
  expect(production.services.core.environment).not.toHaveProperty('AUDIT_PG_ALLOW');
  expect(production.services.core.env_file).toContain('${CORE_ENV_FILE:?required}');
  expect(production.services).toHaveProperty('admin');
  expect(production.services).not.toHaveProperty('driver');
  expect(offline.services.core.environment.AUDIT_PG_ALLOW).toBe('isolated-synthetic');
  expect(offline.services.core.environment.FRONT_DOT_CHANNEL).toBe('offline');
  expect(offline.services.core.env_file).toBeUndefined();
  expect(production.services.pg.networks).toEqual(['private']);
  expect(production.services.core.networks).toContain('outbound');
  for (const document of [production, offline]) {
    expect(document.services).not.toHaveProperty('proxy');
    expect(document.networks).not.toHaveProperty('edge');
    for (const service of Object.values(document.services) as { ports?: string[] }[]) expect(service.ports?.length ?? 0).toBe(0);
  }
});
it('previews migration and account provisioning before replacing the consumer', async () => {
  const { stdout } = await exec('bash', ['scripts/deploy/deploy.sh', '--allow-dirty', '--allow-non-main']);
  const actions = ['static check', 'build image', 'start PG', 'migrate schema and provision accounts', 'stop old', 'confirm no consumer', 'start new', 'health check', 'save current and previous sha'];
  for (let index = 1; index < actions.length; index++) expect(stdout.indexOf(actions[index]!)).toBeGreaterThan(stdout.indexOf(actions[index - 1]!));
  expect(read('scripts/deploy/deploy.sh')).toContain('admin migrate');
  expect(read('scripts/deploy/deploy.sh')).not.toContain('driver initialize');
  expect(read('scripts/deploy/common.sh')).toContain('DEPLOY_DIR=${DEPLOY_DIR:-/opt/front-dot}');
});
it.each([['29.9.3', 'v5.7.1', 0], ['30.0.0', 'v6.0.0', 0], ['28.9.9', 'v5.7.1', 2], ['29.9.3', 'v4.9.9', 2], ['', '', 2]])('only checks installed host versions (%s, %s)', async (engine, compose, code) => {
  const operation = exec('bash', ['scripts/deploy/host.sh', '--apply'], { env: { PATH: `${process.cwd()}/tests/deploy/fixtures/bin:${process.env.PATH}`, TEST_DOCKER_VERSION: String(engine), TEST_COMPOSE_VERSION: String(compose) } });
  if (code) await expect(operation).rejects.toMatchObject({ code });
  else expect((await operation).stdout).toContain('host_versions_ok');
  expect(read('scripts/deploy/host.sh')).not.toMatch(/apt-get|sudo|systemctl|EUID|curl/);
});
it('documents the variables consumed by production model and channel configuration', () => {
  const text = read('docs/deploy/credentials.md');
  for (const name of ['FRONT_DOT_CHANNEL', 'FRONT_CLAW_WECOM_BOT_ID', 'FRONT_CLAW_WECOM_BOT_SECRET', 'FC_MODEL_MODE', 'FC_MODEL_TIMEOUT_MS', 'FC_MODEL_ENDPOINT', 'FC_MODEL_CONFIG', 'SSH_ALLOW_CIDRS']) expect(text).toContain('`' + name + '`');
});

it('keeps build exclusions and dirty checks independent of internal test locations', () => {
  expect(read('.dockerignore')).toContain('tests/');
  for (const file of ['scripts/deploy/deploy.sh', 'scripts/e2e/run.mjs', '.dockerignore']) {
    expect(read(file)).not.toMatch(/tests\/r\d+|gate1-lock-ids/);
  }
});
