import { claudeConnectionsService } from '@/modules/providers/services/claude-connections.service.js';
import { claudeAccountsService } from '@/modules/providers/services/claude-accounts.service.js';
import { providerRegistry } from '@/modules/providers/provider.registry.js';
import type { LLMProvider, ProviderAuthStatus } from '@/shared/types.js';
import { normalizeConnectionUserId } from '@/shared/utils.js';

/** Providers routes and runtime installation checks use native or saved connection availability. */
export const providerAuthService = {
  /**
   * Resolves a provider and returns its installation/authentication status.
   */
  async getProviderAuthStatus(providerName: string, userId?: unknown): Promise<ProviderAuthStatus> {
    const provider = providerRegistry.resolveProvider(providerName);
    const status = await provider.auth.getStatus();
    if (providerName === 'claude') {
      const id = normalizeConnectionUserId(userId);
      if (id) {
        const settings = claudeConnectionsService.getSettings(id);
        const activeConnection = settings.connections.find(connection => connection.id === settings.activeId);
        if (activeConnection) return { ...status, authenticated: true, email: activeConnection.name, method: 'model_connection', error: undefined };
        // Selected subscription auth belongs to the caller, never the service's global credential file.
        const selected = await claudeAccountsService.getSelectedAuthStatus(id);
        if (selected?.authenticated) return { ...status, ...selected };
        // Saved endpoints can supply the explicitly selected HiRoute model even before choosing an ordinary endpoint.
        if (settings.connections[0]) return { ...status, authenticated: true, email: settings.connections[0].name, method: 'model_connection', error: undefined };
        if (selected) return { ...status, ...selected };
      }
    }
    return status;
  },

  /**
   * Returns whether a provider runtime appears installed.
   * Falls back to true if status lookup itself fails so callers preserve the
   * original runtime error instead of replacing it with a status-check failure.
   */
  async isProviderInstalled(providerName: LLMProvider): Promise<boolean> {
    try {
      const status = await this.getProviderAuthStatus(providerName);
      return status.installed;
    } catch {
      return true;
    }
  },
};
