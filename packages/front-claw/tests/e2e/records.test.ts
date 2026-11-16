import { expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

vi.mock('node:fs/promises', () => ({ writeFile: vi.fn() }));

const sample = () => ({
  version: 1, notice: '合成数据，不代表线上', backend: 'local',
  steps: [{ step: 'backup', command: 'node scripts/e2e/steps.mjs backup', exitCode: 0, durationMs: 1,
    counts: { tables: { performance_entries: { rows: 1, sha256: 'a'.repeat(64) } }, format: 'custom' } }],
});

it('accepts portable synthetic records and summaries with a notice', async () => {
  const { assertRedactedRecord } = await import('../../scripts/e2e/records.mjs');
  expect(() => assertRedactedRecord(sample())).not.toThrow();
  expect(() => assertRedactedRecord({ version: 1, notice: '合成数据，不代表线上', backend: 'compose', status: 'passed',
    gates: '未复跑（需授权语料）', steps: 15, failures: 0 })).not.toThrow();
});

it.each(['/home/example/log', '/tmp/example/log', '/opt/example/log', '/srv/example/log',
  'C:\\Users\\example\\log', '\\\\example-host\\share\\log', 'postgresql://example:secret@example-host/db',
  '192.0.2.5', 'example-user', 'example-host'])('rejects environment details before records can be serialized: %s', async detail => {
  const { assertRedactedRecord } = await import('../../scripts/e2e/records.mjs');
  const record = sample();
  record.steps[0]!.command += ' ' + detail;
  expect(() => assertRedactedRecord(record, { username: 'example-user', hostname: 'example-host' })).toThrow('RECORD_NOT_REDACTED');
});

it('checks nested values and keys and requires a notice on every file', async () => {
  const { assertRedactedRecord } = await import('../../scripts/e2e/records.mjs');
  for (const counts of [{ diagnostic: '/srv/example/log' }, { '/srv/example/log': 1 }, { diagnostic: 'example-user' }, { diagnostic: 'unrecognized-host' }]) {
    const record = sample();
    Object.assign(record.steps[0]!, { counts });
    expect(() => assertRedactedRecord(record, { username: 'example-user', hostname: 'example-host' })).toThrow('RECORD_NOT_REDACTED');
  }
  expect(() => assertRedactedRecord({ ...sample(), notice: undefined })).toThrow('RECORD_NOT_REDACTED');
});

it('routes every driver record write through the redaction assertion', () => {
  const driver = readFileSync('scripts/e2e/run.mjs', 'utf8');
  expect(driver).not.toMatch(/\bwriteFile\s*\(/);
  expect(driver.match(/writeRecord\(path\.join\(out,/g)).toHaveLength(2);
});

it('refuses an unsafe record before filesystem access and writes only validated JSON', async () => {
  const { writeRecord } = await import('../../scripts/e2e/records.mjs');
  vi.mocked(writeFile).mockClear();
  const unsafe = sample();
  unsafe.steps[0]!.command += ' /srv/example/log';
  await expect(writeRecord('steps.json', unsafe)).rejects.toThrow('RECORD_NOT_REDACTED');
  expect(writeFile).not.toHaveBeenCalled();
  const safe = sample();
  await writeRecord('steps.json', safe);
  expect(writeFile).toHaveBeenCalledExactlyOnceWith('steps.json', JSON.stringify(safe, null, 2) + '\n', { mode: 0o600 });
});

it('isolates integration output in a system temporary directory and cleans it even on failure', () => {
  const test = readFileSync('tests/e2e/local.integration.test.ts', 'utf8');
  expect(test).toContain('mkdtemp(path.join(os.tmpdir(),');
  expect(test).toContain("'--out', output");
  expect(test).toMatch(/finally\s*\{\s*await rm\(output, \{ recursive: true, force: true \}\)/);
});

it('refuses explicit output into the documentation record tree before starting any environment', async () => {
  await expect(promisify(execFile)(process.execPath, ['scripts/e2e/run.mjs', '--out', 'docs/e2e/records/local'])).rejects.toMatchObject({ stderr: expect.stringContaining('record_directory_forbidden') });
});
