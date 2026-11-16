import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { realpath } from 'node:fs/promises';
import { afterEach, beforeEach, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({
  directory: '/synthetic/cluster', port: 45000, log: '',
  children: [] as any[], clients: [] as any[],
  spawn: vi.fn(), execFile: vi.fn(), query: vi.fn(), connect: vi.fn(),
  rm: vi.fn(), access: vi.fn(),
}));
vi.mock('node:fs/promises', () => ({
  mkdtemp: vi.fn(async () => fake.directory), realpath: vi.fn(async (p: string) => p),
  open: vi.fn(async () => ({ fd: 42, close: async () => {} })),
  readFile: vi.fn(async () => fake.log), rm: fake.rm, access: fake.access,
}));
vi.mock('node:net', () => ({ createServer: () => {
  const server = new EventEmitter() as any;
  server.listen = (_port: number, _host: string, cb: () => void) => { queueMicrotask(cb); };
  server.address = () => ({ port: ++fake.port });
  server.close = (cb: () => void) => cb();
  return server;
} }));
vi.mock('node:child_process', () => ({ spawn: fake.spawn, execFile: fake.execFile }));
vi.mock('pg', () => ({ Client: class extends EventEmitter {
  constructor(readonly options: unknown) { super(); fake.clients.push(this); }
  connect = fake.connect;
  query = fake.query;
  end = vi.fn(async () => {});
} }));

import { startPgCluster } from './pg-cluster.js';

function child() {
  const c = new EventEmitter() as any;
  c.exitCode = null; c.signalCode = null;
  c.finish = (code: number | null, signal: string | null = null) => {
    c.exitCode = code; c.signalCode = signal; c.emit('exit', code, signal);
  };
  c.kill = vi.fn((signal: string) => { c.finish(null, signal); return true; });
  fake.children.push(c);
  return c;
}

beforeEach(() => {
  vi.resetAllMocks(); fake.children = []; fake.clients = []; fake.log = ''; fake.port = 45000;
  fake.access.mockResolvedValue(undefined); fake.rm.mockResolvedValue(undefined);
  fake.connect.mockResolvedValue(undefined);
  fake.query.mockResolvedValue({ rows: [{ data_directory: fake.directory }] });
  fake.execFile.mockImplementation((_command, _args, _options, cb) => {
    queueMicrotask(() => cb(null, '', '')); return { kill: vi.fn() };
  });
  fake.spawn.mockImplementation(() => child());
});
afterEach(() => { vi.useRealTimers(); });

it('reports early postgres exit and its log without waiting for readiness', async () => {
  fake.log = 'FATAL: invalid configuration';
  fake.spawn.mockImplementation(() => { const c = child(); queueMicrotask(() => c.finish(1)); return c; });
  await assert.rejects(startPgCluster(), /code=1.*signal=null[\s\S]*invalid configuration/);
  assert.equal(fake.children.length, 1);
  assert.equal(fake.rm.mock.calls.length, 1);
});

it('reports the signal when postgres exits before readiness', async () => {
  fake.spawn.mockImplementation(() => { const c = child(); queueMicrotask(() => c.finish(null, 'SIGSEGV')); return c; });
  await assert.rejects(startPgCluster(), /code=null.*signal=SIGSEGV/);
});

it('includes initdb stdout and stderr and cleans up on failure', async () => {
  fake.execFile.mockImplementation((_command, _args, _options, cb) => {
    queueMicrotask(() => cb(Object.assign(Error('initdb failed'), { code: 1 }), 'init stdout', 'init stderr'));
  });
  await assert.rejects(startPgCluster(), /init stdout[\s\S]*init stderr/);
  assert.equal(fake.children.length, 0);
  assert.equal(fake.rm.mock.calls.length, 1);
});

it('retries a bind failure on a new port and forces only the first port', async () => {
  fake.spawn.mockImplementation(() => {
    const c = child();
    if (fake.children.length === 1) { fake.log = 'could not bind IPv4 address: Address already in use'; queueMicrotask(() => c.finish(1)); }
    else fake.log = '';
    return c;
  });
  const cluster = await startPgCluster({ firstPort: 54321 });
  const ports = fake.spawn.mock.calls.map(([, args]) => args[args.indexOf('-p') + 1]);
  assert.deepEqual(ports, ['54321', '45001']);
  assert.equal(cluster.base, 'postgres://frontclaw@127.0.0.1:45001');
  assert.equal(cluster.url, `${cluster.base}/postgres`);
  await cluster.stop();
});

it('rejects a foreign data directory and retries without accepting that server', async () => {
  fake.query.mockResolvedValueOnce({ rows: [{ data_directory: '/another/cluster' }] });
  const cluster = await startPgCluster({ firstPort: 54321 });
  assert.equal(fake.children.length, 2);
  assert.deepEqual(fake.children[0].kill.mock.calls, [['SIGTERM']]);
  assert.equal(new URL(cluster.base).port, '45001');
  await cluster.stop();
});

it('stops retrying port conflicts after three attempts', async () => {
  fake.log = 'could not bind IPv4 address: Address already in use';
  fake.spawn.mockImplementation(() => { const c = child(); queueMicrotask(() => c.finish(1)); return c; });
  await assert.rejects(startPgCluster({ firstPort: 54321 }), /attempt 3[\s\S]*code=1[\s\S]*Address already in use/);
  assert.equal(fake.children.length, 3);
});

it('retries 57P03 and releases every readiness client', async () => {
  fake.query.mockRejectedValueOnce(Object.assign(Error('starting up'), { code: '57P03' }));
  const cluster = await startPgCluster();
  assert.equal(fake.query.mock.calls.length, 2);
  assert.ok(fake.clients.every(c => c.end.mock.calls.length === 1));
  await cluster.stop();
});

it('uses PATH pg_isready when the configured binary is absent', async () => {
  fake.access.mockRejectedValueOnce(Object.assign(Error('missing'), { code: 'ENOENT' }));
  const cluster = await startPgCluster();
  assert.equal(fake.execFile.mock.calls[1]![0], 'pg_isready');
  const args = fake.execFile.mock.calls[1]![1];
  assert.deepEqual(args.slice(0, 4), ['-h', '127.0.0.1', '-p', '45001']);
  await cluster.stop();
});

it('does not wait for an already exited child and stop is idempotent', async () => {
  const cluster = await startPgCluster();
  fake.children[0].finish(0);
  await Promise.all([cluster.stop(), cluster.stop()]);
  assert.equal(fake.children[0].kill.mock.calls.length, 0);
  assert.equal(fake.rm.mock.calls.length, 1);
});

it('allows smart shutdown to finish without escalating', async () => {
  const cluster = await startPgCluster();
  vi.useFakeTimers();
  fake.children[0].kill.mockImplementation((signal: string) => {
    setTimeout(() => fake.children[0].finish(0), 500); return signal === 'SIGTERM';
  });
  const stopped = cluster.stop();
  await vi.advanceTimersByTimeAsync(500);
  await stopped;
  assert.deepEqual(fake.children[0].kill.mock.calls, [['SIGTERM']]);
});

it('escalates smart to fast to kill within the shutdown budget', async () => {
  const cluster = await startPgCluster();
  vi.useFakeTimers();
  fake.children[0].kill.mockImplementation((signal: string) => {
    if (signal === 'SIGKILL') fake.children[0].finish(null, signal);
    return true;
  });
  const stopped = cluster.stop();
  await vi.advanceTimersByTimeAsync(20_000);
  await stopped;
  assert.deepEqual(fake.children[0].kill.mock.calls, [['SIGTERM'], ['SIGINT'], ['SIGKILL']]);
});

it('bounds a stuck readiness connection to sixty seconds and closes it', async () => {
  vi.useFakeTimers();
  fake.connect.mockImplementation(() => new Promise(() => {}));
  const rejected = assert.rejects(startPgCluster(), /postgres_not_ready.*60000/);
  await vi.advanceTimersByTimeAsync(60_000);
  await rejected;
  assert.equal(fake.children.length, 1);
  assert.equal(fake.clients[0].end.mock.calls.length, 1);
});

it('rejects an exit during readiness client cleanup instead of returning a dead cluster', async () => {
  fake.query.mockImplementation(async () => {
    fake.clients[0].end.mockImplementation(async () => fake.children[0].finish(1));
    return { rows: [{ data_directory: fake.directory }] };
  });
  await assert.rejects(startPgCluster(), /code=1/);
});

it('retries pg_isready rejection before creating a SQL client', async () => {
  fake.execFile.mockImplementationOnce((_command, _args, _options, cb) => {
    queueMicrotask(() => cb(null, '', ''));
  }).mockImplementationOnce((_command, _args, _options, cb) => {
    queueMicrotask(() => cb(Object.assign(Error('rejecting connections'), { code: 1 }), '', ''));
  });
  const cluster = await startPgCluster();
  assert.equal(fake.execFile.mock.calls.length, 3);
  assert.equal(fake.clients.length, 1);
  await cluster.stop();
});

it('does not leave a stuck identity query outside the readiness deadline', async () => {
  vi.useFakeTimers();
  fake.query.mockImplementation(() => new Promise(() => {}));
  const rejected = assert.rejects(startPgCluster(), /postgres_not_ready.*60000/);
  await vi.advanceTimersByTimeAsync(60_000);
  await rejected;
  assert.equal(fake.clients[0].end.mock.calls.length, 1);
});

it('handles a spawn error without waiting for an exit event that will never arrive', async () => {
  fake.spawn.mockImplementation(() => {
    const c = child(); queueMicrotask(() => c.emit('error', Error('spawn ENOENT'))); return c;
  });
  await assert.rejects(startPgCluster(), /spawn ENOENT/);
  assert.equal(fake.children[0].kill.mock.calls.length, 0);
});

it('finishes after fast shutdown without sending SIGKILL', async () => {
  const cluster = await startPgCluster();
  vi.useFakeTimers();
  fake.children[0].kill.mockImplementation((signal: string) => {
    if (signal === 'SIGINT') fake.children[0].finish(null, signal);
    return true;
  });
  const stopped = cluster.stop();
  await vi.advanceTimersByTimeAsync(10_000);
  await stopped;
  assert.deepEqual(fake.children[0].kill.mock.calls, [['SIGTERM'], ['SIGINT']]);
});

it('retries a foreign cluster even when its data directory cannot be read locally', async () => {
  fake.query.mockResolvedValueOnce({ rows: [{ data_directory: '/private/foreign-cluster' }] });
  vi.mocked(realpath).mockImplementation(async path => {
    if (path === '/private/foreign-cluster') throw Object.assign(Error('permission denied'), { code: 'EACCES' });
    return String(path);
  });
  const cluster = await startPgCluster();
  assert.equal(fake.children.length, 2);
  await cluster.stop();
});
