import { describe, expect, test } from 'vitest';

import { createVoiceCredentialStore } from '@/modules/voice';
import type { AuthSessionSnapshot } from '@/shared/types';

function fixture() {
  localStorage.clear();
  const snapshot = (userId: string, serverKey = 'https://a.test', id = crypto.randomUUID()): AuthSessionSnapshot => ({ userId, serverKey, sessionInstanceId: id,
    tokenRevision: 0, token: 'test-token', phase: 'ready', nativeGeneration: null, nativeHandle: null, storageMode: 'window' });
  let current = snapshot('1');
  const listeners = new Set<() => void>();
  const store = createVoiceCredentialStore({ storage: localStorage, getSession: () => current,
    isCurrent: captured => captured.sessionInstanceId === current.sessionInstanceId && captured.serverKey === current.serverKey && current.phase === 'ready',
    subscribe: callback => { listeners.add(callback); return () => { listeners.delete(callback); }; } });
  return { store, session: () => current, change(next: AuthSessionSnapshot) { current = next; for (const callback of listeners) callback(); }, snapshot };
}

describe('voice credentials follow explicit server/account ownership', () => {
  test('normal settings persist per-account non-secret configuration and secret', () => {
    const { store } = fixture();
    expect(store.write({ baseUrl: 'https://voice.test/v1', apiKey: 'first-key', sttModel: 'speech' })).toMatchObject({ apiKey: 'first-key', sttModel: 'speech' });
    expect(store.read().baseUrl).toBe('https://voice.test/v1');
    store.dispose();
  });
  test('unknown legacy global credentials are not automatically inherited', () => {
    const { store } = fixture();
    localStorage.setItem('voiceConfig', JSON.stringify({ apiKey: 'unknown-key', baseUrl: 'https://unknown.test' }));
    localStorage.setItem('globalapikey', 'unknown-global');
    expect(store.read().apiKey).toBe(''); expect(store.read().baseUrl).toBe('');
    store.dispose();
  });
  test('switching account or server clears cached credentials and does not inherit the previous account', () => {
    const { store, session, change, snapshot } = fixture();
    const first = session(); store.write({ apiKey: 'a-key', sttModel: 'a-model' }, first);
    change(snapshot('2'));
    expect(store.read().apiKey).toBe(''); expect(() => store.write({ apiKey: 'old-edit' }, first)).toThrow(/changed/);
    store.write({ apiKey: 'b-key', sttModel: 'b-model' });
    change(snapshot('2', 'https://b.test'));
    expect(store.read().apiKey).toBe(''); expect(store.read().sttModel).toBe('');
    change(snapshot('1'));
    expect(store.read().apiKey).toBe(''); expect(store.read().sttModel).toBe('a-model');
    store.dispose();
  });
  test('logout synchronously erases the old secret and returns empty settings while signed out', () => {
    const { store, session, change } = fixture();
    const first = session(); store.write({ apiKey: 'secret-to-remove' });
    change({ ...first, phase: 'closing' });
    expect(store.read().apiKey).toBe(''); expect(store.read(first).apiKey).toBe('');
    expect([...Array(localStorage.length)].map((_, index) => localStorage.getItem(localStorage.key(index)!)).join()).not.toContain('secret-to-remove');
    change({ ...first, sessionInstanceId: crypto.randomUUID(), userId: null, token: null, phase: 'signedOut' });
    expect(() => store.write({ apiKey: 'signed-out-edit' })).toThrow(/changed/);
    store.dispose();
  });
  test('token rotation does not erase valid credentials, malformed scoped state contains no secret', () => {
    const { store, session, change } = fixture(); store.write({ apiKey: 'current-key' });
    change({ ...session(), tokenRevision: 1 }); expect(store.read().apiKey).toBe('current-key');
    const key = localStorage.key(0)!; localStorage.setItem(key, '["apiKey"]'); store.invalidate();
    expect(store.read().apiKey).toBe('');
    store.dispose();
  });
});
