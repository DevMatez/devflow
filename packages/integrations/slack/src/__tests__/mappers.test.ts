import { describe, expect, it } from 'vitest';
import { toChatChannel, toChatMessage } from '../mappers';

describe('toChatChannel', () => {
  it('maps id and name', () => {
    expect(toChatChannel({ id: 'C123', name: 'general' })).toEqual({
      externalId: 'C123',
      name: 'general',
    });
  });

  it('falls back name to the id when absent', () => {
    expect(toChatChannel({ id: 'D456' })).toEqual({ externalId: 'D456', name: 'D456' });
  });
});

describe('toChatMessage', () => {
  it('maps a bot-authored message, converting ts to an ISO postedAt', () => {
    const message = toChatMessage({ ts: '1503435956.000247', text: 'hi', bot_id: 'B1' }, 'C123');
    expect(message).toEqual({
      externalId: '1503435956.000247',
      channelExternalId: 'C123',
      text: 'hi',
      authorExternalId: 'B1',
      postedAt: new Date(1503435956000).toISOString(),
    });
  });

  it('falls back to user id when bot_id is absent, and empty text when missing', () => {
    const message = toChatMessage({ ts: '1503435956.000247', user: 'U1' }, 'C123');
    expect(message.authorExternalId).toBe('U1');
    expect(message.text).toBe('');
  });

  it('falls back to "unknown" when neither bot_id nor user is present', () => {
    const message = toChatMessage({ ts: '1503435956.000247' }, 'C123');
    expect(message.authorExternalId).toBe('unknown');
  });
});
