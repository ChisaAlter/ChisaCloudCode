import { claudeAccountsService } from '@/modules/providers/services/claude-accounts.service.js';
import { prepareClaudeUserHistory } from '@/modules/providers/services/claude-account-history.service.js';
import { claudeConnectionsService } from '@/modules/providers/services/claude-connections.service.js';
import type { ClaudeAccountLaunchSnapshot } from '@/shared/types.js';
import { AppError, requireConnectionUserId } from '@/shared/utils.js';

/** Plugins resolves history independently of login validity; only an authorized single-user default may read legacy global history. */
export async function resolveClaudeUsagePluginScope(userId: unknown, dependencies: {
  captureLaunch?: (id: number) => ClaudeAccountLaunchSnapshot | null;
  prepareHistory?: (id: number) => Promise<string>;
  hasApiConnection?: (id: number) => boolean;
} = {}): Promise<{ configDir: string; authDir: string; release(): void }> {
  const id = requireConnectionUserId(userId);
  let snapshot: ClaudeAccountLaunchSnapshot | null = null;
  try { snapshot = (dependencies.captureLaunch ?? ((value) => claudeAccountsService.captureLaunch(value)))(id); }
  catch (error) {
    // An idle expired/re-authenticating subscription cannot hide the user's independently owned transcript history.
    // Ownership/path failures remain errors rather than silently treating a tampered profile as legitimate.
    if (!(error instanceof AppError) || !['CLAUDE_ACCOUNT_SIGN_IN_REQUIRED', 'CLAUDE_ACCOUNT_IN_USE'].includes(error.code ?? '')) throw error;
  }
  try {
    const api = (dependencies.hasApiConnection ?? ((value) => Boolean(claudeConnectionsService.getActiveConnection(value))))(id);
    const configDir = snapshot?.accountId === 'default' && !api
      ? snapshot.configDir
      : await (dependencies.prepareHistory ?? prepareClaudeUserHistory)(id);
    let released = false;
    return { configDir, authDir: snapshot?.authDir ?? configDir,
      release() { if (released) return; released = true; snapshot?.release(); } };
  } catch (error) { snapshot?.release(); throw error; }
}

/** The server's shutdown coordinator stops outstanding browser/code login processes. */
export async function closeClaudeAccountLogins(): Promise<void> {
  await claudeAccountsService.dispose();
}
