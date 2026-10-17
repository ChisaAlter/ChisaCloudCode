import React, { createContext, useContext } from 'react';
import type { PluginAPI } from './types';

const PluginContext = createContext<PluginAPI | null>(null);

export const PluginProvider: React.FC<{ api: PluginAPI; children: React.ReactNode }> = ({ api, children }) => {
  return <PluginContext.Provider value={api}>{children}</PluginContext.Provider>;
};

export function usePluginAPI(): PluginAPI {
  const ctx = useContext(PluginContext);
  if (!ctx) throw new Error('usePluginAPI must be used inside PluginProvider');
  return ctx;
}
