import { spawn } from 'node:child_process';

/** Child output stays private; records contain only curated assertions. */
export function command(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { env: options.env ?? process.env, cwd: options.cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.resume();
    child.once('error', () => reject(Object.assign(Error('process_start_failed'), { code: 'PROCESS_START' })));
    let forceTimer;
    const timer = setTimeout(() => { child.kill('SIGTERM'); forceTimer = setTimeout(() => child.kill('SIGKILL'), 5000); }, options.timeout ?? 120_000);
    child.once('close', code => {
      clearTimeout(timer);
      clearTimeout(forceTimer);
      if (code !== 0) reject(Object.assign(Error('process_failed'), { code: 'PROCESS_EXIT', exitCode: code, stdout }));
      else resolve(stdout);
    });
    child.stdin.on('error', () => {});
    child.stdin.end(options.input ?? '');
  });
}
