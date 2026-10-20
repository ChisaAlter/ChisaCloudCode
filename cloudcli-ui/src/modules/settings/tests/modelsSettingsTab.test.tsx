import { fireEvent, render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';

import ModelsSettingsTab from '@/modules/settings/tabs/models-settings/ModelsSettingsTab';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/modules/settings/tabs/models-settings/ModelConnectionsSection', () => ({ ModelConnectionsSection: () => <div>Direct form</div> }));
vi.mock('@/modules/settings/tabs/agents-settings/sections/content/HiRouteSettingsSection', () => ({ HiRouteSettingsSection: () => <div>Routing form</div> }));

test('switching connection mode unmounts the old form and reloads server settings on return', () => {
  render(<ModelsSettingsTab />);
  expect(screen.getByText('Direct form')).toBeTruthy();
  expect(screen.queryByText('Routing form')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'models.hiroute' }));
  expect(screen.queryByText('Direct form')).toBeNull();
  expect(screen.getByText('Routing form')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'models.direct' }));
  expect(screen.getByText('Direct form')).toBeTruthy();
  expect(screen.queryByText('Routing form')).toBeNull();
});
