import { createHash } from "node:crypto";
import path from "node:path";

export function normalizeWorkspacePath(input: string): string {
  if (!input || !input.trim()) {
    throw new Error("workspacePath is required");
  }

  return path.resolve(input.trim());
}

export function workspaceKeyFromPath(workspacePath: string): string {
  const normalized = normalizeWorkspacePath(workspacePath);
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

export function projectNameFromWorkspacePath(workspacePath: string): string {
  return path.basename(normalizeWorkspacePath(workspacePath));
}
