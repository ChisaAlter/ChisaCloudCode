import path from 'node:path';
import fs, { promises as fsPromises } from 'node:fs';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';

import { bridgeFileSystem } from '@/modules/workspace-bridge/index.js';
import type {
  FileTreeFileSystem,
  IProviderSkills,
  LLMProvider,
  ProviderSkillCreateInput,
  ProviderSkillRemoveInput,
  ProviderSkill,
  ProviderSkillListOptions,
  ProviderSkillSource,
} from '@/shared/index.js';
import {
  findProviderSkillMarkdownFiles,
  readOptionalString,
  readProviderSkillMarkdownDefinitionFromContent,
  readProviderSkillMarkdownDefinition,
  AppError,
} from '@/shared/index.js';

const nativeFiles: FileTreeFileSystem = {
  access: candidate => fsPromises.access(candidate),
  stat: candidate => fsPromises.stat(candidate),
  lstat: candidate => fsPromises.lstat(candidate),
  openDirectory: async function* (directory) { yield* await fsPromises.opendir(directory); },
  realpath: candidate => fsPromises.realpath(candidate),
  readTextFile: candidate => fsPromises.readFile(candidate, 'utf8'),
  writeTextFile: (candidate, content) => fsPromises.writeFile(candidate, content, 'utf8'),
  makeDirectory: async (candidate, recursive) => { await fsPromises.mkdir(candidate, { recursive }); },
  rename: (source, target) => fsPromises.rename(source, target),
  removeDirectory: candidate => fsPromises.rm(candidate, { recursive: true, force: true }),
  unlink: candidate => fsPromises.unlink(candidate),
  copyFile: (source, target) => fsPromises.copyFile(source, target),
  createReadStream: candidate => fs.createReadStream(candidate),
};
const workspaceFiles = bridgeFileSystem(nativeFiles);

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

function privatePath(relative: string): boolean {
  return relative.split(/[\\/]/).some(part => part.toLowerCase().startsWith('.chisa-'));
}

function skippablePath(error: unknown): boolean {
  return ['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'PROVIDER_SKILL_PATH_DENIED'].includes(String((error as NodeJS.ErrnoException)?.code));
}

/** Reads only canonical, nonsymlink descendants of the server-resolved root. */
async function readWorkspaceSkills(
  source: ProviderSkillSource,
  options: ProviderSkillListOptions,
): Promise<Array<{ skillPath: string; name: string; description: string }>> {
  const root = options.workspaceDescriptor!.rootPath;
  const files = workspaceFiles;
  const assertCurrent = options.assertWorkspace ?? (() => {});
  const checked = async <T>(operation: () => Promise<T>): Promise<T> => {
    assertCurrent();
    try { return await operation(); }
    finally { assertCurrent(); }
  };
  const denied = () => new AppError('Skill files must stay inside the selected workspace without symbolic links.', { code: 'PROVIDER_SKILL_PATH_DENIED', statusCode: 403 });
  const safePath = async (candidate: string) => {
    const relative = path.relative(root, candidate);
    if (!inside(root, candidate) || privatePath(relative)) throw denied();
    let current = root;
    const ancestors = relative.split(path.sep).map(part => { current = path.join(current, part); return current; });
    // Batch metadata within this check, never across the content read: post-read
    // link, canonical-path and workspace-generation checks remain fresh.
    const results = await Promise.allSettled(ancestors.map(ancestor => checked(() => files.lstat(ancestor))));
    const stats = results.map(result => {
      if (result.status === 'rejected') throw result.reason;
      if (result.value.isSymbolicLink()) throw denied();
      return result.value;
    });
    const [canonicalRoot, canonical] = await Promise.all([checked(() => files.realpath(root)), checked(() => files.realpath(candidate))]);
    if (!inside(canonicalRoot, canonical) || privatePath(path.relative(canonicalRoot, canonical))) throw denied();
    return stats[stats.length - 1]!;
  };
  const definitions: Array<{ skillPath: string; name: string; description: string }> = [];
  async function readDefinition(directory: string) {
    const skillPath = path.join(directory, 'SKILL.md');
    try {
      const stats = await safePath(skillPath);
      // Older bridge workers return permission bits only; local fs includes the file type.
      const kind = stats.mode & 0o170000;
      if (stats.isDirectory() || (kind !== 0 && kind !== 0o100000)) return;
      const content = await checked(() => files.readTextFile(skillPath));
      await safePath(skillPath);
      // Malformed markdown is skipped; identity and filesystem failures escape.
      let definition: { name: string; description: string };
      try { definition = readProviderSkillMarkdownDefinitionFromContent(content, path.basename(directory)); }
      catch { return; }
      definitions.push({ skillPath, ...definition });
    } catch (error) {
      if (!skippablePath(error)) throw error;
    }
  }
  async function visit(directory: string, includeSkill: boolean, descend: boolean) {
    try {
      const stats = await safePath(directory);
      if (!stats.isDirectory()) return;
      if (includeSkill) await readDefinition(directory);
      if (!descend) return;
      const entries = await checked(async () => {
        const found = [];
        for await (const entry of files.openDirectory(directory)) found.push(entry);
        return found;
      });
      await safePath(directory);
      for (const entry of entries) {
        if (!entry.name || entry.name === '.' || entry.name === '..' || /[\\/]/.test(entry.name) || privatePath(entry.name)) continue;
        await visit(path.join(directory, entry.name), true, source.recursive === true);
      }
    } catch (error) {
      if (!skippablePath(error)) throw error;
    }
  }
  await visit(source.rootDir, source.recursive === true, true);
  return definitions.sort((left, right) => left.skillPath.localeCompare(right.skillPath));
}

const resolveWorkspacePath = (workspacePath?: string): string =>
  path.resolve(workspacePath ?? process.cwd());

const stripMarkdownExtension = (value: string): string => value.replace(/\.md$/i, '');

const normalizeSkillDirectoryName = (value: string): string => (
  value
    .trim()
    .replace(/[\\/]+/g, '-')
    .replace(/[<>:"|?*\x00-\x1F]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^\.+|\.+$/g, '')
    .replace(/^-+|-+$/g, '')
);

type PendingSkillInstall = {
  skillDirectoryPath: string;
  skillPath: string;
  content: string;
  supportingFiles: Array<{
    targetPath: string;
    content: string | Buffer;
  }>;
  skill: ProviderSkill;
};

const resolveSkillSupportingFilePath = (
  skillDirectoryPath: string,
  relativePath: string,
  entryIndex: number,
): string => {
  const normalizedRelativePath = relativePath.trim().replace(/\\/g, '/');
  const pathSegments = normalizedRelativePath.split('/');
  if (
    !normalizedRelativePath
    || path.isAbsolute(normalizedRelativePath)
    || pathSegments.some((segment) => !segment || segment === '.' || segment === '..')
    || normalizedRelativePath.toLowerCase() === 'skill.md'
  ) {
    throw new AppError(
      `Skill entry ${entryIndex + 1} includes an invalid supporting file path "${relativePath}".`,
      {
        code: 'PROVIDER_SKILL_FILE_PATH_INVALID',
        statusCode: 400,
      },
    );
  }

  const resolvedSkillDirectoryPath = path.resolve(skillDirectoryPath);
  const resolvedFilePath = path.resolve(resolvedSkillDirectoryPath, ...pathSegments);
  if (!resolvedFilePath.startsWith(`${resolvedSkillDirectoryPath}${path.sep}`)) {
    throw new AppError(
      `Skill entry ${entryIndex + 1} supporting files must stay inside the skill directory.`,
      {
        code: 'PROVIDER_SKILL_FILE_PATH_INVALID',
        statusCode: 400,
      },
    );
  }

  return resolvedFilePath;
};

/**
 * Shared skills provider for provider-specific skill source discovery.
 */
export abstract class SkillsProvider implements IProviderSkills {
  protected readonly provider: LLMProvider;

  protected constructor(provider: LLMProvider) {
    this.provider = provider;
  }

  async listSkills(options?: ProviderSkillListOptions): Promise<ProviderSkill[]> {
    const workspacePath = resolveWorkspacePath(options?.workspaceDescriptor?.rootPath ?? options?.workspacePath);
    options?.assertWorkspace?.();
    const sources = await this.getSkillSources(workspacePath);
    options?.assertWorkspace?.();
    const skills: ProviderSkill[] = [];

    for (const source of sources) {
      const projectSource = source.scope === 'project' || source.scope === 'repo';
      if (projectSource && (options?.globalOnly || (options?.workspaceDescriptor && !inside(workspacePath, source.rootDir)))) continue;
      options?.assertWorkspace?.();
      const definitions = options?.workspaceDescriptor && projectSource
        ? await readWorkspaceSkills(source, options)
        : await this.readUnscopedSkills(source);
      options?.assertWorkspace?.();
      for (const { skillPath, name, description } of definitions) {
        skills.push({
          provider: this.provider,
          name,
          description,
          command: source.commandForSkill ? source.commandForSkill(name) : `${source.commandPrefix ?? '/'}${name}`,
          scope: source.scope,
          sourcePath: skillPath,
          pluginName: source.pluginName,
          pluginId: source.pluginId,
        });
      }
    }

    return skills;
  }

  private async readUnscopedSkills(source: ProviderSkillSource) {
    const definitions: Array<{ skillPath: string; name: string; description: string }> = [];
    for (const skillPath of await findProviderSkillMarkdownFiles(source.rootDir, { recursive: source.recursive })) {
      try { definitions.push({ skillPath, ...await readProviderSkillMarkdownDefinition(skillPath) }); }
      catch { /* An unreadable global/legacy skill must not hide its siblings. */ }
    }
    return definitions;
  }

  async addSkills(input: ProviderSkillCreateInput): Promise<ProviderSkill[]> {
    const globalSkillSource = await this.getGlobalSkillSource();
    if (!globalSkillSource) {
      throw new AppError(`${this.provider} does not support managed global skills.`, {
        code: 'PROVIDER_SKILLS_WRITE_UNSUPPORTED',
        statusCode: 400,
      });
    }

    if (!Array.isArray(input.entries) || input.entries.length === 0) {
      throw new AppError('At least one skill entry is required.', {
        code: 'PROVIDER_SKILLS_REQUIRED',
        statusCode: 400,
      });
    }

    const seenSkillPaths = new Set<string>();
    const pendingInstalls: PendingSkillInstall[] = [];

    for (const [index, entry] of input.entries.entries()) {
      const content = typeof entry.content === 'string' ? entry.content.trim() : '';
      if (!content) {
        throw new AppError(`Skill entry ${index + 1} must include markdown content.`, {
          code: 'PROVIDER_SKILL_CONTENT_REQUIRED',
          statusCode: 400,
        });
      }

      const fileNameFallback = readOptionalString(entry.fileName);
      const requestedDirectoryName = readOptionalString(entry.directoryName);
      const fallbackSkillName = normalizeSkillDirectoryName(
        requestedDirectoryName
          ?? (fileNameFallback ? stripMarkdownExtension(fileNameFallback) : `skill-${index + 1}`),
      );
      const definition = readProviderSkillMarkdownDefinitionFromContent(content, fallbackSkillName);
      const resolvedDirectoryName = normalizeSkillDirectoryName(
        requestedDirectoryName ?? definition.name,
      );

      if (!resolvedDirectoryName) {
        throw new AppError(`Skill entry ${index + 1} must include a valid skill name.`, {
          code: 'PROVIDER_SKILL_NAME_REQUIRED',
          statusCode: 400,
        });
      }

      const skillDirectoryPath = path.join(globalSkillSource.rootDir, resolvedDirectoryName);
      const skillPath = path.join(skillDirectoryPath, 'SKILL.md');
      const normalizedSkillPath = path.resolve(skillPath);
      if (seenSkillPaths.has(normalizedSkillPath)) {
        throw new AppError(`Duplicate skill target "${resolvedDirectoryName}" in one request.`, {
          code: 'PROVIDER_SKILL_DUPLICATE_TARGET',
          statusCode: 400,
        });
      }

      seenSkillPaths.add(normalizedSkillPath);
      const supportingFiles = (entry.files ?? []).map((file) => ({
        targetPath: resolveSkillSupportingFilePath(skillDirectoryPath, file.relativePath, index),
        content: file.encoding === 'base64'
          ? Buffer.from(file.content, 'base64')
          : file.content,
      }));
      const seenSupportingPaths = new Set<string>();
      for (const file of supportingFiles) {
        if (seenSupportingPaths.has(file.targetPath)) {
          throw new AppError(`Skill entry ${index + 1} includes a duplicate supporting file path.`, {
            code: 'PROVIDER_SKILL_DUPLICATE_FILE',
            statusCode: 400,
          });
        }
        seenSupportingPaths.add(file.targetPath);
      }

      const command = globalSkillSource.commandForSkill
        ? globalSkillSource.commandForSkill(definition.name)
        : `${globalSkillSource.commandPrefix ?? '/'}${definition.name}`;

      pendingInstalls.push({
        skillDirectoryPath,
        skillPath,
        content,
        supportingFiles,
        skill: {
          provider: this.provider,
          name: definition.name,
          description: definition.description,
          command,
          scope: globalSkillSource.scope,
          sourcePath: skillPath,
          pluginName: globalSkillSource.pluginName,
          pluginId: globalSkillSource.pluginId,
        },
      });
    }

    for (const install of pendingInstalls) {
      // Replace the complete skill directory so removed scripts or assets do not remain stale.
      await rm(install.skillDirectoryPath, { recursive: true, force: true });
      await mkdir(install.skillDirectoryPath, { recursive: true });
      await writeFile(install.skillPath, `${install.content}\n`, 'utf8');
      for (const file of install.supportingFiles) {
        await mkdir(path.dirname(file.targetPath), { recursive: true });
        await writeFile(file.targetPath, file.content);
      }
    }

    return pendingInstalls.map((install) => install.skill);
  }

  async removeSkill(
    input: ProviderSkillRemoveInput,
  ): Promise<{ removed: boolean; provider: LLMProvider; directoryName: string }> {
    const globalSkillSource = await this.getGlobalSkillSource();
    if (!globalSkillSource) {
      throw new AppError(`${this.provider} does not support managed global skills.`, {
        code: 'PROVIDER_SKILLS_WRITE_UNSUPPORTED',
        statusCode: 400,
      });
    }

    const directoryName = normalizeSkillDirectoryName(input.directoryName);
    if (!directoryName) {
      throw new AppError('Skill directoryName is required.', {
        code: 'PROVIDER_SKILL_DIRECTORY_REQUIRED',
        statusCode: 400,
      });
    }

    const skillDirectoryPath = path.join(globalSkillSource.rootDir, directoryName);
    const resolvedRoot = path.resolve(globalSkillSource.rootDir);
    const resolvedSkillDirectoryPath = path.resolve(skillDirectoryPath);
    if (
      resolvedSkillDirectoryPath !== resolvedRoot
      && !resolvedSkillDirectoryPath.startsWith(`${resolvedRoot}${path.sep}`)
    ) {
      throw new AppError('Skill directory must stay inside the managed skill root.', {
        code: 'PROVIDER_SKILL_DIRECTORY_INVALID',
        statusCode: 400,
      });
    }

    const removed = await stat(resolvedSkillDirectoryPath)
      .then((stats) => stats.isDirectory())
      .catch(() => false);
    if (removed) {
      await rm(resolvedSkillDirectoryPath, { recursive: true, force: true });
    }

    return { removed, provider: this.provider, directoryName };
  }

  protected abstract getSkillSources(workspacePath: string): Promise<ProviderSkillSource[]>;

  protected async getGlobalSkillSource(): Promise<ProviderSkillSource | null> {
    return null;
  }
}
