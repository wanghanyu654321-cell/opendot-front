import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdtemp, open, readFile, realpath, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from 'pg';

// 60s initdb + up to 3 × (60s readiness + client cleanup + 20s shutdown), with headroom.
export const PG_START_HOOK_TIMEOUT_MS = 360_000;
export const PG_STOP_HOOK_TIMEOUT_MS = 60_000;
const INITDB_TIMEOUT_MS = 60_000;
const READY_TIMEOUT_MS = 60_000;
const SHUTDOWN_STEPS = [['SIGTERM', 10_000], ['SIGINT', 5_000], ['SIGKILL', 5_000]] as const;

export interface PgCluster {
  base: string;
  url: string;
  stop(): Promise<void>;
}
export interface PgClusterOptions {
  /** External self-checks only: force this port on attempt 1; retries choose fresh ports. */
  firstPort?: number;
}

async function listenPort(excluded: Set<number>): Promise<number> {
  for (;;) {
    const port = await new Promise<number>((resolve, reject) => {
      const server = createServer();
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        const port = address && typeof address === 'object' ? address.port : 0;
        server.close(error => error ? reject(error) : resolve(port));
      });
    });
    if (port && !excluded.has(port)) return port;
  }
}

function command(file: string, args: string[], timeout: number): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { encoding: 'utf8', timeout, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (!error) resolve();
      else reject(new Error(`${file}: ${error.message}; code=${error.code ?? null}; signal=${error.signal ?? null}\n${stdout}\n${stderr}`, { cause: error }));
    });
  });
}

class PostgresExited extends Error {}
class PortConflict extends Error {}

// Subscribe immediately after spawn and retain the result: exit may precede stop().
function watchProcess(child: ChildProcess) {
  let exit: Error | undefined;
  const done = new Promise<Error>(resolve => {
    child.once('error', error => {
      exit = new PostgresExited(`postgres spawn failed: ${error.message}; code=${child.exitCode}; signal=${child.signalCode}`, { cause: error });
      resolve(exit);
    });
    child.once('exit', (code, signal) => {
      exit = new PostgresExited(`postgres exited: code=${code}; signal=${signal}`);
      resolve(exit);
    });
  });
  return { child, done, get exited() { return exit; } };
}
type Watched = ReturnType<typeof watchProcess>;

async function waitForExit(watched: Watched, ms: number): Promise<boolean> {
  if (watched.exited || watched.child.exitCode !== null || watched.child.signalCode !== null) return true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      watched.done.then(() => true),
      new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), ms); }),
    ]);
  } finally { clearTimeout(timer); }
}

async function stopProcess(watched: Watched): Promise<void> {
  for (const [signal, ms] of SHUTDOWN_STEPS) {
    if (watched.exited || watched.child.exitCode !== null || watched.child.signalCode !== null) return;
    watched.child.kill(signal);
    if (await waitForExit(watched, ms)) return;
  }
  throw new Error('postgres did not exit after SIGTERM/SIGINT/SIGKILL (20000ms)');
}

async function guarded<T>(operation: Promise<T>, ms: number, watched?: Watched): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`postgres_not_ready after ${READY_TIMEOUT_MS}ms`)), Math.max(0, ms)); }),
      ...(watched ? [watched.done.then(error => { throw error; })] : []),
    ]);
  } finally { clearTimeout(timer); }
}

async function waitUntilReady(watched: Watched, readyBin: string, base: string, directory: string): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  for (;;) {
    if (watched.exited) throw watched.exited;
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`postgres_not_ready after ${READY_TIMEOUT_MS}ms`);
    try {
      await guarded(command(readyBin, ['-h', '127.0.0.1', '-p', new URL(base).port, '-U', 'frontclaw', '-d', 'postgres', '-t', '1'], Math.min(2_000, remaining)), remaining, watched);
      if (watched.exited) throw watched.exited;
      const budget = Math.max(1, Math.min(2_000, deadline - Date.now()));
      const client = new Client({ connectionString: `${base}/postgres`, connectionTimeoutMillis: budget, query_timeout: budget });
      // Shutdown/connection failures may also arrive as asynchronous client events.
      client.on('error', () => {});
      try {
        await guarded(client.connect(), deadline - Date.now(), watched);
        const result = await guarded(client.query('SHOW data_directory'), deadline - Date.now(), watched);
        const actual = result.rows[0]?.data_directory as string | undefined;
        // -D already uses our canonical path; inspecting a foreign directory could fail with EACCES.
        if (actual !== directory) {
          throw new PortConflict(`postgres identity mismatch: expected data_directory=${directory}; received=${actual}`);
        }
        if (watched.exited) throw watched.exited;
        return;
      } finally {
        // pg.end() destroys an active query; also bound its response consumption.
        await guarded(client.end(), 1_000).catch(() => undefined);
      }
    } catch (error) {
      if (watched.exited) throw watched.exited;
      if (error instanceof PortConflict || error instanceof PostgresExited) throw error;
      // Includes pg_isready's rejecting/no-response statuses and SQLSTATE 57P03.
      if (Date.now() >= deadline) throw new Error(`postgres_not_ready after ${READY_TIMEOUT_MS}ms`, { cause: error });
      await guarded(new Promise(resolve => setTimeout(resolve, Math.min(200, deadline - Date.now()))), deadline - Date.now(), watched);
    }
  }
}

async function logTail(path: string): Promise<string> {
  return (await readFile(path, 'utf8').catch(() => '(no postgres log available)')).slice(-16_384).split('\n').slice(-40).join('\n');
}

/** Disposable loopback-only, trust-authenticated test cluster; never connects to a configured database URL. */
export async function startPgCluster(options: PgClusterOptions = {}): Promise<PgCluster> {
  const firstPort = options.firstPort;
  if (firstPort !== undefined && (!Number.isInteger(firstPort) || firstPort < 1 || firstPort > 65535)) {
    throw new Error('firstPort must be an integer between 1 and 65535');
  }
  const bin = process.env.FRONT_CLAW_PG_BIN?.trim() || '/usr/lib/postgresql/16/bin';
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'front-claw-pg-')));
  let watched: Watched | undefined;
  let safeToRemove = true;
  try {
    await command(join(bin, 'initdb'), ['-D', directory, '-U', 'frontclaw', '--auth=trust', '--no-sync', '--encoding=UTF8'], INITDB_TIMEOUT_MS);
    const readyBin = await access(join(bin, 'pg_isready'), constants.X_OK).then(() => join(bin, 'pg_isready'), () => 'pg_isready');
    const usedPorts = new Set<number>();
    for (let attempt = 1; attempt <= 3; attempt++) {
      const port = attempt === 1 && firstPort !== undefined ? firstPort : await listenPort(usedPorts);
      usedPorts.add(port);
      const logPath = join(directory, `postgres-${attempt}.log`);
      const log = await open(logPath, 'a');
      try {
        watched = watchProcess(spawn(join(bin, 'postgres'), [
          '-D', directory, '-p', String(port), '-h', '127.0.0.1', '-k', directory, '-c', 'listen_addresses=127.0.0.1',
        ], { stdio: ['ignore', log.fd, log.fd], env: { ...process.env, LC_ALL: 'C' } }));
      } finally { await log.close(); }
      const base = `postgres://frontclaw@127.0.0.1:${port}`;
      try {
        await waitUntilReady(watched, readyBin, base, directory);
        if (watched.exited) throw watched.exited;
        const ownedProcess = watched;
        let stopping: Promise<void> | undefined;
        return { base, url: `${base}/postgres`, stop() {
          return stopping ??= (async () => {
            try { await stopProcess(ownedProcess); }
            catch (error) { throw new Error(`${String(error)}\n${logPath} (tail):\n${await logTail(logPath)}`, { cause: error }); }
            await rm(directory, { recursive: true, force: true });
          })();
        } };
      } catch (error) {
        // Reap our own child before retrying; never signal the server reached by TCP.
        try { await stopProcess(watched); }
        catch (stopError) {
          safeToRemove = false;
          const failure = new Error(`${String(error)}; cleanup: ${String(stopError)}\n${logPath} (tail):\n${await logTail(logPath)}`, { cause: error });
          console.error(failure.message);
          throw failure;
        }
        const tail = await logTail(logPath);
        const failure = new Error(`postgres attempt ${attempt} on port ${port}: ${String(error)}\n${logPath} (tail):\n${tail}`, { cause: error });
        console.error(failure.message);
        const conflict = error instanceof PortConflict || error instanceof PostgresExited && /could not bind|address already in use|could not create any TCP\/IP sockets/i.test(tail);
        if (!conflict || attempt === 3) throw failure;
      }
    }
    throw new Error('postgres attempts exhausted');
  } catch (error) {
    // Covers failures before the readiness loop as well (spawn, log descriptor, initdb).
    if (watched && safeToRemove) {
      try { await stopProcess(watched); }
      catch (stopError) { safeToRemove = false; throw new Error(`${String(error)}; cleanup: ${String(stopError)}`, { cause: error }); }
    }
    throw error;
  } finally {
    // On success the returned stop() owns the directory. A running child must retain it.
    if (safeToRemove && (!watched || watched.exited)) await rm(directory, { recursive: true, force: true });
  }
}
