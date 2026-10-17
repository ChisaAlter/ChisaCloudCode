import type { ExecutionProfileRequest } from "../../shared/contracts.js";
import type { ExecutionCapability, ExecutionProfile } from "../../shared/model.js";

export interface ExecutionBannerHandlers {
  onSave(request: Omit<ExecutionProfileRequest, "workspacePath">): void;
}

interface ExecutionPreset {
  key: string;
  label: string;
  command: string;
  args: string[];
  timeoutMs: number;
  note: string;
}

const EXECUTION_PRESETS: ExecutionPreset[] = [
  {
    key: "codex",
    label: "Codex",
    command: "codex",
    args: [
      "-a",
      "never",
      "exec",
      "--skip-git-repo-check",
      "--sandbox",
      "workspace-write"
    ],
    timeoutMs: 300000,
    note: "Uses stdin for the scheduled prompt. Suitable for fully local Codex automation."
  },
  {
    key: "claude_code",
    label: "Claude Code",
    command: "claude",
    args: [
      "-p",
      "{{prompt}}",
      "--output-format",
      "text",
      "--dangerously-skip-permissions"
    ],
    timeoutMs: 300000,
    note: "Sends the prompt as a direct CLI argument and disables permission prompts for headless runs."
  },
  {
    key: "gemini_cli",
    label: "Gemini CLI",
    command: "gemini",
    args: [
      "-p",
      "{{prompt}}",
      "--output-format",
      "text",
      "--yolo"
    ],
    timeoutMs: 300000,
    note: "Runs Gemini in headless mode with the prompt passed as an argument."
  }
];

function statusLabel(status: ExecutionCapability["status"]): string {
  switch (status) {
    case "ready":
      return "Ready";
    case "invalid":
      return "Action Needed";
    case "unsupported":
      return "Unsupported";
    default:
      return "Needs Config";
  }
}

function splitArgs(raw: string): string[] {
  return raw
    .split("\n")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function presetKeyForProfile(profile: ExecutionProfile | null): string {
  if (!profile) {
    return "";
  }
  const matched = EXECUTION_PRESETS.find((preset) =>
    preset.command === profile.command &&
    preset.timeoutMs === profile.timeoutMs &&
    preset.args.length === profile.args.length &&
    preset.args.every((entry, index) => entry === profile.args[index])
  );
  return matched?.key ?? "";
}

export function renderExecutionBanner(
  capability: ExecutionCapability,
  profile: ExecutionProfile | null,
  handlers: ExecutionBannerHandlers
): HTMLElement {
  const selectedPresetKey = presetKeyForProfile(profile);
  const section = document.createElement("section");
  section.className = `execution-banner status-${capability.status}`;
  section.innerHTML = `
    <div class="wsp-section-heading">
      <h2>Execution</h2>
      <p>Configure the local command that will receive each scheduled prompt.</p>
    </div>
    <div class="wsp-status-chip">${statusLabel(capability.status)}</div>
    <p>${capability.message}</p>
    <form class="wsp-form">
      <div class="wsp-field">
        <label for="wsp-exec-preset">Preset</label>
        <select id="wsp-exec-preset" name="preset">
          <option value="">Custom</option>
          ${EXECUTION_PRESETS.map((preset) => `<option value="${preset.key}"${selectedPresetKey === preset.key ? " selected" : ""}>${preset.label}</option>`).join("")}
        </select>
        <p>Select a preset to prefill a known local CLI configuration.</p>
      </div>
      <div class="wsp-form-grid">
        <div class="wsp-field wsp-field-span-2">
          <label for="wsp-exec-command">Command</label>
          <input
            id="wsp-exec-command"
            name="command"
            value="${profile?.command ?? ""}"
            placeholder="codex"
            required
          >
          <p>Executable name or absolute path launched inside the workspace.</p>
        </div>
        <div class="wsp-field wsp-field-span-2">
          <label for="wsp-exec-args">Arguments</label>
          <textarea
            id="wsp-exec-args"
            name="args"
            rows="5"
            placeholder="exec&#10;--json"
          >${(profile?.args ?? []).join("\n")}</textarea>
          <p>One argument per line. The prompt is always sent on stdin. Available templates: <code>{{prompt}}</code>, <code>{{workspacePath}}</code>, <code>{{taskName}}</code>, <code>{{taskId}}</code>, <code>{{scheduledFor}}</code>.</p>
        </div>
        <div class="wsp-field">
          <label for="wsp-exec-timeout">Timeout (ms)</label>
          <input
            id="wsp-exec-timeout"
            name="timeoutMs"
            type="number"
            min="1000"
            step="1000"
            value="${profile?.timeoutMs ?? 300000}"
          >
          <p>Maximum run duration before the command is terminated.</p>
        </div>
      </div>
      <div class="wsp-preview" data-testid="execution-preset-note">
        <strong>${EXECUTION_PRESETS.find((preset) => preset.key === selectedPresetKey)?.label ?? "Preset behavior"}</strong>
        <div>${EXECUTION_PRESETS.find((preset) => preset.key === selectedPresetKey)?.note ?? "Custom configuration."}</div>
      </div>
      <div class="wsp-preview">
        <strong>Runtime contract</strong>
        <div>The prompt is passed on <code>stdin</code> unless your command or args contain <code>{{prompt}}</code>, in which case the template is expanded inline.</div>
        <div>Environment variables include <code>SCHEDULED_PROMPT</code>, <code>SCHEDULED_WORKSPACE_PATH</code>, <code>SCHEDULED_TASK_NAME</code>, <code>SCHEDULED_TASK_ID</code>, and <code>SCHEDULED_FOR</code>.</div>
      </div>
      <div class="wsp-form-actions">
        <button type="submit">Save Execution Settings</button>
      </div>
    </form>
  `;

  const form = section.querySelector("form");
  const presetSelect = section.querySelector<HTMLSelectElement>('[name="preset"]');
  const commandInput = section.querySelector<HTMLInputElement>('[name="command"]');
  const argsInput = section.querySelector<HTMLTextAreaElement>('[name="args"]');
  const timeoutInput = section.querySelector<HTMLInputElement>('[name="timeoutMs"]');
  const presetNote = section.querySelector<HTMLElement>('[data-testid="execution-preset-note"]');
  if (!form) {
    throw new Error("Execution form failed to render");
  }
  if (!presetSelect || !commandInput || !argsInput || !timeoutInput || !presetNote) {
    throw new Error("Execution preset fields failed to render");
  }

  const applyPreset = (presetKey: string): void => {
    const preset = EXECUTION_PRESETS.find((entry) => entry.key === presetKey);
    if (!preset) {
      presetNote.innerHTML = "<strong>Preset behavior</strong><div>Custom configuration.</div>";
      return;
    }

    commandInput.value = preset.command;
    argsInput.value = preset.args.join("\n");
    timeoutInput.value = String(preset.timeoutMs);
    presetNote.innerHTML = `<strong>${preset.label}</strong><div>${preset.note}</div>`;
  };

  presetSelect.addEventListener("change", () => {
    applyPreset(presetSelect.value);
  });

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const formData = new FormData(form);
    handlers.onSave({
      command: String(formData.get("command") ?? "").trim(),
      args: splitArgs(String(formData.get("args") ?? "")),
      timeoutMs: Number(formData.get("timeoutMs") ?? 300000)
    });
  });

  return section;
}
