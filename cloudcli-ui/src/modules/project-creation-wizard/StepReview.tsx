import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { isSshGitUrl } from '@/modules/project-creation-wizard/utils/pathUtils';
import type { SshWorkspaceProbe, WizardFormState } from '@/shared/types';

type StepReviewProps = {
  formState: WizardFormState;
  selectedTokenName: string | null;
  isCreating: boolean;
  cloneProgress: string;
  sshProbe?: SshWorkspaceProbe;
  connectionLabel?: string;
};

/** Rendered by ProjectCreationWizard as step 2, summarising the chosen configuration and streaming clone progress. */
export default function StepReview({
  formState,
  selectedTokenName,
  isCreating,
  cloneProgress,
  sshProbe,
  connectionLabel,
}: StepReviewProps) {
  const { t } = useTranslation();

  const authenticationLabel = useMemo(() => {
    if (formState.tokenMode === 'stored' && formState.selectedGithubToken) {
      return `${t('projectWizard.step3.usingStoredToken')} ${selectedTokenName || t('common:misc.unknownProvider')}`;
    }

    if (formState.tokenMode === 'new' && formState.newGithubToken.trim()) {
      return t('projectWizard.step3.usingProvidedToken');
    }

    if (isSshGitUrl(formState.githubUrl)) {
      return t('projectWizard.step3.sshKey', { defaultValue: 'SSH Key' });
    }

    return t('projectWizard.step3.noAuthentication');
  }, [formState, selectedTokenName, t]);

  if (formState.sourceMode === 'ssh') return <div className="space-y-4">
    <div className="space-y-3 rounded-lg border border-border bg-muted/20 p-4">
      <h4 className="text-sm font-semibold">{sshProbe?.existingProject ? (sshProbe.existingProject.isArchived ? '恢复已有本机项目' : '打开已有本机项目') : '本机项目（云端 Claude）'}</h4>
      {sshProbe?.existingProject && <p className="break-words text-sm">此目录已在当前账号中登记为「{sshProbe.existingProject.displayName}」。打开原项目将保留原有会话和设置。</p>}
      <dl className="space-y-2 text-sm">
        <div><dt className="text-muted-foreground">连接</dt><dd>{connectionLabel || formState.connectionId}</dd></div>
        <div><dt className="text-muted-foreground">Windows 目录</dt><dd className="break-all font-mono text-xs">{sshProbe?.rootPath || formState.rootPath}</dd></div>
        <div><dt className="text-muted-foreground">执行位置</dt><dd>Claude Code：云端 VPS；项目文件、Git、构建和测试：Windows</dd></div>
      </dl>
    </div>
    <p className="text-sm text-muted-foreground">Claude Code 在 VPS 运行，本机无需安装 Claude Code。使用已有 Windows 目录，不执行克隆。当前仅支持 Claude，共享使用项目文件；不提供本地隔离工作区、改动集成或云端预览。提交时会重新验证连接。</p>
  </div>;

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-gray-200 bg-gray-50 p-4 dark:border-gray-700 dark:bg-gray-900/50">
        <h4 className="mb-3 text-sm font-semibold text-gray-900 dark:text-white">
          {t('projectWizard.step3.reviewConfig')}
        </h4>

        <div className="space-y-2">
          <div className="flex justify-between text-sm">
            <span className="text-gray-600 dark:text-gray-400">{t('projectWizard.step3.path')}</span>
            <span className="break-all font-mono text-xs text-gray-900 dark:text-white">
              {formState.workspacePath}
            </span>
          </div>

          {formState.githubUrl && (
            <>
              <div className="flex justify-between text-sm">
                <span className="text-gray-600 dark:text-gray-400">
                  {t('projectWizard.step3.cloneFrom')}
                </span>
                <span className="break-all font-mono text-xs text-gray-900 dark:text-white">
                  {formState.githubUrl}
                </span>
              </div>

              <div className="flex justify-between text-sm">
                <span className="text-gray-600 dark:text-gray-400">
                  {t('projectWizard.step3.authentication')}
                </span>
                <span className="text-xs text-gray-900 dark:text-white">{authenticationLabel}</span>
              </div>
            </>
          )}
        </div>
      </div>

      <div className="rounded-lg border border-blue-200 bg-blue-50 p-4 dark:border-blue-800 dark:bg-blue-900/20">
        {isCreating && cloneProgress ? (
          <div className="space-y-2">
            <p className="text-sm font-medium text-blue-800 dark:text-blue-200">
              {t('projectWizard.step3.cloningRepository', { defaultValue: 'Cloning repository...' })}
            </p>
            <code className="block whitespace-pre-wrap break-all font-mono text-xs text-blue-700 dark:text-blue-300">
              {cloneProgress}
            </code>
          </div>
        ) : (
          <p className="text-sm text-blue-800 dark:text-blue-200">
            {formState.githubUrl
              ? t('projectWizard.step3.newWithClone')
              : t('projectWizard.step3.newEmpty')}
          </p>
        )}
      </div>
    </div>
  );
}
