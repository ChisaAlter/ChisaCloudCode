import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useGitPanelController } from '@/modules/git-panel/hooks/useGitPanelController';
import { useRevertLocalCommit } from '@/modules/git-panel/hooks/useRevertLocalCommit';
import type { ConfirmationRequest, FileOpenHandler, GitPanelView, Project } from '@/shared/types';
import { getChangedFileCount } from '@/modules/git-panel/utils/gitPanelUtils';
import ChangesView from '@/modules/git-panel/changes/ChangesView';
import HistoryView from '@/modules/git-panel/history/HistoryView';
import BranchesView from '@/modules/git-panel/branches/BranchesView';
import WorktreesView from '@/modules/git-panel/worktrees/WorktreesView';
import GitPanelHeader from '@/modules/git-panel/GitPanelHeader';
import GitRepositoryErrorState from '@/modules/git-panel/GitRepositoryErrorState';
import GitViewTabs from '@/modules/git-panel/GitViewTabs';
import ConfirmActionModal from '@/modules/git-panel/modals/ConfirmActionModal';

type GitPanelProps = {
  selectedProject: Project | null;
  isMobile?: boolean;
  onFileOpen?: FileOpenHandler;
  /** Switches the app to another project — used by the Worktrees view to jump into a worktree. */
  onProjectSelect?: (project: Project) => void;
  /** Silently re-syncs the sidebar project list after worktree projects are created/archived. */
  onProjectsRefresh?: () => void;
};

/** Exported through the git-panel barrel; the project-workspace module renders it as the source-control sidebar tab. */
export default function GitPanel({
  selectedProject,
  isMobile = false,
  onFileOpen,
  onProjectSelect,
  onProjectsRefresh,
}: GitPanelProps) {
  const { t } = useTranslation();
  const [activeView, setActiveView] = useState<GitPanelView>('changes');
  const [wrapText, setWrapText] = useState(true);
  const [hasExpandedFiles, setHasExpandedFiles] = useState(false);
  const [confirmAction, setConfirmAction] = useState<ConfirmationRequest | null>(null);
  // Confirmations stay visible and cannot be submitted twice while their action runs.
  const [isConfirming, setIsConfirming] = useState(false);
  const confirmationRequestRef = useRef<symbol | null>(null);
  // A project transition clears repository-owned UI before the new project's first commit.
  const [uiProjectId, setUiProjectId] = useState(selectedProject?.projectId ?? null);
  if (uiProjectId !== (selectedProject?.projectId ?? null)) {
    setUiProjectId(selectedProject?.projectId ?? null);
    setConfirmAction(null);
    setIsConfirming(false);
    setHasExpandedFiles(false);
  }

  useEffect(() => {
    confirmationRequestRef.current = null;
    return () => { confirmationRequestRef.current = null; };
  }, [selectedProject?.projectId]);

  const {
    gitStatus,
    gitDiff,
    isLoading,
    isLoadingCommits,
    commitsError,
    retryCommits,
    currentBranch,
    branches,
    localBranches,
    remoteBranches,
    recentCommits,
    commitDiffs,
    commitDiffErrors,
    remoteStatus,
    isCreatingBranch,
    isBranchBusy,
    isFetching,
    isPulling,
    isPushing,
    isPublishing,
    isCreatingInitialCommit,
    isInitializingRepository,
    operationError,
    clearOperationError,
    reportOperationError,
    refreshAll,
    switchBranch,
    createBranch,
    deleteBranch,
    handleFetch,
    handlePull,
    handlePush,
    handlePublish,
    discardChanges,
    deleteUntrackedFile,
    stageFiles,
    unstageFiles,
    fetchCommitDiff,
    fetchFileDiff,
    commitChanges,
    createInitialCommit,
    initRepository,
    openFile,
  } = useGitPanelController({
    selectedProject,
    activeView,
    onFileOpen,
  });

  const { isRevertingLocalCommit, revertLatestLocalCommit } = useRevertLocalCommit({
    // `projectId` (DB primary key) is forwarded to the revert API which uses it
    // as the `project` body param.
    projectId: selectedProject?.projectId ?? null,
    onSuccess: refreshAll,
    onError: reportOperationError,
  });

  const executeConfirmedAction = useCallback(async (useAlternateConfirmation = false) => {
    if (!confirmAction || confirmationRequestRef.current) return;
    const actionToExecute = confirmAction;
    const request = Symbol('confirmation');
    confirmationRequestRef.current = request;
    setIsConfirming(true);
    try {
      const confirmationHandler = useAlternateConfirmation
        ? actionToExecute.alternateConfirmation?.onConfirm ?? actionToExecute.onConfirm
        : actionToExecute.onConfirm;
      await confirmationHandler();
      if (confirmationRequestRef.current === request) setConfirmAction(null);
    } catch (error) {
      if (confirmationRequestRef.current === request) reportOperationError(error);
    } finally {
      if (confirmationRequestRef.current === request) {
        confirmationRequestRef.current = null;
        setIsConfirming(false);
      }
    }
  }, [confirmAction, reportOperationError]);

  const changeCount = getChangedFileCount(gitStatus);
  // Without a repository the branch/fetch/refresh header controls are all
  // meaningless — hide the whole header and let the init state own the panel.
  const isMissingRepository = Boolean(gitStatus?.notGitRepository);

  if (!selectedProject) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        <p>{t('git:panel.selectProject')}</p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-background">
      {!isMissingRepository && (
        <GitPanelHeader
          isMobile={isMobile}
          currentBranch={currentBranch}
          branches={branches}
          remoteStatus={remoteStatus}
          isLoading={isLoading}
          isCreatingBranch={isCreatingBranch}
          isBranchBusy={isBranchBusy}
          isFetching={isFetching}
          isPulling={isPulling}
          isPushing={isPushing}
          isPublishing={isPublishing}
          isRevertingLocalCommit={isRevertingLocalCommit}
          operationError={operationError}
          onRefresh={refreshAll}
          onRevertLocalCommit={revertLatestLocalCommit}
          onSwitchBranch={switchBranch}
          onCreateBranch={createBranch}
          onFetch={handleFetch}
          onPull={handlePull}
          onPush={handlePush}
          onPublish={handlePublish}
          onClearError={clearOperationError}
          onRequestConfirmation={setConfirmAction}
        />
      )}

      {gitStatus?.error ? (
        <GitRepositoryErrorState
          error={gitStatus.error}
          details={gitStatus.details}
          canInitRepository={isMissingRepository}
          isInitializingRepository={isInitializingRepository}
          initError={isMissingRepository ? operationError : null}
          onRetry={refreshAll}
          onInitRepository={() => {
            clearOperationError();
            void initRepository();
          }}
        />
      ) : (
        <>
          <GitViewTabs
            activeView={activeView}
            isHidden={hasExpandedFiles}
            changeCount={changeCount}
            onChange={setActiveView}
          />

          {activeView === 'changes' && (
            <ChangesView
              key={selectedProject.projectId}
              isMobile={isMobile}
              projectPath={selectedProject.fullPath}
              gitStatus={gitStatus}
              gitDiff={gitDiff}
              isLoading={isLoading}
              wrapText={wrapText}
              isCreatingInitialCommit={isCreatingInitialCommit}
              onWrapTextChange={setWrapText}
              onCreateInitialCommit={createInitialCommit}
              onOpenFile={openFile}
              onLoadDiff={fetchFileDiff}
              onDiscardFile={discardChanges}
              onDeleteFile={deleteUntrackedFile}
              onStageFiles={stageFiles}
              onUnstageFiles={unstageFiles}
              onCommitChanges={commitChanges}
              onRequestConfirmation={setConfirmAction}
              onExpandedFilesChange={setHasExpandedFiles}
            />
          )}

          {activeView === 'history' && (
            <HistoryView
              key={selectedProject.projectId}
              isMobile={isMobile}
              // Treat an in-flight commits request as loading only while the
              // list is empty, so "No commits found" never flashes before the
              // first response and refetches don't blank an existing list.
              isLoading={isLoading || (recentCommits.length === 0 && isLoadingCommits)}
              error={commitsError}
              onRetry={retryCommits}
              recentCommits={recentCommits}
              commitDiffs={commitDiffs}
              commitDiffErrors={commitDiffErrors}
              wrapText={wrapText}
              onFetchCommitDiff={fetchCommitDiff}
            />
          )}

          {activeView === 'worktrees' && (
            <WorktreesView
              key={selectedProject.fullPath}
              isMobile={isMobile}
              selectedProject={selectedProject}
              localBranches={localBranches}
              onProjectSelect={onProjectSelect}
              onProjectsRefresh={onProjectsRefresh}
            />
          )}

          {activeView === 'branches' && (
            <BranchesView
              isMobile={isMobile}
              isLoading={isLoading}
              currentBranch={currentBranch}
              localBranches={localBranches}
              remoteBranches={remoteBranches}
              remoteStatus={remoteStatus}
              isCreatingBranch={isCreatingBranch}
              isBranchBusy={isBranchBusy}
              onSwitchBranch={switchBranch}
              onCreateBranch={createBranch}
              onDeleteBranch={deleteBranch}
              onRequestConfirmation={setConfirmAction}
            />
          )}
        </>
      )}

      <ConfirmActionModal
        action={confirmAction}
        isPending={isConfirming}
        error={confirmAction?.type === 'revertLocalCommit' ? operationError : null}
        onCancel={() => {
          if (!confirmationRequestRef.current) setConfirmAction(null);
        }}
        onConfirm={(useAlternateConfirmation) => {
          void executeConfirmedAction(useAlternateConfirmation);
        }}
      />
    </div>
  );
}
