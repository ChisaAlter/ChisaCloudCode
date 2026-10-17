import type { PluginAPI } from "./types.js";
import { WorkspaceScheduledPromptsApp } from "./client/app.js";

const appInstances = new WeakMap<HTMLElement, WorkspaceScheduledPromptsApp>();

export async function mount(container: HTMLElement, api: PluginAPI): Promise<void> {
  const app = new WorkspaceScheduledPromptsApp(container, api);
  appInstances.set(container, app);
  await app.mount();

  const unsubscribe = api.onContextChange((context) => {
    void app.loadFromContext(context.project?.path ?? null);
  });
  (container as HTMLElement & { __cleanup?: () => void }).__cleanup = () => {
    unsubscribe();
    app.unmount();
  };
}

export function unmount(container: HTMLElement): void {
  (container as HTMLElement & { __cleanup?: () => void }).__cleanup?.();
  appInstances.delete(container);
}
