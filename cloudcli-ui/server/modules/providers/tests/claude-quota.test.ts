import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeClaudeExtraUsage, normalizeClaudeQuota, parseClaudeQuotaReset } from '../../../../shared/claude-quota.js';
import { normalizeUsage } from '../../../../vendor/builtin-plugins/claude-usage/src/live.js';

test('Claude named and limits-array quota responses yield the same main windows', () => {
  const resets = '2026-10-26T14:00:00.000Z';
  const named = { five_hour: { utilization: 42, resets_at: resets }, seven_day: { used_percentage: 17, resets_at: 1793109600 } };
  const array = { limits: [{ kind: 'session', percent: 42, resets_at: resets }, { kind: 'weekly_all', percent: 17, resets_at: 1793109600000 }] };
  assert.deepEqual(normalizeClaudeQuota(named), normalizeClaudeQuota(array));
  assert.equal(normalizeUsage(named, 'max', null).limits.length, 2);
  assert.equal(normalizeUsage(named, 'max', null).limits[0].resetsAt, resets);
});

test('partial windows, explicit zero, invalid numbers, models and duplicate schemas stay distinct', () => {
  const windows = normalizeClaudeQuota({
    five_hour: { utilization: 0 }, seven_day: { utilization: NaN },
    seven_day_opus: { utilization: 150 }, seven_day_sonnet: { utilization: -3 },
    fable_weekly: { utilization: 15 }, seven_day_fable: { utilization: 25 },
    limits: [{ kind: 'session', percent: 95 }, { kind: 'weekly_scoped', percent: 30, scope: { model: { display_name: 'Opus' } } },
      { kind: 'weekly_scoped', percent: 50, scope: { model: { display_name: 'Other model' } } },
      { kind: 'weekly_all', percent: Infinity }, { kind: 'bad', percent: '20' }, null],
  });
  assert.deepEqual(windows.map(window => [window.kind, window.model, window.usedPercent]), [
    ['session', null, 0], ['weekly_scoped', 'Opus', 100], ['weekly_scoped', 'Sonnet', 0],
    ['weekly_scoped', 'Fable', 15], ['weekly_scoped', 'Other model', 50],
  ]);
  assert.deepEqual(normalizeClaudeQuota(null), []);
  assert.deepEqual(normalizeClaudeQuota({ limits: [{ kind: 'session' }] }), []);
  assert.deepEqual(normalizeClaudeQuota({ five_hour: null, seven_day: {} }), []);
});

test('reset parser accepts both epochs and rejects invalid and out-of-range values', () => {
  assert.equal(parseClaudeQuotaReset(1793109600), 1793109600000);
  assert.equal(parseClaudeQuotaReset('1793109600000'), 1793109600000);
  assert.equal(parseClaudeQuotaReset('2026-10-26T14:00:00Z'), 1793023200000);
  for (const input of [NaN, Infinity, -1, 9e19, 'not a date', '', ' ', null]) assert.equal(parseClaudeQuotaReset(input), null);
});

test('extra usage uses cents, distinguishes zero limit from unknown, and never invents quota', () => {
  assert.equal(normalizeClaudeExtraUsage({}), null);
  assert.deepEqual(normalizeClaudeExtraUsage({ extra_usage: { is_enabled: true, monthly_limit: 1000, used_credits: 350 } }), {
    enabled: true, spent: 3.5, limit: 10, balance: 6.5, usedPercent: 35, currency: 'USD',
  });
  const unknown = normalizeClaudeExtraUsage({ extra_usage: { is_enabled: false, monthly_limit: 0 } });
  assert.equal(unknown?.usedPercent, null);
  assert.equal(unknown?.spent, null);
  assert.equal(unknown?.limit, 0);
});
