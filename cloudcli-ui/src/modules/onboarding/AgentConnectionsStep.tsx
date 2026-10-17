import { useTranslation } from 'react-i18next';

import type { LLMProvider, ProviderAuthStatusMap } from '@/shared/types';
import AgentConnectionCard from '@/modules/onboarding/AgentConnectionCard';

type AgentConnectionsStepProps = {
  providerStatuses: ProviderAuthStatusMap;
  onOpenProviderLogin: (provider: LLMProvider) => void;
};

const providerCards = [
  {
    provider: 'claude' as const,
    title: 'Claude Code',
    connectedClassName: 'bg-blue-50 dark:bg-blue-900/20 border-blue-200 dark:border-blue-800',
    iconContainerClassName: 'bg-blue-100 dark:bg-blue-900/30',
    loginButtonClassName: 'bg-blue-600 hover:bg-blue-700',
  },
  {
    provider: 'codex' as const,
    title: 'OpenAI Codex',
    connectedClassName: 'bg-gray-100 dark:bg-gray-800/50 border-gray-300 dark:border-gray-600',
    iconContainerClassName: 'bg-gray-100 dark:bg-gray-800',
    loginButtonClassName: 'bg-gray-800 hover:bg-gray-900 dark:bg-gray-700 dark:hover:bg-gray-600',
  },
];

/** Rendered by Onboarding as its second step, listing every CLI provider the user can log into. */
export default function AgentConnectionsStep({
  providerStatuses,
  onOpenProviderLogin,
}: AgentConnectionsStepProps) {
  const { t } = useTranslation('auth');
  return (
    <div className="space-y-4">
      <div className="text-center">
        <h2 className="font-serif text-xl font-bold tracking-tight text-foreground">{t('onboarding.agentsStepTitle')}</h2>
        <p className="mx-auto mt-1 max-w-sm text-sm leading-relaxed text-muted-foreground">
          {t('onboarding.agentsStepDescription')}
        </p>
      </div>

      <div className="-mr-1 max-h-[38vh] space-y-2 overflow-y-auto pr-1">
        {providerCards.map((providerCard) => (
          <AgentConnectionCard
            key={providerCard.provider}
            provider={providerCard.provider}
            title={providerCard.title}
            status={providerStatuses[providerCard.provider]}
            connectedClassName={providerCard.connectedClassName}
            iconContainerClassName={providerCard.iconContainerClassName}
            loginButtonClassName={providerCard.loginButtonClassName}
            onLogin={() => onOpenProviderLogin(providerCard.provider)}
          />
        ))}
      </div>

      <p className="text-center text-xs text-muted-foreground">{t('onboarding.agentsLaterHint')}</p>
    </div>
  );
}
