import crypto from 'crypto';

import { describe, expect, it } from 'vitest';

import { extractText, parseMessageEvent, toChannelId, toPlatformId, verifySignature } from './ambiguous.js';

const SECRET = 'whsec_test_secret';
const NOW = 1_750_000_000_000;

function sign(payload: string, timestampSeconds: number, secret = SECRET): string {
  return `sha256=${crypto.createHmac('sha256', secret).update(`${timestampSeconds}.${payload}`).digest('hex')}`;
}

describe('verifySignature', () => {
  const payload = JSON.stringify({ type: 'message.created' });
  const ts = Math.floor(NOW / 1000);

  it('accepts a correctly signed, fresh delivery', () => {
    expect(verifySignature(payload, sign(payload, ts), String(ts), SECRET, NOW)).toEqual({ ok: true });
  });

  it('rejects a signature made with the wrong secret', () => {
    const forged = sign(payload, ts, 'whsec_not_the_secret');
    expect(verifySignature(payload, forged, String(ts), SECRET, NOW).ok).toBe(false);
  });

  it('rejects a tampered payload that keeps a valid-looking signature', () => {
    const signature = sign(payload, ts);
    const tampered = JSON.stringify({ type: 'message.created', injected: true });
    expect(verifySignature(tampered, signature, String(ts), SECRET, NOW).ok).toBe(false);
  });

  it('rejects a replay from outside the freshness window', () => {
    const old = ts - 600;
    const result = verifySignature(payload, sign(payload, old), String(old), SECRET, NOW);
    expect(result).toEqual({ ok: false, reason: 'timestamp outside the accepted window' });
  });

  // timingSafeEqual throws on a length mismatch, so a short header must be
  // length-checked first or a malformed request becomes a 500.
  it('rejects a malformed signature without throwing', () => {
    expect(verifySignature(payload, 'sha256=abc', String(ts), SECRET, NOW).ok).toBe(false);
    expect(verifySignature(payload, undefined, String(ts), SECRET, NOW).ok).toBe(false);
    expect(verifySignature(payload, sign(payload, ts), 'not-a-number', SECRET, NOW).ok).toBe(false);
  });
});

describe('parseMessageEvent', () => {
  const base = {
    id: 'evt_1',
    type: 'message.created',
    timestamp: '2026-09-12T10:00:00Z',
    actor: { id: 'user-ryan', name: 'Ryan', type: 'human' },
    resource: { id: 'msg-1', type: 'message', url: '/api/channels/chan-9/messages/msg-1' },
    data: { channel_id: 'chan-9', content: 'restart the worker please' },
  };

  it('reduces a chat event to the router fields', () => {
    expect(parseMessageEvent(base, 'agent-self')).toEqual({
      channelId: 'chan-9',
      messageId: 'msg-1',
      threadId: null,
      text: 'restart the worker please',
      senderId: 'user-ryan',
      senderName: 'Ryan',
      isMention: false,
      needsFetch: false,
    });
  });

  // A mention delivery names the message but does not carry it. Falling back
  // to `summary` here made the agent relay "X mentioned you" as if it were the
  // user's message; the body must be fetched instead.
  it('flags a body-less mention for fetching rather than using the summary', () => {
    const mention = {
      ...base,
      type: 'mention',
      summary: 'MOHAMMED SUHAIB mentioned you in #general',
      data: { channel_id: 'chan-9' },
    };
    const parsed = parseMessageEvent(mention, 'agent-self');
    expect(parsed?.needsFetch).toBe(true);
    expect(parsed?.text).toBe('');
    expect(parsed?.text).not.toContain('mentioned you');
  });

  // The loop guard: our own sends arrive back as message.created.
  it('drops events this agent authored', () => {
    expect(parseMessageEvent({ ...base, actor: { id: 'agent-self' } }, 'agent-self')).toBeNull();
  });

  it('flags a mention event as a mention', () => {
    expect(parseMessageEvent({ ...base, type: 'mention' }, 'agent-self')?.isMention).toBe(true);
  });

  it('carries thread_id through so replies land in-thread', () => {
    const threaded = { ...base, data: { ...base.data, thread_id: 'msg-parent' } };
    expect(parseMessageEvent(threaded, 'agent-self')?.threadId).toBe('msg-parent');
  });

  it('falls back to the resource url when channel_id is absent', () => {
    const noChannel = { ...base, data: { content: 'hello' } };
    expect(parseMessageEvent(noChannel, 'agent-self')?.channelId).toBe('chan-9');
  });

  it('ignores event types that are not chat messages', () => {
    expect(parseMessageEvent({ ...base, type: 'document.created' }, 'agent-self')).toBeNull();
  });

  it('never substitutes the summary for the message body', () => {
    const noBody = { ...base, summary: 'Ryan posted in #general', data: { channel_id: 'c' } };
    const parsed = parseMessageEvent(noBody, null);
    expect(parsed?.text).toBe('');
    expect(parsed?.needsFetch).toBe(true);
  });
});

describe('platform ids', () => {
  it('round-trips a channel id', () => {
    expect(toChannelId(toPlatformId('chan-9'))).toBe('chan-9');
  });
});

describe('extractText', () => {
  it('reads both outbound shapes and refuses anything else', () => {
    expect(extractText({ kind: 'chat', content: 'plain' })).toBe('plain');
    expect(extractText({ kind: 'chat', content: { text: 'wrapped' } })).toBe('wrapped');
    expect(extractText({ kind: 'chat', content: { other: 1 } })).toBeNull();
  });
});
