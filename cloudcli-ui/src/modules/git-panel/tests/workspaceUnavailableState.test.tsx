import assert from 'node:assert/strict';

import { fireEvent, render, screen } from '@testing-library/react';
import { test, vi } from 'vitest';

import GitRepositoryErrorState from '@/modules/git-panel/GitRepositoryErrorState';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

/**
 * A workspace that this desktop cannot reach used to put the raw transport
 * message ("Workspace connection unavailable") on screen as the only content,
 * with no action. The panel now names the cause and offers a retry.
 */

test('a workspace transport failure explains the cause and offers a retry', () => {
  const retry = vi.fn();

  render(
    <GitRepositoryErrorState
      error="Workspace connection unavailable"
      details={'{"operation":"git_read","transportCode":"ECONNREFUSED"}'}
      onRetry={retry}
    />,
  );

  assert.ok(screen.getByText('云端工作区暂不可用'));
  assert.ok(screen.getByText(/请确认账号服务在线，并刷新云端工作区状态后重试/));

  fireEvent.click(screen.getByRole('button', { name: '重试' }));
  assert.equal(retry.mock.calls.length, 1);
});

test('an unrelated git failure keeps its own message', () => {
  render(<GitRepositoryErrorState error="Git request failed (HTTP 500)" />);

  assert.ok(screen.getByText('Git request failed (HTTP 500)'));
  assert.equal(screen.queryByText('云端工作区暂不可用'), null);
});
