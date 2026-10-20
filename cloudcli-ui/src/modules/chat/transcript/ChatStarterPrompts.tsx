import { Code2, FolderGit2, SearchCode, Wrench } from 'lucide-react';
import { useTranslation } from 'react-i18next';

type ChatStarterPromptsProps = {
  projectName?: string;
  onSelect: (prompt: string) => void;
};

/** Used by ChatInterface to offer editable starting points for an empty conversation. */
export default function ChatStarterPrompts({ onSelect, projectName }: ChatStarterPromptsProps) {
  const { t } = useTranslation('chat');
  const prompts = [
    { key: 'explore', icon: SearchCode, label: t('starter.explore', { defaultValue: 'Explore this project' }), prompt: t('starter.explorePrompt', { defaultValue: 'Explore this project and explain its structure, main entry points, and how to run it.' }) },
    { key: 'build', icon: Code2, label: t('starter.build', { defaultValue: 'Build something' }), prompt: t('starter.buildPrompt', { defaultValue: 'Help me implement a new feature in this project. First understand the existing code, then ask me what I want to build.' }) },
    { key: 'fix', icon: Wrench, label: t('starter.fix', { defaultValue: 'Find and fix a bug' }), prompt: t('starter.fixPrompt', { defaultValue: 'Help me investigate a bug in this project. Ask me about the observed behavior and reproduction steps before making changes.' }) },
  ];

  return (
    <div className="chat-starter-section">
      {projectName && <p className="chat-project-context"><FolderGit2 className="h-3.5 w-3.5" aria-hidden="true" />{t('starter.projectContext', { project: projectName, defaultValue: 'Working in {{project}}' })}</p>}
      <div className="chat-starter-prompts" aria-label={t('starter.label', { defaultValue: 'Ideas to get started' })}>
        {prompts.map(({ key, icon: Icon, label, prompt }) => (
          <button key={key} type="button" onClick={() => onSelect(prompt)}>
            <Icon className="h-3.5 w-3.5" strokeWidth={1.6} aria-hidden="true" />
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}
