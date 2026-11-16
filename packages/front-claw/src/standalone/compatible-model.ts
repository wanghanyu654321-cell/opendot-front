import { createModelClassifier, loadModelRuntimeConfig, MODEL_ACTIONS, MODEL_INTENTS, MODEL_OBJECTS, stubModelClassifier, type ModelClassifier } from '../role-eval/model-classify.js';

/** Captured at assembly. Only classification JSON is returned; the model receives no tools or stores. */
export function standaloneModelClassifier(env: Readonly<Record<string, string | undefined>>, request: typeof fetch = fetch): ModelClassifier {
  const config = loadModelRuntimeConfig(null, env);
  if (config.mode !== 'live') return stubModelClassifier;
  const base = env.FC_MODEL_BASE_URL?.trim();
  if (!base) return createModelClassifier(config, env);
  const key = env.FC_MODEL_API_KEY?.trim(), model = env.FC_MODEL_NAME?.trim();
  let endpoint: URL;
  try {
    endpoint = new URL(base.replace(/\/+$/, '') + '/chat/completions');
    if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || !key || !model) throw Error();
  } catch { throw Error('invalid_model_configuration'); }
  const schema = { intent: MODEL_INTENTS, object: MODEL_OBJECTS, action: MODEL_ACTIONS,
    slots: { amountText: 'original amount text only', customer: 'string', employee: 'string', index: 'integer', period: 'string', store: 'string' }, confidence: 'number 0..1', uncertain: 'boolean' };
  const system = 'Classify this employee message. Return one JSON object with only these fields and enum values: ' + JSON.stringify(schema)
    + '. Optional object and action may be null; slots may be empty. Do not invent amounts or missing facts. When uncertain use intent unknown, confidence 0, uncertain true. Never execute actions.';
  const url = endpoint.href;
  return async ({ text, signal }) => {
    const response = await request(url, { method: 'POST', signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, messages: [{ role: 'system', content: system }, { role: 'user', content: text }], response_format: { type: 'json_object' }, temperature: 0 }) });
    if (!response.ok) throw Object.assign(Error('model_http_failure'), { status: response.status });
    const body = await response.json() as { choices?: { message?: { content?: unknown } }[] };
    const content = body?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') return undefined;
    try { return JSON.parse(content); } catch { return content; }
    // Strict schema and amount checks, timeout and cancellation remain in the existing classifier chain.
  };
}
