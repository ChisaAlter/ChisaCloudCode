import path from 'path';
import { promises as fs } from 'fs';

const SYNC_FILE = '.GitHubBoard/github-sync.json';
// Fallback: TaskMaster stores the same GitHub credentials here. Reading it
// makes the "bidirectional TaskMaster sync" promise real and lets projects
// that were set up via TaskMaster work without duplicating config.
const TASKMASTER_SYNC_FILE = '.taskmaster/github-sync.json';

export interface GithubConfig {
  token: string;
  owner: string;
  repo: string;
  enabled: boolean;
  anthropicKey?: string;
}

async function readConfigFile(filePath: string): Promise<GithubConfig | null> {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    // TaskMaster files carry extra fields (webhookSecret, lastSync) — ignored here.
    const parsed = JSON.parse(content) as Partial<GithubConfig>;
    if (!parsed.token || !parsed.owner || !parsed.repo) return null;
    return {
      token: parsed.token,
      owner: parsed.owner,
      repo: parsed.repo,
      enabled: parsed.enabled !== false,
      anthropicKey: parsed.anthropicKey,
    };
  } catch {
    return null;
  }
}

export async function readConfig(projectPath: string): Promise<GithubConfig | null> {
  if (!projectPath) return null;
  // Prefer the plugin's own config; fall back to TaskMaster's.
  return (
    (await readConfigFile(path.join(projectPath, SYNC_FILE))) ??
    (await readConfigFile(path.join(projectPath, TASKMASTER_SYNC_FILE)))
  );
}

export async function writeConfig(projectPath: string, config: GithubConfig): Promise<void> {
  if (!projectPath) throw new Error('projectPath required');
  const dir = path.join(projectPath, '.GitHubBoard');
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(projectPath, SYNC_FILE);
  await fs.writeFile(filePath, JSON.stringify(config, null, 2), 'utf8');
}
