import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { command } from './process.mjs';
import { resolvePgTool } from './pg-tools.mjs';
import { notice, writeRecord } from './records.mjs';
import { assertImageVersion } from '../deploy/image-version.mjs';

const flags = process.argv.slice(2);
let backend = 'local', output;
const imageOptions = {};
for (let index = 0; index < flags.length; index++) {
  if (flags[index] === '--backend' && flags[index + 1] && !flags[index + 1].startsWith('--')) backend = flags[++index];
  else if (flags[index] === '--out' && flags[index + 1] && !flags[index + 1].startsWith('--')) output = flags[++index];
  else if (flags[index] === '--allow-dirty') imageOptions.allowDirty = true;
  else if (flags[index] === '--allow-non-main') imageOptions.allowNonMain = true;
  else throw Error('unknown_argument');
}
if (!['local', 'compose'].includes(backend)) throw Error('invalid_backend');
// Capture before creating the record directory, which is itself an untracked output.
let imageState;
if (backend === 'compose') {
  imageState = { sha: (await command('git', ['rev-parse', 'HEAD'])).trim(), branch: (await command('git', ['branch', '--show-current'])).trim(),
    dirty: !!(await command('git', ['status', '--porcelain'])).trim() };
}
const timestamp = new Date().toISOString().replaceAll(/[:.]/g, '-');
const out = path.resolve(output ?? `.e2e-records/${timestamp}`);
const documentationRecords = path.resolve('docs/e2e/records');
if (out === documentationRecords || out.startsWith(documentationRecords + path.sep)) throw Error('record_directory_forbidden');
await mkdir(out, { recursive: true, mode: 0o700 });
const records = [];
const env = { PATH: process.env.PATH, LANG: 'C.UTF-8', AUDIT_PG_ALLOW: 'isolated-synthetic' };
for (const key of ['PG_DUMP', 'PG_RESTORE']) if (process.env[key]) env[key] = process.env[key];
let temp, clusterStarted = false, child, composeStarted = false;
const project = 'synthetic-' + randomBytes(6).toString('hex');
const password = () => randomBytes(24).toString('hex');
env.PG_ADMIN_PASSWORD = password(); env.APP_DB_PASSWORD = password(); env.READONLY_DB_PASSWORD = password();
const compose = (...args) => command('docker', ['compose', '-p', project, '-f', 'deploy/compose.e2e.json', ...args], { env, timeout: 600_000 });
const url = (user, secret, host, port = '') => `postgresql://${user}:${secret}@${host}${port ? ':' + port : ''}/synthetic`;
async function record(name, display, work) {
  const started = Date.now();
  try {
    const counts = await work();
    records.push({ step: name, command: display, exitCode: 0, durationMs: Date.now() - started, counts: counts ?? {} });
  } catch (error) {
    records.push({ step: name, command: display, exitCode: Number.isInteger(error.exitCode) ? error.exitCode : 1,
      durationMs: Date.now() - started, error: /^[A-Z0-9_]+$/.test(error.code ?? '') ? error.code : 'STEP_FAILED',
      ...(error.assertion ? { assertion: error.assertion } : {}) });
    throw error;
  } finally {
    await writeRecord(path.join(out, 'steps.json'), { version: 1, notice, backend, steps: records });
  }
}
async function unusedPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function stopCore() {
  if (backend === 'compose') { await compose('stop', 'core'); return; }
  if (!child) return;
  const current = child; child = undefined;
  if (current.exitCode !== null) { if (current.exitCode !== 0) throw Error('core_exited'); return; }
  const exited = once(current, 'exit');
  current.kill('SIGTERM');
  const timer = setTimeout(() => current.kill('SIGKILL'), 30_000);
  try { const [code] = await exited; if (code !== 0) throw Error('core_shutdown_failed'); } finally { clearTimeout(timer); }
}
async function startCore() {
  if (backend === 'compose') { await compose('up', '-d', '--wait', '--wait-timeout', '90', 'core'); return; }
  child = spawn(process.execPath, ['dist/standalone/main.js'], { env: {
    ...env, FRONT_DOT_CHANNEL: 'offline', FRONT_CLAW_DATABASE_URL: env.APP_DATABASE_URL,
    FRONT_DOT_PORT: env.FRONT_DOT_PORT,
  }, stdio: ['ignore', 'ignore', 'ignore'] });
  let startError = false;
  child.once('error', () => { startError = true; });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (startError || child.exitCode !== null) throw Error('core_start_failed');
    try { if ((await fetch(new URL('/health', env.CORE_URL), { signal: AbortSignal.timeout(1000) })).ok) return; } catch { /* bounded startup polling */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw Error('core_start_timeout');
}
async function step(name) {
  if (backend === 'compose') {
    try { return JSON.parse(await compose('run', '--rm', '--no-deps', '-T', 'driver', name)); }
    catch (error) {
      try {
        const diagnostic = JSON.parse(error.stdout);
        if (/^[A-Z0-9_]{1,48}$/.test(diagnostic.error)) error.code = diagnostic.error;
        if (/^[a-z0-9_]{1,80}$/.test(diagnostic.assertion ?? '')) error.assertion = diagnostic.assertion;
      } catch { /* Never expose arbitrary subprocess diagnostics. */ }
      throw error;
    }
  }
  const { runStep } = await import('./steps.mjs');
  return runStep(name, env);
}
const stepCommand = name => backend === 'local' ? `node scripts/e2e/steps.mjs ${name}`
  : `docker compose -p <project> -f deploy/compose.e2e.json run --rm --no-deps -T driver ${name}`;
const coreCommand = backend === 'local' ? 'node dist/standalone/main.js'
  : 'docker compose -p <project> -f deploy/compose.e2e.json up -d --wait --wait-timeout 90 core';

let failed = false;
try {
  await record('prepare', backend === 'local' ? 'PG_BIN/<tools> initialize temporary PG17 at <tmp>' : 'docker compose -f deploy/compose.e2e.json build core; up pg', async () => {
    if (backend === 'local') {
      env.PG_BIN = process.env.PG_BIN ?? process.env.FRONT_CLAW_PG_BIN;
      if (!env.PG_BIN || !path.isAbsolute(env.PG_BIN)) throw Object.assign(Error('pg_bin_required'), { code: 'PG_BIN_REQUIRED' });
      for (const tool of ['pg_dump', 'pg_restore']) env[tool.toUpperCase()] = await resolvePgTool(env, tool);
      const version = await command(path.join(env.PG_BIN, 'postgres'), ['--version'], { env });
      if (!/\b17\./.test(version)) throw Object.assign(Error('pg17_required'), { code: 'PG17_REQUIRED' });
      temp = await mkdtemp(path.join(os.tmpdir(), 'front-dot-synthetic-'));
      env.E2E_ARTIFACT_DIR = path.join(temp, 'artifacts');
      const port = String(await unusedPort());
      await command(path.join(env.PG_BIN, 'initdb'), ['-D', path.join(temp, 'data'), '-U', 'postgres', '--auth=trust', '--no-locale', '--encoding=UTF8'], { env });
      clusterStarted = true;
      await command(path.join(env.PG_BIN, 'pg_ctl'), ['-D', path.join(temp, 'data'), '-l', path.join(temp, 'pg.log'), '-o', `-h 127.0.0.1 -p ${port} -k '' -c shared_buffers=64MB -c max_connections=30`, '-w', 'start'], { env });
      env.DATABASE_ADMIN_URL = url('postgres', env.PG_ADMIN_PASSWORD, '127.0.0.1', port);
      const { default: pg } = await import('pg');
      const admin = new pg.Client({ connectionString: env.DATABASE_ADMIN_URL.replace(/\/synthetic$/, '/postgres') });
      try { await admin.connect(); await admin.query('CREATE DATABASE synthetic'); } finally { await admin.end(); }
      env.APP_DATABASE_URL = url('front_app', env.APP_DB_PASSWORD, '127.0.0.1', port);
      env.READONLY_DATABASE_URL = url('front_readonly', env.READONLY_DB_PASSWORD, '127.0.0.1', port);
      env.FRONT_DOT_PORT = String(await unusedPort());
      env.CORE_URL = 'http://127.0.0.1:' + env.FRONT_DOT_PORT;
    } else {
      env.FRONT_DOT_SHA = assertImageVersion(imageState, imageOptions);
      env.DATABASE_ADMIN_URL = url('postgres', env.PG_ADMIN_PASSWORD, 'pg');
      env.APP_DATABASE_URL = url('front_app', env.APP_DB_PASSWORD, 'pg');
      env.READONLY_DATABASE_URL = url('front_readonly', env.READONLY_DB_PASSWORD, 'pg');
      // Uncommitted or non-main verification requires explicit flags, as in deployment.
      composeStarted = true;
      await compose('config', '--quiet');
      await compose('build', 'core');
      await compose('up', '-d', '--wait', 'pg');
    }
    return { pgMajor: 17, isolated: true };
  });
  for (const phase of ['initialize', 'permissions']) await record(phase, stepCommand(phase), () => step(phase));
  await record('start-core', coreCommand, startCore);
  await record('model-flow', stepCommand('model-flow'), () => step('model-flow'));
  await record('flow', stepCommand('flow'), () => step('flow'));
  await record('restart-core', `SIGTERM <core>; ${coreCommand}`, async () => { await stopCore(); await startCore(); return { freshProcess: true }; });
  await record('replay', stepCommand('replay'), () => step('replay'));
  await record('quiesce', 'stop core before database snapshot', stopCore);
  for (const phase of ['backup', 'restore']) await record(phase, stepCommand(phase), () => step(phase));
  await record('start-restored-core', coreCommand + ' (restored database)', async () => {
    env.APP_DATABASE_URL = env.APP_DATABASE_URL.replace(/\/synthetic$/, '/synthetic_restored');
    await startCore();
  });
  await record('restored-progress', stepCommand('restored-progress'), () => step('restored-progress'));
  await record('gates', 'authorized operator: scripts/eval-gates.sh --corpus <授权语料> --out <仓库外路径>', async () => ({ state: '未复跑（需授权语料）' }));
} catch (error) {
  failed = true;
  if (/^PG_(DUMP|RESTORE)_NOT_FOUND$/.test(error.code ?? '')) process.stderr.write(error.message + '\n');
}
finally {
  await record('cleanup', backend === 'local' ? 'stop core; pg_ctl stop; remove <tmp>' : 'docker compose down --volumes (disposable project only)', async () => {
    await stopCore();
    if (clusterStarted) {
      let pidFile = false;
      try { await access(path.join(temp, 'data', 'postmaster.pid')); pidFile = true; } catch { /* PG never completed startup. */ }
      if (pidFile) await command(path.join(env.PG_BIN, 'pg_ctl'), ['-D', path.join(temp, 'data'), '-m', 'fast', '-w', 'stop'], { env });
    }
    if (composeStarted) await compose('down', '--volumes', '--remove-orphans');
    if (temp) await rm(temp, { recursive: true, force: true });
  }).catch(() => { failed = true; });
}
await writeRecord(path.join(out, 'summary.json'), { version: 1, notice, backend, status: failed ? 'failed' : 'passed',
  gates: '未复跑（需授权语料）', steps: records.length, failures: records.filter(row => row.exitCode !== 0).length });
process.stdout.write((failed ? 'e2e_failed' : 'e2e_passed') + '\n未复跑（需授权语料）\n');
process.exitCode = failed ? 1 : 0;
