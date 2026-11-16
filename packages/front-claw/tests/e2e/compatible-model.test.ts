import { expect, it, vi } from 'vitest';
import { runModelClassifier, validateModelChain } from '../../src/role-eval/model-classify.js';

const env = () => ({ FC_MODEL_MODE: 'live', FC_MODEL_BASE_URL: 'https://model.invalid/v1', FC_MODEL_API_KEY: 'fake-model-secret', FC_MODEL_NAME: 'fake-model' });
const output = { intent: 'report', object: 'performance', action: 'report', slots: { amountText: '560元' }, confidence: 1, uncertain: false };

it('captures compatible model configuration and sends only classification requests with the caller signal', async () => {
  const { standaloneModelClassifier } = await import('../../src/standalone/compatible-model.js');
  const configuration = env();
  const request = vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
    expect(url).toBe('https://model.invalid/v1/chat/completions');
    expect(options?.headers).toMatchObject({ authorization: 'Bearer fake-model-secret' });
    expect(options?.signal).toBeInstanceOf(AbortSignal);
    const body = JSON.parse(String(options?.body));
    expect(body.model).toBe('fake-model');
    expect(body.messages.at(-1)).toEqual({ role: 'user', content: '请整理 560元' });
    expect(body).not.toHaveProperty('tools');
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(output) } }] }));
  });
  const model = standaloneModelClassifier(configuration, request);
  configuration.FC_MODEL_API_KEY = 'changed'; configuration.FC_MODEL_BASE_URL = 'https://changed.invalid';
  const result = await runModelClassifier('请整理 560元', model, undefined, undefined, 100);
  expect(validateModelChain({ text: '请整理 560元', output: result }).ok).toBe(true);
  expect(request).toHaveBeenCalledOnce();
});

it.each(['invalid', 'empty', 'timeout', 'rate-limit', 'error', 'body-timeout'])('falls back safely for compatible model %s', async kind => {
  const { standaloneModelClassifier } = await import('../../src/standalone/compatible-model.js');
  const diagnostics: string[] = [];
  const request = vi.fn(async (_url: string | URL | Request, options?: RequestInit) => {
    if (kind === 'timeout') return new Promise<Response>(() => {});
    if (kind === 'error') throw Error('fake-model-secret private-message-marker');
    if (kind === 'rate-limit') return new Response('', { status: 429 });
    if (kind === 'body-timeout') return { ok: true, json: () => new Promise(() => {}) } as Response;
    expect(options?.signal).toBeInstanceOf(AbortSignal);
    return new Response(JSON.stringify({ choices: [{ message: { content: kind === 'invalid' ? '{broken' : '' } }] }));
  });
  const result = await runModelClassifier('private-message-marker 560元', standaloneModelClassifier(env(), request), undefined, undefined, 60, d => diagnostics.push(d.errorCategory));
  expect(validateModelChain({ text: 'private-message-marker 560元', output: result }).ok).toBe(false);
  if (kind === 'timeout' || kind === 'body-timeout') expect(diagnostics).toEqual(['timeout']);
  if (kind === 'rate-limit') expect(diagnostics).toEqual(['rate_limit']);
});

it('never reads compatible credentials or invokes fetch in stub mode', async () => {
  const { standaloneModelClassifier } = await import('../../src/standalone/compatible-model.js');
  const request = vi.fn();
  const configuration = new Proxy({ FC_MODEL_MODE: 'stub' }, { get(target, key) {
    if (/API_KEY|BASE_URL|NAME/.test(String(key))) throw Error('unexpected_credential_read');
    return Reflect.get(target, key);
  } });
  await runModelClassifier('synthetic', standaloneModelClassifier(configuration, request));
  expect(request).not.toHaveBeenCalled();
});
