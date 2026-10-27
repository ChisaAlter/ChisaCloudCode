/** A validated quota window, always expressed as consumed percent and epoch milliseconds. */
export type ClaudeQuotaWindow = { kind: string; label: string; usedPercent: number; resetsAt: number | null; model: string | null };
/** Parse ISO/epoch seconds/epoch milliseconds without inventing a reset for invalid input. */
export function parseClaudeQuotaReset(value: unknown): number | null;
/** Read either supported Claude usage response family; missing windows stay absent. */
export function normalizeClaudeQuota(raw: unknown): ClaudeQuotaWindow[];
/** Optional extra usage uses cents in the provider response and currency units here. */
export function normalizeClaudeExtraUsage(raw: unknown): { enabled: boolean; spent: number | null; limit: number | null; balance: number | null; usedPercent: number | null; currency: string } | null;
