import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FolderPlus, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import ErrorBanner from '@/modules/project-creation-wizard/ErrorBanner';
import StepConfiguration from '@/modules/project-creation-wizard/StepConfiguration';
import StepReview from '@/modules/project-creation-wizard/StepReview';
import WizardFooter from '@/modules/project-creation-wizard/WizardFooter';
import WizardProgress from '@/modules/project-creation-wizard/WizardProgress';
import { useGithubTokens } from '@/modules/project-creation-wizard/hooks/useGithubTokens';
import { cloneWorkspaceWithProgress, createProjectRequest } from '@/modules/project-creation-wizard/utils/workspaceApi';
import { isCloneWorkflow, shouldShowGithubAuthentication } from '@/modules/project-creation-wizard/utils/pathUtils';
import type { SshWorkspaceProbe, TokenMode, WizardFormState, WizardStep } from '@/shared/types';
import { SshProjectFields } from '@/modules/ssh-workspaces';
import { beginBlockingOperation } from '@/shared/utils';
import { getAuthSessionVersion } from '@/shared/authToken';
import { getServerConnectionVersion } from '@/shared/chisa';

type ProjectCreationWizardProps = {
  onClose: () => void;
  onProjectCreated?: (project?: Record<string, unknown>) => void | Promise<void>;
};

const initialFormState: WizardFormState = {
  workspacePath: '',
  githubUrl: '',
  tokenMode: 'stored',
  selectedGithubToken: '',
  newGithubToken: '',
};

/** Rendered by the sidebar module's modal layer to create a new project or clone one from GitHub. */
export default function ProjectCreationWizard({
  onClose,
  onProjectCreated,
}: ProjectCreationWizardProps) {
  const { t } = useTranslation();
  // Review is a separate step so the committed target is visible before creation.
  const [step, setStep] = useState<WizardStep>(1);
  // Preserve cloud and SSH input while switching modes; only the active mode is submitted.
  const [formState, setFormState] = useState<WizardFormState>(initialFormState);
  // Creation owns the modal until the actual server response settles.
  const [isCreating, setIsCreating] = useState(false);
  // Validation and API errors remain visible without discarding entered values.
  const [error, setError] = useState<string | null>(null);
  // Cloud Git clone progress retains its existing event-stream presentation.
  const [cloneProgress, setCloneProgress] = useState('');
  // A successful probe is bound to the exact selected connection and entered root.
  const [sshVerification, setSshVerification] = useState<{ key: string; probe: SshWorkspaceProbe; connectionLabel: string } | null>(null);
  const sshMode = formState.sourceMode === 'ssh';
  const sshSelectionKey = JSON.stringify([getAuthSessionVersion(), getServerConnectionVersion(), sshMode, formState.connectionId || '', formState.rootPath || '']);
  const verifiedSsh = sshVerification?.key === sshSelectionKey ? sshVerification : null;
  const existingProject = sshMode ? verifiedSsh?.probe.existingProject : undefined;
  const requestRef = useRef(0);
  const selectionRef = useRef(sshSelectionKey);
  selectionRef.current = sshSelectionKey;
  useEffect(() => () => { ++requestRef.current; }, []);

  const shouldLoadTokens =
    !sshMode && step === 1 && shouldShowGithubAuthentication(formState.githubUrl);

  const autoSelectToken = useCallback((tokenId: string) => {
    setFormState((previous) => ({ ...previous, selectedGithubToken: tokenId }));
  }, []);

  const {
    tokens: availableTokens,
    loading: loadingTokens,
    loadError: tokenLoadError,
    selectedTokenName,
  } = useGithubTokens({
    shouldLoad: shouldLoadTokens,
    selectedTokenId: formState.selectedGithubToken,
    onAutoSelectToken: autoSelectToken,
  });

  // Keep cross-step values in this component; local UI state lives in child components.
  const updateField = useCallback(<K extends keyof WizardFormState>(key: K, value: WizardFormState[K]) => {
    setFormState((previous) => ({ ...previous, [key]: value }));
  }, []);

  const updateTokenMode = useCallback(
    (tokenMode: TokenMode) => updateField('tokenMode', tokenMode),
    [updateField],
  );

  const handleNext = useCallback(() => {
    setError(null);

    if (step === 1) {
      if (sshMode) {
        if (!verifiedSsh) { setError('请先验证项目连接和 Windows 项目目录。'); return; }
        setStep(2);
        return;
      }
      if (!formState.workspacePath.trim()) {
        setError(t('projectWizard.errors.providePath'));
        return;
      }
      setStep(2);
    }
  }, [formState.workspacePath, sshMode, verifiedSsh, step, t]);

  const handleBack = useCallback(() => {
    setError(null);
    setStep((previousStep) => (previousStep > 1 ? ((previousStep - 1) as WizardStep) : previousStep));
  }, []);

  const handleCreate = useCallback(async () => {
    if (isCreating) return;
    if (sshMode && !verifiedSsh) { setError('目录验证已失效，请返回并重新验证。'); return; }
    const request = ++requestRef.current;
    const identity = getAuthSessionVersion();
    const server = getServerConnectionVersion();
    const selection = sshSelectionKey;
    const current = () => request === requestRef.current && identity === getAuthSessionVersion() && server === getServerConnectionVersion() && selection === selectionRef.current;
    const finish = beginBlockingOperation(existingProject ? (existingProject.isArchived ? '正在恢复并打开项目' : '正在打开已有项目') : '正在准备项目', existingProject ? '服务器正在重新验证目录并载入原项目。' : '正在创建工作目录并载入项目，完成后即可继续操作。');
    setIsCreating(true);
    setError(null);
    setCloneProgress('');

    try {
      if (sshMode && verifiedSsh) {
        const project = await createProjectRequest({ sourceMode: 'ssh', connectionId: formState.connectionId || '', rootPath: verifiedSsh.probe.rootPath });
        if (!current()) return;
        await onProjectCreated?.(project);
        if (current()) onClose();
        return;
      }
      const shouldCloneRepository = isCloneWorkflow(formState.githubUrl);

      if (shouldCloneRepository) {
        const project = await cloneWorkspaceWithProgress(
          {
            workspacePath: formState.workspacePath,
            githubUrl: formState.githubUrl,
            tokenMode: formState.tokenMode,
            selectedGithubToken: formState.selectedGithubToken,
            newGithubToken: formState.newGithubToken,
          },
          {
            onProgress: value => { if (current()) setCloneProgress(value); },
          },
        );

        if (!current()) return;
        await onProjectCreated?.(project);
        if (current()) onClose();
        return;
      }

      const project = await createProjectRequest({
        path: formState.workspacePath.trim(),
      });

      if (!current()) return;
      await onProjectCreated?.(project);
      if (current()) onClose();
    } catch (createError) {
      if (!current()) return;
      const errorMessage =
        createError instanceof Error
          ? createError.message
          : t('projectWizard.errors.failedToCreate');
      setError(errorMessage);
    } finally {
      finish();
      if (current()) setIsCreating(false);
    }
  }, [existingProject, formState, isCreating, sshMode, sshSelectionKey, verifiedSsh, onClose, onProjectCreated, t]);

  const shouldCloneRepository = useMemo(
    () => !sshMode && isCloneWorkflow(formState.githubUrl),
    [formState.githubUrl, sshMode],
  );

  return (
    <div className="fixed bottom-0 left-0 right-0 top-0 z-[60] flex items-center justify-center bg-black/50 p-0 backdrop-blur-sm sm:p-4">
      <div className="h-full w-full overflow-y-auto rounded-none border-0 border-gray-200 bg-white shadow-xl dark:border-gray-700 dark:bg-gray-800 sm:h-auto sm:max-w-2xl sm:rounded-lg sm:border">
        <div className="flex items-center justify-between border-b border-gray-200 p-6 dark:border-gray-700">
          <div className="flex items-center gap-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-100 dark:bg-blue-900/50">
              <FolderPlus className="h-4 w-4 text-blue-600 dark:text-blue-400" />
            </div>
            <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
              {t('projectWizard.title')}
            </h3>
          </div>
          <button
            onClick={onClose}
            className="rounded-md p-2 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-700 dark:hover:text-gray-300"
            disabled={isCreating}
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <WizardProgress step={step} />

        <div className="min-h-[300px] space-y-6 p-6">
          {error && <ErrorBanner message={error} />}

          {step === 1 && <fieldset className="space-y-2" disabled={isCreating}>
            <legend className="mb-2 text-sm font-medium">项目文件位置</legend>
            <div className="flex flex-wrap gap-2">
              <label className={`flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm ${!sshMode ? 'border-primary bg-primary/5' : 'border-border'}`}><input type="radio" name="project-source-mode" value="cloud" checked={!sshMode} onChange={() => { updateField('sourceMode', 'cloud'); setError(null); }} />云端 VPS</label>
              <label className={`flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm ${sshMode ? 'border-primary bg-primary/5' : 'border-border'}`}><input type="radio" name="project-source-mode" value="ssh" checked={sshMode} onChange={() => { updateField('sourceMode', 'ssh'); setError(null); }} />本机项目（云端 Claude）</label>
            </div>
            <p className="text-xs text-muted-foreground">两种方式都由 VPS 运行 Claude Code，本机无需安装 Claude Code；这里只选择项目文件存放在哪里。</p>
          </fieldset>}

          {step === 1 && sshMode && <SshProjectFields connectionId={formState.connectionId || ''} rootPath={formState.rootPath || ''} verified={verifiedSsh?.probe ?? null} disabled={isCreating} onConnectionChange={id => { setSshVerification(null); updateField('connectionId', id); }} onRootPathChange={path => { setSshVerification(null); updateField('rootPath', path); }} onVerified={(probe, label) => setSshVerification(probe ? { key: sshSelectionKey, probe, connectionLabel: label || '' } : null)} />}

          {step === 1 && !sshMode && (
            <StepConfiguration
              workspacePath={formState.workspacePath}
              githubUrl={formState.githubUrl}
              tokenMode={formState.tokenMode}
              selectedGithubToken={formState.selectedGithubToken}
              newGithubToken={formState.newGithubToken}
              availableTokens={availableTokens}
              loadingTokens={loadingTokens}
              tokenLoadError={tokenLoadError}
              isCreating={isCreating}
              onWorkspacePathChange={(workspacePath) => updateField('workspacePath', workspacePath)}
              onGithubUrlChange={(githubUrl) => updateField('githubUrl', githubUrl)}
              onTokenModeChange={updateTokenMode}
              onSelectedGithubTokenChange={(selectedGithubToken) =>
                updateField('selectedGithubToken', selectedGithubToken)
              }
              onNewGithubTokenChange={(newGithubToken) =>
                updateField('newGithubToken', newGithubToken)
              }
              onAdvanceToConfirm={() => setStep(2)}
            />
          )}

          {step === 2 && (
            <StepReview
              formState={formState}
              selectedTokenName={selectedTokenName}
              isCreating={isCreating}
              cloneProgress={cloneProgress}
              sshProbe={verifiedSsh?.probe}
              connectionLabel={verifiedSsh?.connectionLabel}
            />
          )}
        </div>

        <WizardFooter
          step={step}
          isCreating={isCreating}
          isCloneWorkflow={shouldCloneRepository}
          existingProject={existingProject}
          onClose={onClose}
          onBack={handleBack}
          onNext={handleNext}
          onCreate={handleCreate}
        />
      </div>
    </div>
  );
}
