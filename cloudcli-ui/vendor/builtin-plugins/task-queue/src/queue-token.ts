// The plugin's task-queue-mcp client token, read from a fixed file under $HOME.
//
// Until v0.11.0 the plugin authenticated with TASK_QUEUE_API_SECRET, granted through the
// manifest's `env:` permission. That grant only works if the CloudCLI HOST process holds
// the value, and everything in the host's environment is inherited by every Claude session
// CloudCLI launches. So the one credential gating the queue's control API sat in the
// environment of every agent session on the host (vikunja#396).
//
// The token is therefore NOT an env var, and neither is its path. The host passes HOME to
// every plugin, so a fixed path under it needs no manifest grant, no host variable and no
// change to CloudCLI. The host never holds the token or knows where it is.
//
// This is containment, not a boundary: the file is readable by the user CloudCLI runs as,
// which is also the user its sessions run as. What it removes is the credential from every
// process's environment, and it makes this client's writes attributable (`channel:
// cloudcli`) and its token revocable on its own.

import fs from 'node:fs';
import path from 'node:path';

/** Where the token lives, relative to HOME. Documented in the README; do not make it an env var. */
export function tokenPath(home: string): string {
  return path.join(home, '.config', 'cloudcli-plugin-task-queue', 'token');
}

export type TokenResult =
  | { ok: true; token: string }
  | { ok: false; error: string };

interface TokenFs {
  openSync(p: string, flags: number): number;
  fstatSync(fd: number): { isFile(): boolean; mode: number };
  readFileSync(fd: number, enc: 'utf-8'): string;
  closeSync(fd: number): void;
  constants: { O_RDONLY: number; O_NOFOLLOW: number; O_NONBLOCK: number };
}

/**
 * Read and check the token file. Never throws, and no error message contains any of the
 * file's content: a file that fails a check may still hold a live token.
 *
 * Fails closed when the file is missing, is not a regular file, is empty, or carries ANY
 * group or other permission bit. A token file others can read is not one this plugin
 * should be quietly using; the fix is `chmod 600`, and the error says so.
 *
 * The checks and the read go through ONE file descriptor. Checking the path with stat()
 * and then reading the path again would let the file be swapped between the two, so the
 * bytes read would come from a file whose mode was never checked. O_NOFOLLOW refuses a
 * symlink at the final component, and O_NONBLOCK keeps a FIFO planted at the path from
 * hanging the open; fstat then rejects it as not a regular file.
 */
export function loadToken(file: string, fsImpl: TokenFs = fs): TokenResult {
  const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK } = fsImpl.constants;
  let fd: number;
  try {
    fd = fsImpl.openSync(file, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { ok: false, error: `task-queue token file ${file} is missing` };
    if (code === 'ELOOP') return { ok: false, error: `task-queue token file ${file} is a symlink` };
    return { ok: false, error: `task-queue token file ${file} is unreadable (${code ?? 'error'})` };
  }
  try {
    const st = fsImpl.fstatSync(fd);
    if (!st.isFile()) {
      return { ok: false, error: `task-queue token file ${file} is not a regular file` };
    }
    if ((st.mode & 0o077) !== 0) {
      const mode = (st.mode & 0o777).toString(8).padStart(3, '0');
      return {
        ok: false,
        error: `task-queue token file ${file} is accessible to group or others (mode ${mode}); chmod 600 it`,
      };
    }
    let text: string;
    try {
      text = fsImpl.readFileSync(fd, 'utf-8');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      return { ok: false, error: `task-queue token file ${file} is unreadable (${code ?? 'error'})` };
    }
    // Whitespace is trimmed so a trailing newline from `echo` or an editor does not become
    // part of the token. A token is URL-safe base64 and never contains whitespace.
    const token = text.trim();
    if (!token) {
      return { ok: false, error: `task-queue token file ${file} is empty` };
    }
    return { ok: true, token };
  } finally {
    try { fsImpl.closeSync(fd); } catch { /* already closed */ }
  }
}
