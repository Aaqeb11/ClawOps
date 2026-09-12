/**
 * Ambiguous Workspace channel adapter. Self-registers on import.
 *
 * A native adapter rather than a Chat SDK bridge: Ambiguous ships no
 * @chat-adapter package, and its surface is a plain REST API, so the whole
 * transport is two calls out and one webhook in.
 *
 *   outbound  POST /api/channels/{id}/messages   { content, thread_id? }
 *   inbound   POST /webhook/ambiguous            message.created | mention
 *
 * Configuration (.env in the NanoClaw project root):
 *   AMBIGUOUS_API_TOKEN       agent API key, `ak_…` (required)
 *   AMBIGUOUS_WEBHOOK_SECRET  signing secret from webhook registration, `whsec_…`
 *   AMBIGUOUS_BASE_URL        defaults to https://app.ambiguous.ai
 *
 * Register the webhook once, pointing at this host's public URL:
 *
 *   curl -X POST https://app.ambiguous.ai/api/webhooks \
 *     -H "Authorization: Bearer $AMBIGUOUS_API_TOKEN" \
 *     -H "Content-Type: application/json" \
 *     -d '{"url":"https://<host>/webhook/ambiguous",
 *          "events":["message.created","mention"]}'
 *
 * The response carries the signing secret ONCE — that value is
 * AMBIGUOUS_WEBHOOK_SECRET. Ambiguous disables a webhook after 10 consecutive
 * failed deliveries, so a host that is down long enough must re-enable it with
 * `active: true` rather than assume it recovers on its own.
 */
import crypto from 'crypto';
import type http from 'http';

import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import { registerWebhookHandler } from '../webhook-server.js';
import type {
  ChannelAdapter,
  ChannelDefaults,
  ChannelSetup,
  OutboundMessage,
  ResolvedConversation,
} from './adapter.js';
import { registerChannelAdapter } from './channel-registry.js';

const CHANNEL_TYPE = 'ambiguous';
const WEBHOOK_PATH = 'ambiguous';
const DEFAULT_BASE_URL = 'https://app.ambiguous.ai';

/**
 * How far out of date a delivery may be before it is refused. A captured
 * request replayed later must not re-drive the agent, and the signature alone
 * cannot say when it was signed — the timestamp is inside the signed string
 * precisely so this check is meaningful.
 */
const MAX_SIGNATURE_AGE_MS = 5 * 60 * 1000;

/**
 * Ambiguous conversations are channels whose messages carry an optional
 * `thread_id` — the same shape as Slack, so the same declaration: threads are
 * the conversation unit in channels, and a DM collapses to one session.
 */
export const AMBIGUOUS_DEFAULTS: ChannelDefaults = {
  dm: {
    engageMode: 'pattern',
    engagePattern: '.',
    threads: false,
    unknownSenderPolicy: 'decline_notify',
  },
  group: {
    engageMode: 'mention-sticky',
    threads: true,
    sessionMode: 'per-thread',
    unknownSenderPolicy: 'request_approval',
  },
  // The platform emits a dedicated `mention` event, so mentions are
  // platform-confirmed rather than inferred from message text.
  mentions: 'platform',
};

// ── Wire types ────────────────────────────────────────────────────────────────

/** The envelope every webhook delivery shares. */
interface AmbiguousEvent {
  id: string;
  type: string;
  timestamp: string;
  actor?: { id?: string; name?: string; type?: string };
  resource?: { id?: string; type?: string; url?: string };
  summary?: string;
  data?: Record<string, unknown>;
}

/** What one inbound chat event reduces to once the envelope is unwrapped. */
export interface ParsedMessage {
  channelId: string;
  messageId: string;
  threadId: string | null;
  text: string;
  senderId: string;
  senderName: string;
  isMention: boolean;
  /**
   * True when the event carried no message body of its own. A `mention`
   * delivery is a notification — it names the message but does not include it —
   * so the text must be fetched before the agent sees anything useful.
   */
  needsFetch: boolean;
}

// ── Pure helpers (exported for the self-check) ────────────────────────────────

/**
 * Verify an Ambiguous webhook signature: HMAC-SHA256 over `timestamp.payload`,
 * rendered as `sha256=<hex>`.
 *
 * Compared with timingSafeEqual, and only after a length check — timingSafeEqual
 * throws on a length mismatch rather than returning false, which would turn a
 * malformed header into a 500 instead of a rejection.
 */
export function verifySignature(
  payload: string,
  signatureHeader: string | undefined,
  timestampHeader: string | undefined,
  secret: string,
  now: number = Date.now(),
): { ok: true } | { ok: false; reason: string } {
  if (!signatureHeader) return { ok: false, reason: 'missing signature header' };
  if (!timestampHeader) return { ok: false, reason: 'missing timestamp header' };

  const timestampSeconds = Number(timestampHeader);
  if (!Number.isFinite(timestampSeconds)) return { ok: false, reason: 'malformed timestamp' };
  if (Math.abs(now - timestampSeconds * 1000) > MAX_SIGNATURE_AGE_MS)
    return { ok: false, reason: 'timestamp outside the accepted window' };

  const expected = `sha256=${crypto
    .createHmac('sha256', secret)
    .update(`${timestampHeader}.${payload}`)
    .digest('hex')}`;

  const received = Buffer.from(signatureHeader);
  const computed = Buffer.from(expected);
  if (received.length !== computed.length) return { ok: false, reason: 'signature mismatch' };
  if (!crypto.timingSafeEqual(received, computed)) return { ok: false, reason: 'signature mismatch' };
  return { ok: true };
}

/**
 * Reduce a webhook envelope to the fields the router needs, or null when the
 * event is not an inbound chat message we should act on.
 *
 * `selfUserId` is this agent's own user id: Ambiguous delivers our own sends
 * back to us as `message.created`, so without this check the agent answers
 * itself forever. Dropping self-authored events is the loop guard.
 */
export function parseMessageEvent(
  event: AmbiguousEvent,
  selfUserId: string | null,
): ParsedMessage | null {
  if (event.type !== 'message.created' && event.type !== 'mention') return null;

  const actorId = typeof event.actor?.id === 'string' ? event.actor.id : '';
  if (selfUserId && actorId === selfUserId) return null;

  const data = event.data ?? {};
  const str = (value: unknown): string | null =>
    typeof value === 'string' && value.length > 0 ? value : null;

  // channel_id is the documented field; the resource url is the fallback for
  // event shapes that carry only the permalink.
  const channelId =
    str(data.channel_id) ??
    str(data.channelId) ??
    str(event.resource?.url)?.match(/\/api\/channels\/([^/]+)/)?.[1] ??
    null;
  if (!channelId) return null;

  const messageId = str(data.message_id) ?? str(data.id) ?? str(event.resource?.id) ?? event.id;

  // `summary` is deliberately NOT a fallback for the body: it reads like
  // "Ryan mentioned you", which the agent would relay as if it were the
  // message. An absent body means fetch it, not paraphrase the notification.
  const body = str(data.content) ?? str(data.text);

  return {
    channelId,
    messageId,
    threadId: str(data.thread_id) ?? str(data.threadId) ?? null,
    text: body ?? '',
    senderId: actorId || 'unknown',
    senderName: str(event.actor?.name) ?? 'unknown',
    // A `mention` event is a mention by definition; a plain message is not.
    isMention: event.type === 'mention',
    needsFetch: body === null,
  };
}

/** `ambiguous:<channelId>` — matches the `<channelType>:<id>` convention. */
export function toPlatformId(channelId: string): string {
  return `${CHANNEL_TYPE}:${channelId}`;
}

export function toChannelId(platformId: string): string {
  return platformId.replace(new RegExp(`^${CHANNEL_TYPE}:`), '').split(':')[0];
}

/** Pull the text out of an outbound row, whatever shape the agent wrote. */
export function extractText(message: OutboundMessage): string | null {
  const content = message.content as Record<string, unknown> | string | undefined;
  if (typeof content === 'string') return content;
  if (content && typeof content === 'object' && typeof content.text === 'string') return content.text;
  return null;
}

// ── Adapter ───────────────────────────────────────────────────────────────────

export function createAmbiguousAdapter(): ChannelAdapter | null {
  const env = readEnvFile(['AMBIGUOUS_API_TOKEN', 'AMBIGUOUS_WEBHOOK_SECRET', 'AMBIGUOUS_BASE_URL']);
  const token = process.env.AMBIGUOUS_API_TOKEN ?? env.AMBIGUOUS_API_TOKEN;
  // Return null rather than throw so the registry emits its usual
  // "credentials missing, skipping" warning instead of killing startup.
  if (!token) return null;

  const secret = process.env.AMBIGUOUS_WEBHOOK_SECRET ?? env.AMBIGUOUS_WEBHOOK_SECRET ?? '';
  const baseUrl = (process.env.AMBIGUOUS_BASE_URL ?? env.AMBIGUOUS_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/$/, '');

  let connected = false;
  let selfUserId: string | null = null;

  /**
   * Message ids already handed to the router. One message can arrive twice —
   * `message.created` for the channel and `mention` for the same text — and
   * without this the agent answers it twice. Bounded so a long-lived host
   * cannot grow it without limit; ids are only needed for seconds.
   */
  const seen = new Set<string>();
  function alreadyHandled(messageId: string): boolean {
    if (seen.has(messageId)) return true;
    seen.add(messageId);
    if (seen.size > 500) for (const id of seen) { seen.delete(id); if (seen.size <= 250) break; }
    return false;
  }

  async function api<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
    const response = await fetch(`${baseUrl}${path}`, {
      method: init?.method ?? 'GET',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: init?.body === undefined ? undefined : JSON.stringify(init.body),
    });
    if (!response.ok) {
      // 429 carries Retry-After; surface it so the cause is not guesswork.
      const retryAfter = response.headers.get('retry-after');
      throw new Error(
        `Ambiguous ${init?.method ?? 'GET'} ${path} failed: ${response.status}` +
          (retryAfter ? ` (retry after ${retryAfter}s)` : ''),
      );
    }
    return (await response.json()) as T;
  }

  const adapter: ChannelAdapter = {
    name: 'Ambiguous',
    channelType: CHANNEL_TYPE,
    supportsThreads: true,

    async setup(config: ChannelSetup): Promise<void> {
      // Learn our own id first: without it every message we send comes back as
      // an inbound event and the agent talks to itself.
      try {
        const me = await api<{ id?: string }>('/api/users/me');
        selfUserId = typeof me.id === 'string' ? me.id : null;
      } catch (err) {
        log.error('Ambiguous: could not resolve own identity; refusing to start', { err });
        throw err;
      }

      if (!secret) {
        log.warn(
          'Ambiguous: AMBIGUOUS_WEBHOOK_SECRET is not set — inbound deliveries cannot be verified and will be refused',
        );
      }

      registerWebhookHandler(WEBHOOK_PATH, async (req: http.IncomingMessage, res: http.ServerResponse) => {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of req) {
          size += (chunk as Buffer).length;
          if (size > 1024 * 1024) {
            res.writeHead(413).end();
            return;
          }
          chunks.push(chunk as Buffer);
        }
        const raw = Buffer.concat(chunks).toString('utf8');

        const verdict = secret
          ? verifySignature(
              raw,
              req.headers['x-webhook-signature'] as string | undefined,
              req.headers['x-webhook-timestamp'] as string | undefined,
              secret,
            )
          : ({ ok: false, reason: 'no signing secret configured' } as const);

        if (!verdict.ok) {
          // An unverified body is not parsed at all — it is attacker-controlled
          // until the signature says otherwise.
          log.warn('Ambiguous: rejected webhook delivery', { reason: verdict.reason });
          res.writeHead(401).end();
          return;
        }

        // Answer before doing the work: Ambiguous counts a slow reply as a
        // failed delivery, and 10 in a row disable the webhook.
        res.writeHead(200).end();

        let event: AmbiguousEvent;
        try {
          event = JSON.parse(raw) as AmbiguousEvent;
        } catch {
          log.warn('Ambiguous: webhook body was not JSON');
          return;
        }

        const parsed = parseMessageEvent(event, selfUserId);
        if (!parsed) return;
        if (alreadyHandled(parsed.messageId)) return;

        let { text, threadId } = parsed;
        if (parsed.needsFetch) {
          // A mention notification names the message without carrying it.
          try {
            const full = await api<{ content?: string; thread_id?: string | null; user_id?: string }>(
              `/api/channels/${encodeURIComponent(parsed.channelId)}/messages/${encodeURIComponent(parsed.messageId)}`,
            );
            if (typeof full.content === 'string') text = full.content;
            if (threadId === null && typeof full.thread_id === 'string') threadId = full.thread_id;
          } catch (err) {
            log.warn('Ambiguous: could not fetch mentioned message body', { err });
          }
        }

        // Relaying an empty body would have the agent answer a message it
        // cannot read — better to drop it than to guess at what was said.
        if (!text) {
          log.warn('Ambiguous: dropping event with no message body', { messageId: parsed.messageId });
          return;
        }

        try {
          await config.onInbound(toPlatformId(parsed.channelId), threadId, {
            id: parsed.messageId,
            kind: 'chat',
            timestamp: event.timestamp ?? new Date().toISOString(),
            content: {
              text,
              sender: parsed.senderName,
              senderId: `${CHANNEL_TYPE}:${parsed.senderId}`,
            },
            isMention: parsed.isMention,
            isGroup: true,
          });
        } catch (err) {
          log.error('Ambiguous: onInbound threw', { err });
        }
      });

      connected = true;
      log.info('Ambiguous adapter ready', { baseUrl, webhook: `/webhook/${WEBHOOK_PATH}` });
    },

    async teardown(): Promise<void> {
      connected = false;
    },

    isConnected(): boolean {
      return connected;
    },

    async deliver(
      platformId: string,
      threadId: string | null,
      message: OutboundMessage,
    ): Promise<string | undefined> {
      const text = extractText(message);
      if (!text) return undefined;

      const sent = await api<{ id?: string }>(
        `/api/channels/${encodeURIComponent(toChannelId(platformId))}/messages`,
        { method: 'POST', body: { content: text, ...(threadId ? { thread_id: threadId } : {}) } },
      );
      return sent.id;
    },

    async resolveChannelName(platformId: string): Promise<string | null> {
      try {
        const channel = await api<{ name?: string }>(
          `/api/channels/${encodeURIComponent(toChannelId(platformId))}`,
        );
        return channel.name ?? null;
      } catch {
        return null;
      }
    },

    async resolveConversation(platformId: string): Promise<ResolvedConversation | null> {
      try {
        const channel = await api<{ name?: string; type?: string }>(
          `/api/channels/${encodeURIComponent(toChannelId(platformId))}`,
        );
        // Ambiguous channel types are public | private | dm.
        if (channel.type === 'dm') return { type: 'direct', name: null };
        return { type: 'channel', name: channel.name ?? null };
      } catch {
        return null;
      }
    },
  };

  return adapter;
}

registerChannelAdapter(CHANNEL_TYPE, {
  factory: createAmbiguousAdapter,
  defaults: AMBIGUOUS_DEFAULTS,
});
