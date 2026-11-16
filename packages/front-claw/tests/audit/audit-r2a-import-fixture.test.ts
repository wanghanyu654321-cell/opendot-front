import { expect, it } from 'vitest';
const g=globalThis as { __auditImportGate?: Promise<void>; __auditImportReached?:()=>void };
if (g.__auditImportGate) { g.__auditImportReached?.(); await g.__auditImportGate; }
else it('AUDIT fixture exports a closable service', async()=>{expect(typeof (await startFrontClawOpenDotService()).close).toBe('function');});
export async function startFrontClawOpenDotService() { return {close:async()=>{}}; }
