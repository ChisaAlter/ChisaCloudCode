import fs, { promises as files } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { currentClaudeProjectConfigScope } from '@/modules/providers/services/claude-project-config-scope.service.js';
import { bridgeFileSystem } from '@/modules/workspace-bridge/index.js';
import type { FileTreeFileSystem } from '@/shared/index.js';
import { McpProvider } from '@/modules/providers/shared/mcp/mcp.provider.js';
import type { McpScope, ProviderMcpServer, UpsertProviderMcpServerInput } from '@/shared/types.js';
import {
  AppError,
  readJsonConfig,
  readObjectRecord,
  readOptionalString,
  readStringArray,
  readStringRecord,
  writeJsonConfig,
} from '@/shared/utils.js';

const nativeFiles: FileTreeFileSystem = {
  access: candidate => files.access(candidate), stat: candidate => files.stat(candidate), lstat: candidate => files.lstat(candidate),
  openDirectory: async function* (directory) { yield* await files.opendir(directory); }, realpath: candidate => files.realpath(candidate),
  readTextFile: candidate => files.readFile(candidate, 'utf8'), writeTextFile: (candidate, content) => files.writeFile(candidate, content, 'utf8'),
  makeDirectory: async (candidate, recursive) => { await files.mkdir(candidate, { recursive }); }, rename: (source, target) => files.rename(source, target),
  removeDirectory: candidate => files.rm(candidate, { recursive: true, force: true }), unlink: candidate => files.unlink(candidate),
  copyFile: (source, target) => files.copyFile(source, target), createReadStream: candidate => fs.createReadStream(candidate),
};
const workspaceFiles = bridgeFileSystem(nativeFiles);

export class ClaudeMcpProvider extends McpProvider {
  constructor() {
    super('claude', ['user', 'local', 'project'], ['stdio', 'http', 'sse']);
  }

  protected async readScopedServers(scope: McpScope, workspacePath: string): Promise<Record<string, unknown>> {
    const context = currentClaudeProjectConfigScope();
    if (scope !== 'user' && context && !context.descriptor) return {};
    if (scope === 'project') {
      const filePath = path.join(context?.descriptor?.rootPath ?? workspacePath, '.mcp.json');
      const config = await this.readConfig(filePath, true);
      return readObjectRecord(config.mcpServers) ?? {};
    }

    const filePath = path.join(context?.configDir ?? os.homedir(), '.claude.json');
    const config = await this.readConfig(filePath, false);
    if (scope === 'user') {
      return readObjectRecord(config.mcpServers) ?? {};
    }

    const projects = readObjectRecord(config.projects) ?? {};
    const projectConfig = readObjectRecord(projects[context?.descriptor?.sourceRoot ?? workspacePath]) ?? {};
    return readObjectRecord(projectConfig.mcpServers) ?? {};
  }

  protected async writeScopedServers(
    scope: McpScope,
    workspacePath: string,
    servers: Record<string, unknown>,
  ): Promise<void> {
    const context = currentClaudeProjectConfigScope();
    if (scope !== 'user' && context && !context.descriptor) throw new AppError('Select a project before changing its MCP configuration.', { code: 'WORKSPACE_SELECTOR_REQUIRED', statusCode: 400 });
    if (scope === 'project') {
      const filePath = path.join(context?.descriptor?.rootPath ?? workspacePath, '.mcp.json');
      const config = await this.readConfig(filePath, true);
      config.mcpServers = servers;
      await this.writeConfig(filePath, config, true);
      return;
    }

    const filePath = path.join(context?.configDir ?? os.homedir(), '.claude.json');
    const config = await this.readConfig(filePath, false);
    if (scope === 'user') {
      config.mcpServers = servers;
      await this.writeConfig(filePath, config, false);
      return;
    }

    const projects = readObjectRecord(config.projects) ?? {};
    const projectConfig = readObjectRecord(projects[context?.descriptor?.sourceRoot ?? workspacePath]) ?? {};
    projectConfig.mcpServers = servers;
    projects[context?.descriptor?.sourceRoot ?? workspacePath] = projectConfig;
    config.projects = projects;
    await this.writeConfig(filePath, config, false);
  }

  private async readConfig(filePath: string, project: boolean): Promise<Record<string, unknown>> {
    const context = currentClaudeProjectConfigScope();
    if (!context) return readJsonConfig(filePath);
    context.assertCurrent();
    const cached = context.snapshots.get(filePath);
    if (cached) return cached.config;
    try {
      const adapter = project ? workspaceFiles : nativeFiles;
      const stats = await adapter.lstat(filePath);
      context.assertCurrent();
      if (stats.isSymbolicLink() || stats.isDirectory() || stats.size > 256 * 1024) throw new Error('invalid');
      const snapshot = project ? await workspaceFiles.readTextSnapshot!(filePath) : { content: await files.readFile(filePath, 'utf8'), hash: undefined };
      context.assertCurrent();
      if (Buffer.byteLength(snapshot.content) > 256 * 1024) throw new Error('invalid');
      const config: unknown = JSON.parse(snapshot.content);
      if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('invalid');
      context.snapshots.set(filePath, { config: config as Record<string, unknown>, hash: snapshot.hash });
      return config as Record<string, unknown>;
    } catch (error) {
      context.assertCurrent();
      if (['ENOENT', 'ENOTDIR'].includes(String((error as NodeJS.ErrnoException).code))) {
        const config = {}; context.snapshots.set(filePath, { config, hash: null }); return config;
      }
      if (error instanceof AppError) throw error;
      throw new AppError('MCP configuration is invalid or cannot be read safely.', { code: 'MCP_CONFIG_INVALID', statusCode: 409 });
    }
  }

  private async writeConfig(filePath: string, config: Record<string, unknown>, project: boolean): Promise<void> {
    const context = currentClaudeProjectConfigScope();
    if (!context) return writeJsonConfig(filePath, config);
    context.assertCurrent();
    const content = JSON.stringify(config, null, 2) + '\n';
    if (Buffer.byteLength(content) > 256 * 1024) throw new AppError('MCP configuration exceeds its size limit.', { code: 'MCP_CONFIG_INVALID', statusCode: 400 });
    if (project) await workspaceFiles.writeTextSnapshot!(filePath, content, context.snapshots.get(filePath)?.hash);
    else await files.writeFile(filePath, content, 'utf8');
    context.assertCurrent();
  }

  protected buildServerConfig(input: UpsertProviderMcpServerInput): Record<string, unknown> {
    if (input.transport === 'stdio') {
      if (!input.command?.trim()) {
        throw new AppError('command is required for stdio MCP servers.', {
          code: 'MCP_COMMAND_REQUIRED',
          statusCode: 400,
        });
      }

      return {
        type: 'stdio',
        command: input.command,
        args: input.args ?? [],
        env: input.env ?? {},
      };
    }

    if (!input.url?.trim()) {
      throw new AppError('url is required for http/sse MCP servers.', {
        code: 'MCP_URL_REQUIRED',
        statusCode: 400,
      });
    }

    return {
      type: input.transport,
      url: input.url,
      headers: input.headers ?? {},
    };
  }

  protected normalizeServerConfig(
    scope: McpScope,
    name: string,
    rawConfig: unknown,
  ): ProviderMcpServer | null {
    if (!rawConfig || typeof rawConfig !== 'object') {
      return null;
    }

    const config = rawConfig as Record<string, unknown>;
    if (typeof config.command === 'string') {
      return {
        provider: 'claude',
        name,
        scope,
        transport: 'stdio',
        command: config.command,
        args: readStringArray(config.args),
        env: readStringRecord(config.env),
      };
    }

    if (typeof config.url === 'string') {
      const transport = readOptionalString(config.type) === 'sse' ? 'sse' : 'http';
      return {
        provider: 'claude',
        name,
        scope,
        transport,
        url: config.url,
        headers: readStringRecord(config.headers),
      };
    }

    return null;
  }
}
