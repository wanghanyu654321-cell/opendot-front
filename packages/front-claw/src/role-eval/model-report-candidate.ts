import { sealDraftAmounts, formatYuan } from './amount-guard.js';
import { validateModelChain } from './model-classify.js';
import type { Person } from './performance-store.js';

/** Extraction only: the resulting line still needs the standard draft gate and employee confirmation. */
export function modelReportCandidate(text: string, output: unknown, actor: Person, today: string): string | null {
  const chain = validateModelChain({ text, output });
  if (!chain.ok || chain.classification.intent !== 'report' || chain.classification.action !== 'report' || chain.amountCents === undefined) return null;
  const c = chain.classification;
  if (c.object !== 'performance' || (c.slots.employee && c.slots.employee !== actor.displayName)
    || (c.slots.store && c.slots.store !== actor.storeName) || (c.slots.period && !['今天', today].includes(c.slots.period))) return null;
  if (c.slots.customer && !text.includes(c.slots.customer)) return null;
  try { sealDraftAmounts({ utterance: text, items: [{ amount: chain.amountCents }], context: 'free' }); } catch { return null; }
  return `${c.slots.customer ? c.slots.customer + ' ' : ''}${formatYuan(chain.amountCents)}（${actor.displayName}）`;
}
