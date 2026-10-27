import { Check, ChevronLeft, ChevronRight, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/shared/ui';
import type { SshExistingProject, WizardStep } from '@/shared/types';

type WizardFooterProps = {
  step: WizardStep;
  isCreating: boolean;
  isCloneWorkflow: boolean;
  existingProject?: SshExistingProject;
  onClose: () => void;
  onBack: () => void;
  onNext: () => void;
  onCreate: () => void;
};

/** Rendered by ProjectCreationWizard to provide its cancel, back, next and create actions. */
export default function WizardFooter({
  step,
  isCreating,
  isCloneWorkflow,
  existingProject,
  onClose,
  onBack,
  onNext,
  onCreate,
}: WizardFooterProps) {
  const { t } = useTranslation();

  return (
    <div className="flex items-center justify-between border-t border-gray-200 p-6 dark:border-gray-700">
      <Button variant="outline" onClick={step === 1 ? onClose : onBack} disabled={isCreating}>
        {step === 1 ? (
          t('projectWizard.buttons.cancel')
        ) : (
          <>
            <ChevronLeft className="mr-1 h-4 w-4" />
            {t('projectWizard.buttons.back')}
          </>
        )}
      </Button>

      <Button onClick={existingProject || step === 2 ? onCreate : onNext} disabled={isCreating}>
        {isCreating ? (
          <>
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            {existingProject ? (existingProject.isArchived ? '正在恢复并打开…' : '正在打开…') : isCloneWorkflow
              ? t('projectWizard.buttons.cloning', { defaultValue: 'Cloning...' })
              : t('projectWizard.buttons.creating')}
          </>
        ) : existingProject ? (
          <>{existingProject.isArchived ? '恢复并打开项目' : '打开已有项目'}</>
        ) : step === 2 ? (
          <>
            <Check className="mr-1 h-4 w-4" />
            {t('projectWizard.buttons.createProject')}
          </>
        ) : (
          <>
            {t('projectWizard.buttons.next')}
            <ChevronRight className="ml-1 h-4 w-4" />
          </>
        )}
      </Button>
    </div>
  );
}
