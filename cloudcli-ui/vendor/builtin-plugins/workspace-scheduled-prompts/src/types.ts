export interface PluginContext {
  theme: "dark" | "light";
  project: { name: string; path: string } | null;
  session: { id: string; title: string } | null;
}

export interface PluginAPI {
  context: PluginContext;
  onContextChange(listener: (context: PluginContext) => void): () => void;
  rpc<TResponse>(method: string, path: string, body?: unknown): Promise<TResponse>;
}

export interface PluginModule {
  mount(container: HTMLElement, api: PluginAPI): void | Promise<void>;
  unmount(container: HTMLElement): void | Promise<void>;
}
