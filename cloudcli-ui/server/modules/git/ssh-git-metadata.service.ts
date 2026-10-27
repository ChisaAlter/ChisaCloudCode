import { resolveSshProjectTarget, runWorkspaceCommand } from '@/modules/workspace-bridge/index.js';
import { AppError } from '@/shared/index.js';

import { parseGitStatusOutput } from './git-parsing.service.js';

type GitCommandResult = { code: number; stdout: string; stderr: string };
type GitMetadata = { repository: GitCommandResult; branch?: GitCommandResult; head?: GitCommandResult; status?: GitCommandResult; branches?: GitCommandResult; remotes?: GitCommandResult; upstream?: GitCommandResult; counts?: GitCommandResult };

// Every argument below is server-owned. Neither repository data nor request data
// is evaluated as PowerShell or interpolated into an executable command string.
// Capture native stdout directly: PowerShell's native pipeline splits lines and
// would corrupt NUL porcelain records or filenames with embedded whitespace.
const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$gitPath = (Get-Command git.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
function Read-Git([string[]]$GitArguments) {
  $info = New-Object System.Diagnostics.ProcessStartInfo
  $info.FileName = $gitPath
  $info.Arguments = '--literal-pathspecs --no-optional-locks ' + ($GitArguments -join ' ')
  $info.WorkingDirectory = (Get-Location).ProviderPath
  $info.UseShellExecute = $false
  $info.CreateNoWindow = $true
  $info.RedirectStandardOutput = $true
  $info.RedirectStandardError = $true
  $info.StandardOutputEncoding = New-Object System.Text.UTF8Encoding($false)
  $info.StandardErrorEncoding = New-Object System.Text.UTF8Encoding($false)
  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $info
  try {
    [void]$process.Start()
    $stdout = $process.StandardOutput.ReadToEndAsync()
    $stderr = $process.StandardError.ReadToEndAsync()
    $process.WaitForExit()
    return @{code=$process.ExitCode;stdout=$stdout.GetAwaiter().GetResult();stderr=$stderr.GetAwaiter().GetResult()}
  } finally { $process.Dispose() }
}
try {
  $result = @{repository=(Read-Git @('rev-parse','--is-inside-work-tree','--show-toplevel'))}
  if ($result.repository.code -eq 0 -and $result.repository.stdout.StartsWith("true")) {
    $repositoryRoot = [IO.Path]::GetFullPath(($result.repository.stdout -replace '^true\r?\n','').Trim()).TrimEnd([char[]]'\/')
    $workingRoot = [IO.Path]::GetFullPath((Get-Location).ProviderPath).TrimEnd([char[]]'\/')
    if ($repositoryRoot -ine $workingRoot) {
      [Console]::Out.Write((ConvertTo-Json -InputObject $result -Compress -Depth 6))
      exit 0
    }
    if ($mode -ne 'branches') {
      $result.branch = Read-Git @('symbolic-ref','HEAD')
      if ($result.branch.code -ne 0) { $result.branch = Read-Git @('rev-parse','--abbrev-ref','HEAD') }
      $result.head = Read-Git @('rev-parse','--verify','HEAD')
    }
    if ($mode -eq 'status') { $result.status = Read-Git @('status','--porcelain=v1','-z') }
    elseif ($mode -eq 'branches') { $result.branches = Read-Git @('branch','-a') }
    elseif ($mode -eq 'remote-status') {
      $result.remotes = Read-Git @('remote')
      if ($result.head.code -eq 0) {
        $result.upstream = Read-Git @('rev-parse','--abbrev-ref','@{upstream}')
        if ($result.upstream.code -eq 0) { $result.counts = Read-Git @('rev-list','--count','--left-right','@{upstream}...HEAD') }
      }
    }
  }
  [Console]::Out.Write((ConvertTo-Json -InputObject $result -Compress -Depth 6))
  exit 0
} catch {
  [Console]::Error.Write($_.Exception.Message)
  exit 1
}
`;

function result(value: unknown): GitCommandResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AppError('Windows Git returned incomplete metadata.', { code: 'SSH_GIT_METADATA_INVALID', statusCode: 502 });
  const command = value as Record<string, unknown>;
  if (!Number.isInteger(command.code) || typeof command.stdout !== 'string' || typeof command.stderr !== 'string') throw new AppError('Windows Git returned invalid metadata.', { code: 'SSH_GIT_METADATA_INVALID', statusCode: 502 });
  return command as GitCommandResult;
}

function successful(value: unknown): GitCommandResult {
  const command = result(value);
  if (command.code !== 0) throw new AppError(command.stderr.trim() || `Git command failed with exit code ${command.code}`, { code: 'GIT_OPERATION_FAILED', statusCode: 500 });
  return command;
}

function branchAndHead(metadata: GitMetadata) {
  const branch = successful(metadata.branch).stdout.trim().replace(/^refs\/heads\//, '');
  const head = result(metadata.head);
  if (head.code !== 0 && !/unknown revision|ambiguous argument|needed a single revision|bad revision/i.test(head.stderr)) successful(head);
  return { branch, hasCommits: head.code === 0 };
}

/** Git panel routes use one SSH execution for trusted read metadata; cloud routes retain their existing command adapters. */
export async function readSshGitMetadata(projectPath: string, mode: 'status' | 'branches' | 'remote-status') {
  const target = resolveSshProjectTarget(projectPath);
  if (!target) return null;
  const script = `$mode = '${mode}'\n` + SCRIPT;
  const response = await runWorkspaceCommand(projectPath, 'powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64'),
  ], { readOnly: true });
  if (!response || response.exitCode !== 0 || response.truncated) throw new AppError(response?.stderr || 'Windows Git metadata execution failed.', { code: 'GIT_OPERATION_FAILED', statusCode: 502 });
  let metadata: GitMetadata;
  try { metadata = JSON.parse(response.stdout ?? '') as GitMetadata; }
  catch { throw new AppError('Windows Git returned an invalid metadata response.', { code: 'SSH_GIT_METADATA_INVALID', statusCode: 502 }); }
  const repository = result(metadata?.repository);
  if (repository.code !== 0 || !repository.stdout.startsWith('true\n') && !repository.stdout.startsWith('true\r\n')) {
    if (/not a git repository/i.test(repository.stderr) || repository.code === 0) throw new AppError('Not a git repository. Initialize a git repository with "git init" to use source control features.', { code: 'NOT_A_GIT_REPOSITORY', statusCode: 400 });
    successful(repository);
  }
  const repositoryRoot = repository.stdout.replace(/^true\r?\n/, '').trim().replace(/\\/g, '/').replace(/\/$/, '');
  const expectedRoot = target.rootPath.replace(/\\/g, '/').replace(/\/$/, '');
  // Match the existing single-command bridge check: do not inspect a parent or
  // foreign repository outside the exact bound Windows project root.
  if (repositoryRoot.toLowerCase() !== expectedRoot.toLowerCase()) throw new AppError('本地仓库根目录与已绑定项目不同。', { code: 'SSH_WORKSPACE_ROOT_MISMATCH', statusCode: 409 });
  if (mode === 'branches') {
    const rawLines = successful(metadata.branches).stdout.split('\n').map(line => line.trim()).filter(line => line && !line.includes('->'));
    const localBranches = rawLines.filter(line => !line.startsWith('remotes/')).map(line => line.replace(/^[*+] /, ''));
    const remoteBranches = rawLines.filter(line => line.startsWith('remotes/')).map(line => line.replace(/^remotes\/[^/]+\//, '')).filter(name => !localBranches.includes(name));
    return { branches: [...new Set([...localBranches, ...remoteBranches])], localBranches, remoteBranches };
  }
  const { branch, hasCommits } = branchAndHead(metadata);
  if (mode === 'status') return { branch, hasCommits, ...parseGitStatusOutput(successful(metadata.status).stdout) };
  const remotes = successful(metadata.remotes).stdout.trim().split('\n').filter(Boolean);
  const hasRemote = remotes.length > 0;
  const fallbackRemoteName = hasRemote ? remotes.includes('origin') ? 'origin' : remotes[0] : null;
  if (!hasCommits) return { hasRemote, hasUpstream: false, branch, remoteName: fallbackRemoteName, ahead: 0, behind: 0, isUpToDate: false, message: 'Repository has no commits yet' };
  const upstream = result(metadata.upstream);
  if (upstream.code !== 0) return { hasRemote, hasUpstream: false, branch, remoteName: fallbackRemoteName, message: 'No remote tracking branch configured' };
  const trackingBranch = upstream.stdout.trim();
  const counts = successful(metadata.counts).stdout.trim().split(/\s+/).map(Number);
  if (counts.length !== 2 || counts.some(count => !Number.isSafeInteger(count) || count < 0)) throw new AppError('Windows Git returned invalid ahead/behind counts.', { code: 'SSH_GIT_METADATA_INVALID', statusCode: 502 });
  const [behind, ahead] = counts;
  return { hasRemote: true, hasUpstream: true, branch, remoteBranch: trackingBranch, remoteName: trackingBranch.split('/')[0], ahead, behind, isUpToDate: ahead === 0 && behind === 0 };
}
