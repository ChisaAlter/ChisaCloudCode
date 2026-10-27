import { act, cleanup, renderHook } from '@testing-library/react';
import { createElement } from 'react';
import type { MutableRefObject, PropsWithChildren } from 'react';
import type { FitAddon } from '@xterm/addon-fit';
import type { Terminal } from '@xterm/xterm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useShellConnection } from '@/modules/shell/hooks/useShellConnection';
import type { Project, ProjectSession, WorkspaceDescriptor } from '@/shared/types';
import { WorkspaceScopeContext } from '@/shared/context/WorkspaceScopeContext';
import { TERMINAL_INIT_DELAY_MS } from '@/shared/constants';

// Only the URL builder is stubbed: it reads a stored auth token and would bail
// before a socket is ever constructed. `parseShellMessage` stays real, because
// what is under test is how a parsed frame is dispatched.
vi.mock('@/modules/shell/utils/socket', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getShellWebSocketUrl: () => 'ws://localhost/shell',
}));

class FakeSocket {
  static last: FakeSocket | null = null;
  static OPEN = 1;

  readyState = 1;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];

  constructor() {
    FakeSocket.last = this;
  }

  send(payload: string) {
    this.sent.push(payload);
  }

  close() {
    this.readyState = 3;
  }
}

const ref = <T,>(value: T): MutableRefObject<T> => ({ current: value });

function renderConnection(workspace?: WorkspaceDescriptor | null) {
  const write = vi.fn();
  const clearTerminalScreen = vi.fn();
  const closeSocket = vi.fn();
  const terminalRef = ref({ write, cols: 80, rows: 24 } as unknown as Terminal | null);

  const wsRef = ref<WebSocket | null>(null);
  const view = renderHook(() =>
    useShellConnection({
      wsRef,
      terminalRef,
      fitAddonRef: ref({ fit: vi.fn() } as unknown as FitAddon | null),
      selectedProjectRef: ref<Project | null | undefined>({
        fullPath: '/tmp/gone',
        path: '/tmp/gone',
      } as Project),
      selectedSessionRef: ref<ProjectSession | null | undefined>(null),
      initialCommandRef: ref<string | null | undefined>(null),
      isPlainShellRef: ref(false),
      bypassPermissionsRef: ref(false),
      onProcessCompleteRef: ref<((exitCode: number) => void) | null | undefined>(null),
      isInitialized: true,
      autoConnect: false,
      closeSocket,
      clearTerminalScreen,
    }),
    { wrapper: ({ children }: PropsWithChildren) => createElement(WorkspaceScopeContext.Provider, { value: workspace }, children) },
  );

  act(() => {
    view.result.current.connectToShell();
  });
  act(() => {
    FakeSocket.last?.onopen?.();
  });

  return { view, write, clearTerminalScreen, closeSocket, socket: FakeSocket.last! };
}

describe('shell socket error frames', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeSocket.last = null;
    vi.stubGlobal('WebSocket', FakeSocket);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const workspace: WorkspaceDescriptor = {
    projectId: 'project', workspaceId: 'session:one', generation: 'generation', kind: 'session', sessionId: 'one',
    rootPath: '/isolated/one', sourceRoot: '/cloud/project', requestedMode: 'isolated', effectiveMode: 'isolated',
    phase: 'idle', publicationState: 'unpublished',
    capabilities: { read: true, write: true, git: true, shell: true, preview: true, integrate: true, cloudExecutionIndependentOfDesktop: true },
  };

  it('sends an exact workspace selector and waits for matching server readiness', () => {
    const { view, write, socket } = renderConnection(workspace);
    expect(view.result.current.isConnected).toBe(false);
    act(() => vi.advanceTimersByTime(TERMINAL_INIT_DELAY_MS));
    expect(JSON.parse(socket.sent[0])).toMatchObject({ type: 'init', projectId: 'project', workspaceId: 'session:one', generation: 'generation', sessionId: 'one', projectPath: '/isolated/one' });
    act(() => socket.onmessage?.({ data: JSON.stringify({ type: 'ready', projectId: 'project', workspaceId: 'session:one', generation: 'generation', sessionId: 'one', transport: 'pipe', resizeSupported: false }) }));
    expect(view.result.current.isConnected).toBe(true);
    expect(view.result.current.transport).toBe('pipe');
    expect(write.mock.calls[0][0]).toContain('Ctrl+C 将结束此终端');
  });

  it('describes Windows SSH commands without claiming Ctrl+C closes the terminal', () => {
    const { view, write, socket } = renderConnection({ ...workspace, sourceMode: 'ssh' });
    act(() => socket.onmessage?.({ data: JSON.stringify({ type: 'ready', projectId: 'project', workspaceId: 'session:one', generation: 'generation', sessionId: 'one', transport: 'pipe' }) }));
    expect(view.result.current.isConnected).toBe(true);
    expect(write.mock.calls[0][0]).toContain('Windows 命令');
    expect(write.mock.calls[0][0]).toContain('不保留变量或目录切换');
    expect(write.mock.calls[0][0]).toContain('Ctrl+C 停止当前命令');
    expect(write.mock.calls[0][0]).not.toContain('结束此终端');
  });

  it('rejects readiness for another session and does not connect an unavailable workspace', () => {
    const { view, socket } = renderConnection(workspace);
    act(() => socket.onmessage?.({ data: JSON.stringify({ type: 'ready', projectId: 'project', workspaceId: 'session:one', generation: 'generation', sessionId: 'wrong-session' }) }));
    expect(view.result.current.isConnected).toBe(false);
    expect(socket.readyState).toBe(3);
    view.unmount();
    FakeSocket.last = null;
    const unavailable = renderConnection(null);
    expect(unavailable.view.result.current.isConnected).toBe(false);
    expect(FakeSocket.last).toBeNull();
  });

  it('a cloud replica init omits the selected chat session', () => {
    const { socket } = renderConnection({ ...workspace, workspaceId: 'replica', kind: 'cloudReplica', sessionId: undefined });
    act(() => vi.advanceTimersByTime(TERMINAL_INIT_DELAY_MS));
    expect(JSON.parse(socket.sent[0])).not.toHaveProperty('sessionId');
  });

  it('writes the server error into the terminal instead of dropping it', () => {
    const { write, socket } = renderConnection();

    act(() => {
      socket.onmessage?.({
        data: JSON.stringify({ type: 'error', message: 'Invalid project path' }),
      });
    });

    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0][0]).toContain('Invalid project path');
  });

  it('keeps the socket open so the message it just wrote is not cleared', () => {
    const { clearTerminalScreen, closeSocket, socket } = renderConnection();

    act(() => {
      socket.onmessage?.({
        data: JSON.stringify({ type: 'error', message: 'Invalid session ID' }),
      });
    });

    expect(clearTerminalScreen).not.toHaveBeenCalled();
    expect(closeSocket).not.toHaveBeenCalled();
    expect(socket.readyState).toBe(1);
  });

  it('falls back to a generic label when the frame carries no message', () => {
    const { write, socket } = renderConnection();

    act(() => {
      socket.onmessage?.({ data: JSON.stringify({ type: 'error' }) });
    });

    expect(write.mock.calls[0][0]).toContain('Shell error');
  });

  it('still writes plain output frames unchanged', () => {
    const { write, socket } = renderConnection();

    act(() => {
      socket.onmessage?.({ data: JSON.stringify({ type: 'output', data: 'hello' }) });
    });

    expect(write).toHaveBeenCalledWith('hello');
  });
});
