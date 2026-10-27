import path from 'node:path';

import { projectsDb, sshProjectTargetsDb } from '@/modules/database/index.js';
import { isWorkspaceBound } from '@/modules/workspace-bridge/index.js';
import { AppError } from '@/shared/index.js';

import { projectSettingsService, type ProjectDefaultSettings } from './project-settings.service.js';

export type ProjectContextView = {
  projectId: string;
  sourceMode: 'cloud' | 'ssh';
  displayPath: string;
  execution: {
    provider: 'claude';
    location: 'vps' | 'local';
  };
  workspace: {
    mode: 'bridged' | 'direct';
    instructionPath: string;
  };
  instructions: {
    access: 'workspace-tool' | 'direct';
    note: string;
  };
  runtime: {
    settingSources: string[];
    autoMemory: boolean;
    strictMcpConfig: boolean;
    workspaceToolsOnly: boolean;
    effectiveMcpServers: string[];
  };
  defaults: ProjectDefaultSettings;
  notes: string[];
};

/**
 * Describes the context sources the selected project actually uses.
 *
 * This is a policy view, not a claim that the model has already read a file.
 * Bound cloud/SSH projects run through the workspace bridge, which replaces the
 * provider's project/user/local settings sources with the workspace tools.
 */
export const projectContextService = {
  get(projectId: string): ProjectContextView {
    const project = projectsDb.getProjectById(projectId);
    if (!project) {
      throw new AppError('Project not found', { code: 'PROJECT_NOT_FOUND', statusCode: 404 });
    }
    const target = sshProjectTargetsDb.getByProjectId(projectId);
    // An SSH project is always executed through the workspace bridge, even if a
    // transient binding file is unavailable; never describe its Windows path as
    // a directly readable VPS directory.
    const bound = Boolean(target) || isWorkspaceBound(project.project_path);
    const defaults = projectSettingsService.get(projectId).settings;
    const displayPath = target?.rootPath ?? project.project_path;
    const instructionPath = bound
      ? target
        ? 'CLAUDE.md'
        : '/workspace/CLAUDE.md'
      : path.join(project.project_path, 'CLAUDE.md');

    if (bound) {
      return {
        projectId,
        sourceMode: target ? 'ssh' : 'cloud',
        displayPath,
        execution: { provider: 'claude', location: 'vps' },
        workspace: { mode: 'bridged', instructionPath },
        instructions: {
          access: 'workspace-tool',
          note: target
            ? '云端 Claude 启动前，通过工作区通道读取本地指令、规则和支持的配置；源码与命令仍在 Windows。'
            : '云端 Claude 启动前，通过工作区通道解析指令和支持的配置；文件与命令仍在所选容器工作区。',
        },
        runtime: {
          settingSources: [],
          autoMemory: false,
          strictMcpConfig: true,
          workspaceToolsOnly: false,
          effectiveMcpServers: ['workspace', 'project_context', '每轮按配置选择已批准的 HTTP/SSE MCP'],
        },
        defaults,
        notes: [
          '运行前显式解析项目配置、指令和 Skills；原生文件配置来源保持关闭，避免把本地项目路径当作 VPS 源码。',
          '已选用的云端 HTTP/SSE MCP 与 workspace 工具共同装配；Windows stdio、本地端点、命令 Hooks 等未接入项会在运行清单中注明原因。',
          'MCP / Skills 的“已配置”、本轮“已加载”和 MCP“已连接”分别记录；以下清单属于最近一次运行，不代表模型已执行全部内容。',
        ],
      };
    }

    return {
      projectId,
      sourceMode: target ? 'ssh' : 'cloud',
      displayPath,
      execution: { provider: 'claude', location: 'local' },
      workspace: { mode: 'direct', instructionPath },
      instructions: {
        access: 'direct',
        note: 'Claude Code 直接在项目目录运行，按 provider 的项目/用户/本地设置来源读取。',
      },
      runtime: {
        settingSources: ['project', 'user', 'local'],
        autoMemory: true,
        strictMcpConfig: false,
        workspaceToolsOnly: false,
        effectiveMcpServers: ['由项目/用户/本地配置决定'],
      },
      defaults,
      notes: [
        '当前项目未绑定工作区桥接，MCP、Hooks、Skills 和指令文件来自 Claude Code 的直接配置。',
        '本面板不会修改任何配置，也不会触发文件读取。',
      ],
    };
  },
};
