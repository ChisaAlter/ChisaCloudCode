import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { MutableRefObject } from 'react';
import type { FitAddon } from '@xterm/addon-fit';
import type { Terminal } from '@xterm/xterm';

import type { Project, ProjectSession } from '@/shared/types';
import { TERMINAL_INIT_DELAY_MS } from '@/shared/constants';
import { bindShellSocketIdentity, getShellWebSocketUrl, parseShellMessage, sendSocketMessage } from '@/modules/shell/utils/socket';
import { dispatchWithAuthSession, getAuthSessionSnapshot, isCurrentAuthSession, subscribeToAuthSession } from '@/shared/authToken';
import { getServerTransportVersion, subscribeToServerConnection } from '@/shared/chisa';
import { readSelectedProvider } from '@/shared/selectedProvider';
import { useWorkspaceScope } from '@/shared/context/WorkspaceScopeContext';

const ANSI_ESCAPE_REGEX =
  /(?:\u001B\[[0-?]*[ -/]*[@-~]|\u009B[0-?]*[ -/]*[@-~]|\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)|\u009D[^\u0007\u009C]*(?:\u0007|\u009C)|\u001B[PX^_][^\u001B]*\u001B\\|[\u0090\u0098\u009E\u009F][^\u009C]*\u009C|\u001B[@-Z\\-_])/g;
const PROCESS_EXIT_REGEX = /Process exited with code (\d+)/;

type UseShellConnectionOptions = {
  wsRef: MutableRefObject<WebSocket | null>;
  terminalRef: MutableRefObject<Terminal | null>;
  fitAddonRef: MutableRefObject<FitAddon | null>;
  selectedProjectRef: MutableRefObject<Project | null | undefined>;
  selectedSessionRef: MutableRefObject<ProjectSession | null | undefined>;
  initialCommandRef: MutableRefObject<string | null | undefined>;
  isPlainShellRef: MutableRefObject<boolean>;
  bypassPermissionsRef: MutableRefObject<boolean>;
  isDarkModeRef: MutableRefObject<boolean>;
  onProcessCompleteRef: MutableRefObject<((exitCode: number) => void) | null | undefined>;
  isInitialized: boolean;
  autoConnect: boolean;
  closeSocket: () => void;
  clearTerminalScreen: () => void;
  onOutputRef?: MutableRefObject<(() => void) | null>;
};

type UseShellConnectionResult = {
  isConnected: boolean;
  isConnecting: boolean;
  transport: 'pty' | 'pipe' | null;
  claudeLaunchColorScheme: 'light' | 'dark' | null;
  closeSocket: () => void;
  connectToShell: (options?: { forceRestart?: boolean }) => void;
  disconnectFromShell: (options?: { suppressAutoConnect?: boolean }) => void;
};

export function useShellConnection({
  wsRef,
  terminalRef,
  fitAddonRef,
  selectedProjectRef,
  selectedSessionRef,
  initialCommandRef,
  isPlainShellRef,
  bypassPermissionsRef,
  isDarkModeRef,
  onProcessCompleteRef,
  isInitialized,
  autoConnect,
  closeSocket,
  clearTerminalScreen,
  onOutputRef,
}: UseShellConnectionOptions): UseShellConnectionResult {
  const workspace = useWorkspaceScope();
  // Auth and transport transitions cancel pending ticket lookups and the connecting/active terminal socket.
  const authSnapshot = useSyncExternalStore(subscribeToAuthSession, getAuthSessionSnapshot, getAuthSessionSnapshot);
  const transportVersion = useSyncExternalStore(subscribeToServerConnection, getServerTransportVersion, getServerTransportVersion);
  // Each lookup owns one incarnation; disconnect/unmount invalidates even a lookup with no socket yet.
  const connectionAttemptRef = useRef(0);
  const workspaceRef = useRef(workspace);
  workspaceRef.current = workspace;
  const [isConnected, setIsConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  // Report the server's actual terminal support so users can choose suitable commands.
  const [transport, setTransport] = useState<'pty' | 'pipe' | null>(null);
  // The theme the server says the Claude CLI in this pty was launched for. Only
  // the server knows it: a reconnect can reattach to a CLI started in another
  // theme. Null when the pty runs anything else or no socket is open.
  const [claudeLaunchColorScheme, setClaudeLaunchColorScheme] = useState<'light' | 'dark' | null>(null);
  const connectingRef = useRef(false);
  const forceRestartOnInitRef = useRef(false);
  const suppressAutoConnectRef = useRef(false);

  const handleProcessCompletion = useCallback(
    (output: string) => {
      if (!isPlainShellRef.current || !onProcessCompleteRef.current) {
        return;
      }

      const sanitizedOutput = output.replace(ANSI_ESCAPE_REGEX, '');
      const cleanOutput = sanitizedOutput;
      if (cleanOutput.includes('Process exited with code 0')) {
        onProcessCompleteRef.current(0);
        return;
      }

      const match = cleanOutput.match(PROCESS_EXIT_REGEX);
      if (!match) {
        return;
      }

      const exitCode = Number.parseInt(match[1], 10);
      if (!Number.isNaN(exitCode) && exitCode !== 0) {
        onProcessCompleteRef.current(exitCode);
      }
    },
    [isPlainShellRef, onProcessCompleteRef],
  );

  const handleSocketMessage = useCallback(
    (rawPayload: string) => {
      const message = parseShellMessage(rawPayload);
      if (!message) {
        console.error('[Shell] Error handling WebSocket message:', rawPayload);
        return;
      }

      if (message.type === 'output') {
        const output = typeof message.data === 'string' ? message.data : '';
        handleProcessCompletion(output);
        terminalRef.current?.write(output);
        onOutputRef?.current?.();
        return;
      }

      if (message.type === 'error') {
        // The server sends this instead of spawning a PTY, then keeps the
        // socket open — so without writing it out the terminal just stays
        // blank forever under a green "connected" dot. Deliberately not
        // closing the socket: `onclose` clears the screen and would erase
        // the very message being surfaced here.
        const detail = typeof message.message === 'string' && message.message
          ? message.message
          : 'Shell error';
        terminalRef.current?.write(`\r\n\x1b[31m${detail}\x1b[0m\r\n`);
        return;
      }

      if (message.type === 'claude_theme') {
        const { colorScheme } = message;
        setClaudeLaunchColorScheme(colorScheme === 'light' || colorScheme === 'dark' ? colorScheme : null);
      }
    },
    [handleProcessCompletion, onOutputRef, terminalRef],
  );

  const connectWebSocket = useCallback(
    async (isConnectionLocked = false) => {
      const connectedWorkspace = workspaceRef.current;
      const expected = getAuthSessionSnapshot();
      if (expected.sessionInstanceId !== authSnapshot.sessionInstanceId || expected.serverKey !== authSnapshot.serverKey) return;
      const attempt = ++connectionAttemptRef.current;
      const expectedTransport = getServerTransportVersion();
      const ownsAttempt = () => attempt === connectionAttemptRef.current && isCurrentAuthSession(expected)
        && getAuthSessionSnapshot().phase === 'ready' && expectedTransport === getServerTransportVersion();
      if (connectedWorkspace === null || (connectedWorkspace && !connectedWorkspace.capabilities.shell)) {
        connectingRef.current = false;
        setIsConnecting(false);
        suppressAutoConnectRef.current = true;
        return;
      }
      if ((connectingRef.current && !isConnectionLocked) || isConnecting || isConnected) {
        return;
      }

      try {
        const wsUrl = await getShellWebSocketUrl();
        if (!ownsAttempt()) return;
        if (!wsUrl) {
          connectingRef.current = false;
          setIsConnecting(false);
          return;
        }

        connectingRef.current = true;
        setTransport(null);

        const admitted = await dispatchWithAuthSession(expected, () => {
          if (!ownsAttempt()) throw new DOMException('Shell identity changed', 'AbortError');
          const socket = new WebSocket(wsUrl);
          bindShellSocketIdentity(socket);
          wsRef.current = socket;
          return Promise.resolve(socket);
        });
        const socket = await admitted.operation;
        if (!ownsAttempt()) { socket.close(); return; }

        const ownsSocket = () => ownsAttempt() && wsRef.current === socket
          && workspaceRef.current !== null
          && workspaceRef.current?.workspaceId === connectedWorkspace?.workspaceId
          && workspaceRef.current?.generation === connectedWorkspace?.generation;
        socket.onopen = () => {
          if (!ownsSocket()) { socket.close(); return; }
          // Scoped shells become usable only after the server validates init.
          setIsConnected(connectedWorkspace === undefined);
          setIsConnecting(connectedWorkspace !== undefined);
          connectingRef.current = connectedWorkspace !== undefined;

          window.setTimeout(() => {
            const currentTerminal = terminalRef.current;
            const currentFitAddon = fitAddonRef.current;
            const currentProject = selectedProjectRef.current;
            if (!currentTerminal || !currentFitAddon || !currentProject || !ownsSocket()
              || workspaceRef.current?.workspaceId !== connectedWorkspace?.workspaceId
              || workspaceRef.current?.generation !== connectedWorkspace?.generation) {
              return;
            }

            currentFitAddon.fit();
            const forceRestart = forceRestartOnInitRef.current;
            forceRestartOnInitRef.current = false;

            sendSocketMessage(socket, {
              type: 'init',
              projectPath: connectedWorkspace?.rootPath ?? (currentProject.fullPath || currentProject.path || ''),
              ...(connectedWorkspace ? { projectId: connectedWorkspace.projectId, workspaceId: connectedWorkspace.workspaceId, generation: connectedWorkspace.generation } : {}),
              ...(connectedWorkspace ? (connectedWorkspace.kind === 'session' ? { sessionId: connectedWorkspace.sessionId } : {}) : { sessionId: isPlainShellRef.current ? null : selectedSessionRef.current?.id || null }),
              hasSession: isPlainShellRef.current ? false : Boolean(selectedSessionRef.current),
              provider: isPlainShellRef.current ? 'plain-shell' : (selectedSessionRef.current?.__provider || readSelectedProvider()),
              cols: currentTerminal.cols,
              rows: currentTerminal.rows,
              initialCommand: initialCommandRef.current,
              isPlainShell: isPlainShellRef.current,
              forceRestart,
              // Launch-time flag: bypass mode can only join the CLI's
              // shift+tab cycle when claude starts with it.
              bypassPermissions: bypassPermissionsRef.current,
              // Launch-time too: a CLI picks its colours when it starts.
              colorScheme: isDarkModeRef.current ? 'dark' : 'light',
            });
          }, TERMINAL_INIT_DELAY_MS);
        };

        socket.onmessage = (event) => {
          if (!ownsSocket()) return;
          const rawPayload = typeof event.data === 'string' ? event.data : String(event.data ?? '');
          const message = parseShellMessage(rawPayload);
          if (message?.type === 'ready') {
            if (connectedWorkspace && (message.projectId !== connectedWorkspace.projectId || message.workspaceId !== connectedWorkspace.workspaceId || message.generation !== connectedWorkspace.generation || (connectedWorkspace.kind === 'session' && message.sessionId !== connectedWorkspace.sessionId))) {
              socket.close();
              return;
            }
            setTransport(message.transport === 'pipe' ? 'pipe' : 'pty');
            if (message.transport === 'pipe') terminalRef.current?.write(connectedWorkspace?.sourceMode === 'ssh'
              ? '\r\nWindows 命令：按 Enter 执行，每条命令从项目目录开始；不保留变量或目录切换，不支持全屏程序。Ctrl+C 停止当前命令。\r\n'
              : '\r\n基础命令终端：按 Enter 执行命令；不支持全屏程序或窗口调整。Ctrl+C 将结束此终端。\r\n');
            setIsConnected(true);
            setIsConnecting(false);
            connectingRef.current = false;
          } else if (message?.type === 'error') {
            setIsConnected(false);
            setIsConnecting(false);
            connectingRef.current = false;
            suppressAutoConnectRef.current = true;
          }
          handleSocketMessage(rawPayload);
        };

        socket.onclose = () => {
          if (!ownsSocket()) return;
          setIsConnected(false);
          setIsConnecting(false);
          setClaudeLaunchColorScheme(null);
          connectingRef.current = false;
          clearTerminalScreen();
        };

        socket.onerror = () => {
          if (!ownsSocket()) return;
          setIsConnected(false);
          setIsConnecting(false);
          connectingRef.current = false;
        };
      } catch {
        if (!ownsAttempt()) return;
        setIsConnected(false);
        setIsConnecting(false);
        connectingRef.current = false;
        forceRestartOnInitRef.current = false;
      }
    },
    [
      authSnapshot.sessionInstanceId,
      authSnapshot.serverKey,
      bypassPermissionsRef,
      clearTerminalScreen,
      fitAddonRef,
      handleSocketMessage,
      initialCommandRef,
      isConnected,
      isConnecting,
      isDarkModeRef,
      isPlainShellRef,
      selectedProjectRef,
      selectedSessionRef,
      terminalRef,
      wsRef,
    ],
  );

  const connectToShell = useCallback((options?: { forceRestart?: boolean }) => {
    if (getAuthSessionSnapshot().phase !== 'ready' || !isInitialized || isConnected || isConnecting || connectingRef.current) {
      return;
    }

    forceRestartOnInitRef.current = Boolean(options?.forceRestart);
    suppressAutoConnectRef.current = false;
    connectingRef.current = true;
    setIsConnecting(true);
    connectWebSocket(true);
  }, [connectWebSocket, isConnected, isConnecting, isInitialized]);

  const disconnectFromShell = useCallback((options?: { suppressAutoConnect?: boolean }) => {
    if (options?.suppressAutoConnect) {
      suppressAutoConnectRef.current = true;
    }

    ++connectionAttemptRef.current;
    closeSocket();
    clearTerminalScreen();
    setIsConnected(false);
    setIsConnecting(false);
    setClaudeLaunchColorScheme(null);
    connectingRef.current = false;
    forceRestartOnInitRef.current = false;
  }, [clearTerminalScreen, closeSocket]);

  useEffect(() => {
    ++connectionAttemptRef.current;
    connectingRef.current = false;
    setIsConnected(false);
    setIsConnecting(false);
    return () => {
      ++connectionAttemptRef.current;
      const socket = wsRef.current;
      if (socket) {
        socket.onopen = null; socket.onmessage = null; socket.onclose = null; socket.onerror = null;
        socket.close();
        wsRef.current = null;
      }
    };
  }, [authSnapshot.sessionInstanceId, authSnapshot.phase, transportVersion, workspace?.workspaceId, workspace?.generation, wsRef]);

  useEffect(() => {
    if (
      authSnapshot.phase !== 'ready' ||
      !autoConnect ||
      suppressAutoConnectRef.current ||
      !isInitialized ||
      isConnecting ||
      isConnected
    ) {
      return;
    }

    connectToShell();
  }, [authSnapshot.phase, transportVersion, autoConnect, connectToShell, isConnected, isConnecting, isInitialized]);

  return {
    isConnected,
    isConnecting,
    transport,
    claudeLaunchColorScheme,
    closeSocket,
    connectToShell,
    disconnectFromShell,
  };
}
