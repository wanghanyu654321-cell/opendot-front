import type { FrontClawChannel, InboundText } from '../opendot/wecom-channel.js';

/** This entry point only accepts a disposable, isolated database. */
export function standaloneOptions(env: Readonly<Record<string, string | undefined>>) {
  if (env.FRONT_DOT_CHANNEL !== 'offline' || env.AUDIT_PG_ALLOW !== 'isolated-synthetic') throw Error('offline_approval_required');
  const databaseUrl = env.FRONT_CLAW_DATABASE_URL ?? '';
  const url = new URL(databaseUrl);
  if (!['localhost', '127.0.0.1', '::1', '[::1]', 'pg'].includes(url.hostname) || !['postgres:', 'postgresql:'].includes(url.protocol)) throw Error('isolated_database_required');
  return Object.freeze({ channel: 'offline' as const, databaseUrl });
}

export function createOfflineChannel(): FrontClawChannel & { inject(event: InboundText): void; replies: string[]; repliesFor(messageId: string): string[] } {
  let receive: ((event: InboundText) => void) | undefined;
  let closed = false;
  const replies: string[] = [];
  const replyRecords: { messageId: string; text: string }[] = [];
  return {
    replies,
    repliesFor: messageId => replyRecords.filter(record => record.messageId === messageId).map(record => record.text),
    open(callback) { if (receive || closed) throw Error('channel_closed'); receive = callback; },
    ready: () => !!receive && !closed,
    rejected: () => 0,
    inject(event) {
      if (!receive || closed) throw Error('channel_closed');
      receive(Object.freeze(structuredClone(event)));
    },
    async reply(event, text, scope) {
      if (closed || scope.signal?.aborted || performance.now() >= scope.deadline) return 'blocked';
      replies.push(text);
      replyRecords.push({ messageId: event.messageId, text });
      return 'accepted';
    },
    // Offline messages never become external delivery, even when the dispatcher calls this port.
    async notify() { return { state: 'blocked', apiErrorCode: null, msgid: null, detail: 'offline_only' }; },
    async close() { closed = true; receive = undefined; },
  };
}
