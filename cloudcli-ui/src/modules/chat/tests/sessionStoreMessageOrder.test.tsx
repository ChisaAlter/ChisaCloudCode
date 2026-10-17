import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';

import type { NormalizedMessage } from '@/shared/types';

const sessionMessages = vi.fn();

vi.mock('@/shared/api', () => ({
  api: {
    providers: {
      sessionMessages: (...args: unknown[]) => sessionMessages(...args),
    },
  },
}));

function textRow(id: string, role: 'user' | 'assistant', content: string, timestamp: string): NormalizedMessage {
  return { id, role, content, timestamp, kind: 'text', provider: 'claude', sessionId: 'session-1' };
}

function toolRow(id: string, toolId: string, timestamp: string): NormalizedMessage {
  return { id, toolId, timestamp, kind: 'tool_use', toolName: 'list_files', provider: 'claude', sessionId: 'session-1' };
}

const HISTORY = [
  textRow('clone', 'user', 'clone完这个项目', '2026-10-04T07:34:55.527Z'),
  textRow('url', 'assistant', '请提供项目 URL', '2026-10-04T07:34:57.919Z'),
];

function returnHistory(messages: NormalizedMessage[]) {
  sessionMessages.mockResolvedValue({
    ok: true,
    json: async () => ({ data: { messages, total: messages.length, hasMore: false } }),
  });
}

beforeEach(() => {
  sessionMessages.mockReset();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-04T07:34:28.000Z'));
});

afterEach(() => {
  vi.useRealTimers();
  vi.resetModules();
});

async function loadedStore(messages = HISTORY) {
  returnHistory(messages);
  const { useSessionStore } = await import('@/modules/chat/hooks/useSessionStore');
  const view = renderHook(() => useSessionStore());
  await act(async () => {
    await view.result.current.fetchFromServer('session-1', { limit: 20, offset: 0 });
  });
  return view;
}

describe('session message order', () => {
  it.each([
    ['server ahead', '2026-10-04T07:34:28.000Z'],
    ['client ahead', '2026-10-04T07:36:01.000Z'],
  ])('keeps a new turn after history with %s', async (_clock, localTimestamp) => {
    const { result } = await loadedStore();
    act(() => {
      result.current.appendRealtime('session-1', textRow('local_inspect', 'user', '你看看当前项目', localTimestamp));
      result.current.appendRealtime('session-1', toolRow('list', 'tool-list', '2026-10-04T07:35:17.140Z'));
      result.current.appendRealtime('session-1', { ...toolRow('read', 'tool-read', '2026-10-04T07:35:20.140Z'), toolName: 'read_file' });
      result.current.appendRealtime('session-1', textRow('answer', 'assistant', '目录为空', '2026-10-04T07:35:32.000Z'));
    });
    assert.deepEqual(result.current.getMessages('session-1').map((message) => message.id), [
      'clone', 'url', 'local_inspect', 'list', 'read', 'answer',
    ]);

    if (_clock === 'server ahead') {
      returnHistory([
        ...HISTORY,
        textRow('inspect', 'user', '你看看当前项目', '2026-10-04T07:35:14.809Z'),
        toolRow('persisted-list', 'tool-list', '2026-10-04T07:35:17.140Z'),
        { ...toolRow('persisted-read', 'tool-read', '2026-10-04T07:35:20.140Z'), toolName: 'read_file' },
        textRow('answer', 'assistant', '目录为空', '2026-10-04T07:35:32.000Z'),
      ]);
      await act(async () => {
        await result.current.refreshLatestFromServer('session-1');
      });
      assert.deepEqual(result.current.getMessages('session-1').map((message) => message.id), [
        'clone', 'url', 'inspect', 'persisted-list', 'persisted-read', 'answer',
      ]);
      assert.equal(result.current.getSessionSlot('session-1')?.realtimeMessages.length, 0);
    }
  });

  it.each(['initial fetch', 'latest refresh'])('keeps an unfinished stream before an already persisted tool during %s', async (method) => {
    const prompt = textRow('prompt', 'user', '检查目录', '2026-10-04T07:35:00.000Z');
    const { result } = await loadedStore([prompt]);
    act(() => {
      result.current.appendRealtime('session-1', prompt);
      result.current.updateStreaming('session-1', '我在检查目录', 'claude');
      result.current.appendRealtime('session-1', toolRow('live-list', 'tool-list', '2026-10-04T07:35:17.140Z'));
    });
    const persistedTool = toolRow('persisted-list', 'tool-list', '2026-10-04T07:35:17.140Z');
    returnHistory([prompt, persistedTool]);
    await act(async () => {
      if (method === 'initial fetch') {
        await result.current.fetchFromServer('session-1', { limit: 20, offset: 0 });
      } else {
        await result.current.refreshLatestFromServer('session-1');
      }
    });
    assert.deepEqual(result.current.getMessages('session-1').map((message) => message.id), [
      'prompt', '__streaming_session-1', 'persisted-list',
    ]);

    returnHistory([
      prompt,
      textRow('persisted-text', 'assistant', '我在检查目录', '2026-10-04T07:35:16.000Z'),
      persistedTool,
    ]);
    await act(async () => {
      await result.current.refreshLatestFromServer('session-1');
    });
    assert.deepEqual(result.current.getMessages('session-1').map((message) => message.id), [
      'prompt', 'persisted-text', 'persisted-list',
    ]);
    assert.equal(result.current.getSessionSlot('session-1')?.realtimeMessages.length, 0);
  });

  it('keeps the first streaming timestamp and position through text updates', async () => {
    const { result } = await loadedStore();
    act(() => {
      result.current.updateStreaming('session-1', '先看目录', 'claude');
      result.current.appendRealtime('session-1', toolRow('list', 'tool-list', '2026-10-04T07:35:17.140Z'));
    });
    vi.setSystemTime(new Date('2026-10-04T07:34:45.000Z'));
    act(() => {
      result.current.updateStreaming('session-1', '先看目录，再看文件', 'claude');
    });
    assert.deepEqual(result.current.getMessages('session-1').map((message) => message.id), [
      'clone', 'url', '__streaming_session-1', 'list',
    ]);
    const stream = result.current.getMessages('session-1')[2];
    assert.equal(stream.timestamp, '2026-10-04T07:34:28.000Z');
    assert.equal(stream.content, '先看目录，再看文件');
  });

  it('keeps a repeated pending user turn distinct from a previously claimed echo', async () => {
    const firstPrompt = textRow('first', 'user', '继续', '2026-10-04T07:35:14.000Z');
    const tool = toolRow('persisted-list', 'tool-list', '2026-10-04T07:35:17.140Z');
    const { result } = await loadedStore([firstPrompt, tool]);
    act(() => {
      result.current.appendRealtime('session-1', textRow('local_first', 'user', '继续', '2026-10-04T07:34:28.000Z'));
      result.current.appendRealtime('session-1', toolRow('live-list', 'tool-list', '2026-10-04T07:35:17.140Z'));
      result.current.appendRealtime('session-1', textRow('local_again', 'user', '继续', '2026-10-04T07:34:28.000Z'));
    });
    await act(async () => {
      await result.current.refreshLatestFromServer('session-1');
    });
    assert.deepEqual(result.current.getMessages('session-1').map((message) => message.id), [
      'first', 'persisted-list', 'local_again',
    ]);
  });
});
