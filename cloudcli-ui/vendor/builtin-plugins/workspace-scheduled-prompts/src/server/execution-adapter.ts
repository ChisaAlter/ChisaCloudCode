import { spawn } from "node:child_process";
import type { ExecutionProfile, WorkspaceTask } from "../shared/model.js";

const OUTPUT_LIMIT = 4000;

export interface ExecutionRequestMetadata {
  [key: string]: unknown;
  command: string;
  args: string[];
  cwd: string;
  promptTransport: "stdin" | "argument";
}

export interface ExecutionResult {
  status: "succeeded" | "failed";
  outcomeSummary: string;
  failureReason: string | null;
  executionRequest: ExecutionRequestMetadata;
}

function trimCapturedOutput(output: string): string {
  const normalized = output.trim();
  if (!normalized) {
    return "";
  }
  return normalized.length > OUTPUT_LIMIT ? `${normalized.slice(0, OUTPUT_LIMIT)}...` : normalized;
}

function summarizeSuccess(stdout: string, stderr: string): string {
  const stdoutPreview = trimCapturedOutput(stdout);
  const stderrPreview = trimCapturedOutput(stderr);

  if (stdoutPreview) {
    return `Command completed successfully. stdout: ${stdoutPreview}`;
  }
  if (stderrPreview) {
    return `Command completed successfully with stderr output: ${stderrPreview}`;
  }
  return "Command completed successfully.";
}

function summarizeFailure(reason: string, stdout: string, stderr: string): string {
  const stdoutPreview = trimCapturedOutput(stdout);
  const stderrPreview = trimCapturedOutput(stderr);
  const details = [reason];
  if (stderrPreview) {
    details.push(`stderr: ${stderrPreview}`);
  }
  if (stdoutPreview) {
    details.push(`stdout: ${stdoutPreview}`);
  }
  return details.join(" | ");
}

function replaceTemplateTokens(input: string, task: WorkspaceTask, scheduledFor: string): string {
  return input
    .replaceAll("{{prompt}}", task.prompt)
    .replaceAll("{{workspacePath}}", task.workspacePath)
    .replaceAll("{{taskName}}", task.name)
    .replaceAll("{{taskId}}", task.id)
    .replaceAll("{{scheduledFor}}", scheduledFor);
}

function usesPromptTemplate(profile: ExecutionProfile): boolean {
  return profile.command.includes("{{prompt}}") || profile.args.some((entry) => entry.includes("{{prompt}}"));
}

function buildExecutionRequest(task: WorkspaceTask, profile: ExecutionProfile, scheduledFor: string): ExecutionRequestMetadata {
  return {
    command: replaceTemplateTokens(profile.command, task, scheduledFor),
    args: profile.args.map((entry) => replaceTemplateTokens(entry, task, scheduledFor)),
    cwd: task.workspacePath,
    promptTransport: usesPromptTemplate(profile) ? "argument" : "stdin"
  };
}

export class LocalExecutionAdapter {
  createRequest(task: WorkspaceTask, profile: ExecutionProfile, scheduledFor: string): ExecutionRequestMetadata {
    return buildExecutionRequest(task, profile, scheduledFor);
  }

  async execute(
    task: WorkspaceTask,
    profile: ExecutionProfile,
    scheduledFor: string,
    request = this.createRequest(task, profile, scheduledFor)
  ): Promise<ExecutionResult> {

    return new Promise<ExecutionResult>((resolve) => {
      let stdout = "";
      let stderr = "";
      let settled = false;

      const finalize = (result: ExecutionResult): void => {
        if (settled) {
          return;
        }
        settled = true;
        resolve(result);
      };

      let child;
      try {
        child = spawn(request.command, request.args, {
          cwd: request.cwd,
          env: {
            ...process.env,
            SCHEDULED_PROMPT: task.prompt,
            SCHEDULED_TASK_ID: task.id,
            SCHEDULED_TASK_NAME: task.name,
            SCHEDULED_WORKSPACE_PATH: task.workspacePath,
            SCHEDULED_FOR: scheduledFor
          },
          stdio: ["pipe", "pipe", "pipe"]
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : "Failed to launch local command.";
        finalize({
          status: "failed",
          outcomeSummary: summarizeFailure(reason, stdout, stderr),
          failureReason: reason,
          executionRequest: request
        });
        return;
      }

      const timeout = setTimeout(() => {
        child.kill("SIGTERM");
        finalize({
          status: "failed",
          outcomeSummary: summarizeFailure(`Command timed out after ${profile.timeoutMs}ms.`, stdout, stderr),
          failureReason: `Command timed out after ${profile.timeoutMs}ms.`,
          executionRequest: request
        });
      }, profile.timeoutMs);

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });

      child.on("error", (error) => {
        clearTimeout(timeout);
        finalize({
          status: "failed",
          outcomeSummary: summarizeFailure(error.message, stdout, stderr),
          failureReason: error.message,
          executionRequest: request
        });
      });

      child.on("close", (code, signal) => {
        clearTimeout(timeout);
        if (settled) {
          return;
        }
        if (code === 0) {
          finalize({
            status: "succeeded",
            outcomeSummary: summarizeSuccess(stdout, stderr),
            failureReason: null,
            executionRequest: request
          });
          return;
        }

        const reason = signal
          ? `Command terminated by signal ${signal}.`
          : `Command exited with code ${code ?? "unknown"}.`;
        finalize({
          status: "failed",
          outcomeSummary: summarizeFailure(reason, stdout, stderr),
          failureReason: reason,
          executionRequest: request
        });
      });

      if (request.promptTransport === "stdin") {
        child.stdin.write(task.prompt);
      }
      child.stdin.end();
    });
  }
}
