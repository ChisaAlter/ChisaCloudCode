import { providerRegistry } from '@/modules/providers/provider.registry.js';
import type { LLMProvider, McpScope, ProviderMcpServer, UpsertProviderMcpServerInput } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';
import { withWorkspaceWriteOperation } from '@/modules/workspace-bridge/index.js';

import { currentClaudeProjectConfigScope, withClaudeProjectConfigScope } from './claude-project-config-scope.service.js';


async function scoped<T>(providerName: string, context: { userId?: unknown; workspacePath?: string; projectId?: string; workspaceId?: string; generation?: string; sessionId?: string }, mutateProject: boolean, operation: () => Promise<T>): Promise<T> {
  if (providerName !== 'claude') return operation();
  return withClaudeProjectConfigScope(context, async () => {
    const scope = currentClaudeProjectConfigScope();
    if (mutateProject && scope?.descriptor) return withWorkspaceWriteOperation(scope.descriptor.rootPath, operation);
    return operation();
  });
}

export const providerMcpService = {
  /**
   * Lists MCP servers for one provider grouped by supported scopes.
   */
  async listProviderMcpServers(
    providerName: string,
    options?: { userId?: unknown; workspacePath?: string; projectId?: string; workspaceId?: string; generation?: string; sessionId?: string },
  ): Promise<Record<McpScope, ProviderMcpServer[]>> {
    const provider = providerRegistry.resolveProvider(providerName);
    return scoped(providerName, options ?? {}, false, () => provider.mcp.listServers(options));
  },

  /**
   * Lists MCP servers for one provider scope.
   */
  async listProviderMcpServersForScope(
    providerName: string,
    scope: McpScope,
    options?: { userId?: unknown; workspacePath?: string; projectId?: string; workspaceId?: string; generation?: string; sessionId?: string },
  ): Promise<ProviderMcpServer[]> {
    const provider = providerRegistry.resolveProvider(providerName);
    return scoped(providerName, options ?? {}, false, () => provider.mcp.listServersForScope(scope, options));
  },

  /**
   * Adds or updates one provider MCP server.
   */
  async upsertProviderMcpServer(
    providerName: string,
    input: UpsertProviderMcpServerInput,
    context: { userId?: unknown; projectId?: string; workspaceId?: string; generation?: string; sessionId?: string } = {},
  ): Promise<ProviderMcpServer> {
    const provider = providerRegistry.resolveProvider(providerName);
    return scoped(providerName, { ...context, workspacePath: input.workspacePath }, (input.scope ?? 'project') === 'project', () => provider.mcp.upsertServer(input));
  },

  /**
   * Removes one provider MCP server.
   */
  async removeProviderMcpServer(
    providerName: string,
    input: { name: string; scope?: McpScope; workspacePath?: string },
    context: { userId?: unknown; projectId?: string; workspaceId?: string; generation?: string; sessionId?: string } = {},
  ): Promise<{ removed: boolean; provider: LLMProvider; name: string; scope: McpScope }> {
    const provider = providerRegistry.resolveProvider(providerName);
    return scoped(providerName, { ...context, workspacePath: input.workspacePath }, (input.scope ?? 'project') === 'project', () => provider.mcp.removeServer(input));
  },

  /**
   * Adds one HTTP/stdio MCP server to every provider.
   */
  async addMcpServerToAllProviders(
    input: Omit<UpsertProviderMcpServerInput, 'scope'> & { scope?: Exclude<McpScope, 'local'> },
    context: { userId?: unknown; projectId?: string; workspaceId?: string; generation?: string; sessionId?: string } = {},
  ): Promise<Array<{ provider: LLMProvider; created: boolean; error?: string }>> {
    if (input.transport !== 'stdio' && input.transport !== 'http') {
      throw new AppError('Global MCP add supports only "stdio" and "http".', {
        code: 'INVALID_GLOBAL_MCP_TRANSPORT',
        statusCode: 400,
      });
    }

    const scope = input.scope ?? 'project';
    const results: Array<{ provider: LLMProvider; created: boolean; error?: string }> = [];
    const providers = providerRegistry.listProviders();
    for (const provider of providers) {
      try {
        await this.upsertProviderMcpServer(provider.id, { ...input, scope }, context);
        results.push({ provider: provider.id, created: true });
      } catch (error) {
        results.push({
          provider: provider.id,
          created: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }

    return results;
  },

  /**
   * Removes one MCP server from every provider. Mirrors `addMcpServerToAllProviders`
   * by iterating the live provider registry, so callers stay in sync with which
   * providers exist instead of maintaining their own provider list.
   */
  async removeMcpServerFromAllProviders(
    input: { name: string; scope?: McpScope; workspacePath?: string },
    context: { userId?: unknown; projectId?: string; workspaceId?: string; generation?: string; sessionId?: string } = {},
  ): Promise<Array<{ provider: LLMProvider; removed: boolean; error?: string }>> {
    const results: Array<{ provider: LLMProvider; removed: boolean; error?: string }> = [];
    const providers = providerRegistry.listProviders();
    for (const provider of providers) {
      try {
        const result = await this.removeProviderMcpServer(provider.id, input, context);
        results.push({ provider: provider.id, removed: result.removed });
      } catch (error) {
        results.push({
          provider: provider.id,
          removed: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }

    return results;
  },
};
