import { IS_PLATFORM } from '@/shared/utils';
import type { LLMProvider } from '@/shared/types';

/**
 * Command the provider login modal runs in its shell.
 *
 * Claude login deliberately omits --dangerously-skip-permissions: /login needs
 * no tool permissions, and the flag makes the CLI refuse to start when the
 * server runs as root without IS_SANDBOX=1.
 */
export const CLAUDE_LOGIN_COMMAND = 'claude /login';

export const getProviderCommand = ({
  provider,
  customCommand,
}: {
  provider: LLMProvider;
  customCommand?: string;
  isAuthenticated?: boolean;
}) => {
  if (customCommand) {
    return customCommand;
  }

  if (provider === 'claude') {
    // Login needs no tool permissions. Keeping --dangerously-skip-permissions
    // here made the CLI exit before /login when the server runs as root.
    return CLAUDE_LOGIN_COMMAND;
  }

  if (provider === 'cursor') {
    return 'cursor-agent login';
  }

  if (provider === 'codex') {
    return IS_PLATFORM ? 'codex login --device-auth' : 'codex login';
  }

  if (provider === 'opencode') {
    return 'opencode auth login';
  }

  return CLAUDE_LOGIN_COMMAND;
};
