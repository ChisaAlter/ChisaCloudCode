import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/shared/ui';
import { ModelConnectionsSection } from '@/modules/settings/tabs/models-settings/ModelConnectionsSection';
import { HiRouteSettingsSection } from '@/modules/settings/tabs/agents-settings/sections/content/HiRouteSettingsSection';

/** Settings renders this shared desktop/web entry for Claude's model connections and HiRoute. */
export default function ModelsSettingsTab() {
  const { t } = useTranslation('settings');
  // Mount only the selected form so revisiting it reloads state after switching the active connection.
  const [mode, setMode] = useState<'direct' | 'hiroute'>('direct');

  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <h3 className="text-lg font-semibold">{t('models.title')}</h3>
        <p className="text-sm text-muted-foreground">{t('models.description')}</p>
      </div>
      <div className="flex flex-wrap gap-2" role="group" aria-label={t('models.mode')}>
        <Button variant={mode === 'direct' ? 'default' : 'outline'} aria-pressed={mode === 'direct'} onClick={() => setMode('direct')}>{t('models.direct')}</Button>
        <Button variant={mode === 'hiroute' ? 'default' : 'outline'} aria-pressed={mode === 'hiroute'} onClick={() => setMode('hiroute')}>{t('models.hiroute')}</Button>
      </div>
      {mode === 'direct' ? <ModelConnectionsSection /> : (
        <>
          <p className="text-sm text-muted-foreground">{t('models.hirouteHelp')}</p>
          <HiRouteSettingsSection />
        </>
      )}
    </div>
  );
}
