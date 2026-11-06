import { getAuthSessionSnapshot, isCurrentAuthSession } from '@/shared/authToken';
import { getServerTransportVersion } from '@/shared/chisa';
import { resolveWebSocketAdmissionUrl } from '@/shared/webSocketAdmission';

type ShellInitMessage = {
  type: 'init';
  projectPath: string;
  projectId?: string;
  workspaceId?: string;
  generation?: string;
  sessionId?: string | null;
  hasSession: boolean;
  provider: string;
  cols: number;
  rows: number;
  initialCommand: string | null | undefined;
  isPlainShell: boolean;
  forceRestart?: boolean;
  bypassPermissions?: boolean;
  // The app theme at launch, so the server can start a CLI in the colour scheme
  // the terminal is painted in.
  colorScheme?: 'light' | 'dark';
};

type ShellResizeMessage = {
  type: 'resize';
  cols: number;
  rows: number;
};

type ShellInputMessage = {
  type: 'input';
  data: string;
};

type ShellOutgoingMessage = ShellInitMessage | ShellResizeMessage | ShellInputMessage;

type ShellIncomingMessage =
  | { type: 'output'; data: string }
  // Sent instead of starting a PTY when the project path or session id is
  // rejected, so this is the only signal that the terminal will never start.
  | { type: 'error'; message?: string }
  | { type: 'auth_url'; url?: string }
  // The app theme the Claude CLI in the pty was launched for. A running CLI
  // keeps those colours, including one a reconnect reattaches to.
  | { type: 'claude_theme'; colorScheme?: string }
  | { type: string; [key: string]: unknown };

/** The shell hook waits for a one-use ticket or the native account capability before constructing its socket. */
export function getShellWebSocketUrl(): Promise<string> {
  return resolveWebSocketAdmissionUrl('/shell');
}

const shellSocketIdentities = new WeakMap<WebSocket, { session: ReturnType<typeof getAuthSessionSnapshot>; transport: number }>();

/** Hook binds every init/input/resize sender to the immutable account and transport that admitted its socket. */
export function bindShellSocketIdentity(socket: WebSocket): void {
  shellSocketIdentities.set(socket, { session: getAuthSessionSnapshot(), transport: getServerTransportVersion() });
}

export function parseShellMessage(payload: string): ShellIncomingMessage | null {
  try {
    return JSON.parse(payload) as ShellIncomingMessage;
  } catch {
    return null;
  }
}

export function sendSocketMessage(ws: WebSocket | null, message: ShellOutgoingMessage): void {
  if (ws && ws.readyState === WebSocket.OPEN) {
    const identity = shellSocketIdentities.get(ws);
    if (!identity || !isCurrentAuthSession(identity.session) || getAuthSessionSnapshot().phase !== 'ready'
      || identity.transport !== getServerTransportVersion()) { ws.close(); return; }
    ws.send(JSON.stringify(message));
  }
}
