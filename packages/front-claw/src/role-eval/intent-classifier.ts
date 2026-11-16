import type { SemanticClassifier } from './intent-router.js';

/**
 * R1（M02）兜底意图分类器接口。
 * 规则路由之后、仅在规则不是单一高置信命中时调用；输出四类路由之一 + 抽取字段：
 *   { route: 'act'|'clarify'|'marketing'|'chitchat', intent?: 店务意图, confidence: 0..1, fields?: {...} }
 * 输出只决定路由，不参与写入；写入仍只认规则解析 + 用户确认。
 */
export type IntentRoute = 'act' | 'clarify' | 'marketing' | 'chitchat';
export interface IntentClassifierOutput {
  route: IntentRoute; intent?: string; confidence: number; fields?: Record<string, string | number>;
}
export type IntentClassifier = SemanticClassifier;

const STUB = Symbol.for('front-claw.intent-classifier.deterministic-stub');

/** 默认确定性桩：不调用任何模型，恒返回澄清（confidence 0）。用于未配置模型时的安全默认。 */
export const stubIntentClassifier: IntentClassifier = Object.assign(
  async (_input: { text: string; signal: AbortSignal }): Promise<IntentClassifierOutput> => ({ route: 'clarify', confidence: 0 }),
  { [STUB]: true },
);

/** 是否确定性桩（桩不计为“调用了模型”）。 */
export function isDeterministicStub(classifier: unknown): boolean {
  return typeof classifier === 'function' && (classifier as unknown as Record<symbol, unknown>)[STUB] === true;
}
