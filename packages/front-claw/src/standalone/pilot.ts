import { createHash } from 'node:crypto';
import { seedIdentity, type IdentitySeed, type SeedDatabase } from './seed.js';
import type { Tier } from '../role-eval/performance-store.js';

type Environment = Readonly<Record<string, string | undefined>>;
export function parsePilotEnvironment(env: Environment): IdentitySeed {
  const value = (key: string, identifier = true) => {
    const text = env[key];
    if (typeof text !== 'string' || text !== text.trim() || !text || text.length > (identifier ? 120 : 80)
      || /[\u0000-\u001f\u007f]/.test(text) || (identifier && (!/^[a-zA-Z0-9_.@:-]+$/.test(text) || ['__proto__', 'constructor', 'prototype'].includes(text)))) throw Error('invalid_pilot_configuration');
    return text;
  };
  const memberId = value('PILOT_MEMBER_ID'), corpId = value('PILOT_CORP_ID');
  const displayName = value('PILOT_DISPLAY_NAME', false), storeId = value('PILOT_STORE_ID'), storeName = value('PILOT_STORE_NAME', false);
  const role = value('PILOT_ROLE');
  const botId = value('FRONT_CLAW_WECOM_BOT_ID');
  if (!['employee', 'manager', 'owner'].includes(role)) throw Error('invalid_pilot_configuration');
  const identity = createHash('sha256').update(JSON.stringify([corpId, memberId])).digest('hex');
  const accountId = `pilot-account-${identity}`;
  return { person: { personId: `pilot-person-${identity}`, accountId, memberId, displayName, storeId, storeName, tier: role as Tier, roles: [], active: true },
    binding: { botId, corpId, memberId, accountId, version: 1, active: true }, actor: 'pilot-admin', at: new Date().toISOString() };
}

/** No model, channel credentials or business records are read or written here. */
export const seedPilot = (db: SeedDatabase, input: IdentitySeed) => seedIdentity(db, input);
