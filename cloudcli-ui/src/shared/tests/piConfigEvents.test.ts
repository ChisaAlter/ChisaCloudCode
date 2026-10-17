import { beforeEach, expect, test, vi } from 'vitest';

import type { PiConfigInput, PiConfigView } from '@/shared/types';

const native = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('mygo-runtime', () => ({ call: native.call }));

const input: PiConfigInput = {
  provider: 'custom', model: 'chosen-model', baseUrl: 'https://example.test/v1/',
  api: 'openai-completions', apiKey: 'synthetic-write-only-key',
};
const saved: PiConfigView = {
  provider: 'custom', model: 'chosen-model', baseUrl: 'https://example.test/v1',
  api: 'openai-completions', ok: true, installed: true, configured: true, hasApiKey: true,
};

beforeEach(() => { vi.resetModules(); vi.resetAllMocks(); });

test('native saves publish their authoritative public configuration to every mounted entry point', async () => {
  native.call.mockResolvedValue(saved);
  const { FrontendBridge, onPiConfigChanged } = await import('@/shared/chisa');
  const menu = vi.fn();
  const settings = vi.fn();
  const removed = vi.fn();
  const unsubscribeMenu = onPiConfigChanged(menu);
  const unsubscribeSettings = onPiConfigChanged(settings);
  const unsubscribeRemoved = onPiConfigChanged(removed);
  unsubscribeRemoved();
  try {
    expect(await FrontendBridge.piSaveConfig(input)).toBe(saved);
    expect(native.call).toHaveBeenCalledExactlyOnceWith('FrontendBridge.PiSaveConfig', input);
    expect(menu).toHaveBeenCalledExactlyOnceWith(saved);
    expect(settings).toHaveBeenCalledExactlyOnceWith(saved);
    expect(removed).not.toHaveBeenCalled();
    expect(menu.mock.calls[0][0]).not.toHaveProperty('apiKey');
  } finally {
    unsubscribeMenu();
    unsubscribeSettings();
  }
});

test('a rejected native save does not announce an unsaved model', async () => {
  const failure = { ok: false, error: '请先停止本地 Pi' };
  native.call.mockResolvedValue(failure);
  const { FrontendBridge, onPiConfigChanged } = await import('@/shared/chisa');
  const listener = vi.fn();
  const unsubscribe = onPiConfigChanged(listener);
  try {
    expect(await FrontendBridge.piSaveConfig(input)).toBe(failure);
    expect(listener).not.toHaveBeenCalled();
  } finally {
    unsubscribe();
  }
});

test('a failed bridge call keeps configuration observers unchanged', async () => {
  native.call.mockRejectedValue(new Error('native unavailable'));
  const { FrontendBridge, onPiConfigChanged } = await import('@/shared/chisa');
  const listener = vi.fn();
  const unsubscribe = onPiConfigChanged(listener);
  try {
    await expect(FrontendBridge.piSaveConfig(input)).rejects.toThrow('native unavailable');
    expect(listener).not.toHaveBeenCalled();
  } finally {
    unsubscribe();
  }
});
