import { stubModelClassifier, type ModelClassifier } from '../role-eval/model-classify.js';

/** Fixed synthetic fixtures only; every other input uses the inert default stub. No network or credentials. */
export function createSyntheticModel(): ModelClassifier {
  return async input => {
    if (input.text === '合成模型 合法 560元') return { intent: 'report', object: 'performance', action: 'report', slots: { amountText: '560元' }, confidence: 1, uncertain: false };
    if (input.text === '合成模型 坏JSON') return '{invalid';
    if (input.text === '合成模型 空回复') return '';
    if (input.text === '合成模型 超时') return new Promise(resolve => { input.signal.addEventListener('abort', () => resolve(undefined), { once: true }); });
    if (input.text === '合成模型 限流') throw Object.assign(Error('synthetic'), { status: 429 });
    if (input.text === '合成模型 错误') throw Error('synthetic');
    return stubModelClassifier(input);
  };
}
