/** Current application context provided by the CloudCLI plugin host. */
export type PluginContext = {
  theme: 'dark' | 'light';
  project: { name: string; path: string } | null;
  session: { id: string; title: string } | null;
};

/** Host API passed to a CloudCLI tab plugin when it mounts. */
export type PluginAPI = {
  readonly context: PluginContext;
  onContextChange(callback: (context: PluginContext) => void): () => void;
  rpc(method: string, path: string, body?: unknown): Promise<unknown>;
};
