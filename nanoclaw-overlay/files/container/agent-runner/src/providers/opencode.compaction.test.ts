import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb, getInboundDb } from '../mailbox/sqlite/connection.js';
import { buildPostCompactionReminder, createCompactionReminder } from './opencode.js';

/**
 * OpenCode 1.4.11 has no compaction-prompt API, but it DOES emit a
 * `session.compacted` event. The provider latches that event (filtered to the
 * turn's active session, since the OpenCode server is shared) and re-injects a
 * routing-discipline reminder on the next prompt — otherwise the auto-compacted
 * summary can silently drop the "wrap replies in <message to>" contract and the
 * agent's replies stop reaching anyone.
 */

const REMINDER = '<<reminder>>';

describe('createCompactionReminder', () => {
  it('arms on the active session and prepends the reminder to the next prompt', () => {
    const latch = createCompactionReminder(() => REMINDER);
    latch.note('ses_active', 'ses_active');
    expect(latch.isArmed).toBe(true);

    const out = latch.apply('do the next thing');
    expect(out.startsWith(REMINDER)).toBe(true);
    expect(out).toContain('do the next thing');
  });

  it('does NOT arm when a DIFFERENT session compacts (shared-server cross-talk)', () => {
    const latch = createCompactionReminder(() => REMINDER);
    latch.note('ses_other', 'ses_active');
    expect(latch.isArmed).toBe(false);
    // Next prompt passes through untouched.
    expect(latch.apply('unrelated turn')).toBe('unrelated turn');
  });

  it('does NOT arm when there is no active session yet', () => {
    const latch = createCompactionReminder(() => REMINDER);
    latch.note('ses_x', undefined);
    expect(latch.isArmed).toBe(false);
    expect(latch.apply('turn')).toBe('turn');
  });

  it('injects exactly once — the flag clears after the first prompt', () => {
    const latch = createCompactionReminder(() => REMINDER);
    latch.note('ses_active', 'ses_active');

    const first = latch.apply('first prompt');
    expect(first.startsWith(REMINDER)).toBe(true);
    expect(latch.isArmed).toBe(false);

    // Second prompt is clean — no lingering reminder.
    const second = latch.apply('second prompt');
    expect(second).toBe('second prompt');
  });

  it('a later compaction re-arms the latch (per-event, not once-per-query)', () => {
    const latch = createCompactionReminder(() => REMINDER);
    latch.note('s', 's');
    latch.apply('a'); // consumes
    expect(latch.isArmed).toBe(false);
    latch.note('s', 's'); // a second compaction later in the same conversation
    expect(latch.isArmed).toBe(true);
    expect(latch.apply('b').startsWith(REMINDER)).toBe(true);
  });
});

describe('buildPostCompactionReminder', () => {
  beforeEach(() => {
    initTestSessionDb();
  });
  afterEach(() => {
    closeSessionDb();
  });

  function seedDestination(name: string): void {
    getInboundDb()
      .prepare(
        `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
         VALUES (?, ?, 'channel', 'discord', 'chan-1', NULL)`,
      )
      .run(name, name);
  }

  it('states the <message to> wrapping discipline and lists live destinations', () => {
    seedDestination('family');
    seedDestination('ops');
    const text = buildPostCompactionReminder();
    expect(text).toContain('<message to="name">');
    expect(text).toContain('compacted');
    expect(text).toContain('`family`');
    expect(text).toContain('`ops`');
  });

  it('falls back to (none) when there are no destinations', () => {
    expect(buildPostCompactionReminder()).toContain('(none)');
  });

  it('accepts an explicit name list (no DB read)', () => {
    expect(buildPostCompactionReminder(['solo'])).toContain('`solo`');
  });
});
