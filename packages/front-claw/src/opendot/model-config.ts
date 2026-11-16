import { stubIntentClassifier, type IntentClassifier } from '../role-eval/intent-classifier.js';

/**
 * R1（M02）OpenDot 模型配置适配点。
 * 由宿主注入 OpenDot 已配置模型的 complete()；本模块不读取环境变量/凭据、不自行发起网络请求。
 * 未配置 → 确定性桩（不调用模型）。模型输出必须是单个 JSON 对象，字段由 classifyWithSemantic 严格校验。
 */
export interface OpenDotModelConfig {
  provider: string;
  model: string;
  complete: (request: { system: string; user: string; signal: AbortSignal }) => Promise<string>;
}

export const INTENT_SYSTEM_PROMPT = [
  '你是门店助手的意图分类器。只输出一个 JSON 对象，不要输出其他文字。',
  '字段：route ∈ act|clarify|marketing|chitchat；route=act 时 intent ∈ report|followup|progress|result|appointment|summary|correction|target；',
  'confidence ∈ [0,1]；fields 可选，键为英文、值为字符串或数字。信息不全或拿不准时 route=clarify。',
].join('\n');

export function intentClassifierFromOpenDotModel(config: OpenDotModelConfig | undefined): IntentClassifier {
  if (!config || typeof config.complete !== 'function') return stubIntentClassifier;
  return async ({ text, signal }) => {
    const raw = await config.complete({ system: INTENT_SYSTEM_PROMPT, user: text.slice(0, 2000), signal });
    if (typeof raw !== 'string' || raw.length > 4000) return undefined;
    const trimmed = raw.trim();
    if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return undefined;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined;
    } catch { return undefined; }
  };
}
