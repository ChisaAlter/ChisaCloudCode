/**
 * Claude Code refuses `--dangerously-skip-permissions` / bypassPermissions when
 * it runs as root ("cannot be used with root/sudo privileges") unless the
 * process declares it is already inside a sandbox via `IS_SANDBOX=1`.
 *
 * The server image runs as root inside its own container, and that container
 * is the sandbox boundary, so when this server itself runs as root we mark the
 * Claude subprocess environment accordingly. An operator-provided IS_SANDBOX
 * value (including an explicit opt-out such as `IS_SANDBOX=0`) is always kept.
 */
export type ClaudeSandboxEnvDependencies = {
  getuid?: (() => number) | undefined;
  platform?: NodeJS.Platform;
};

export function isRunningAsRoot(dependencies: ClaudeSandboxEnvDependencies = {}): boolean {
  const platform = dependencies.platform ?? process.platform;
  if (platform === 'win32') {
    return false;
  }
  const getuid = 'getuid' in dependencies ? dependencies.getuid : process.getuid?.bind(process);
  return typeof getuid === 'function' && getuid() === 0;
}

export function withClaudeRootSandboxEnv<T extends Record<string, string | undefined>>(
  env: T,
  dependencies: ClaudeSandboxEnvDependencies = {},
): T {
  if (env.IS_SANDBOX !== undefined || !isRunningAsRoot(dependencies)) {
    return env;
  }
  return { ...env, IS_SANDBOX: '1' };
}
