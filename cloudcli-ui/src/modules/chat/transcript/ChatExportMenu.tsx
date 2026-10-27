import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Activity, Braces, FileCode2, FileText, Loader2, MoreHorizontal } from 'lucide-react';

import { ActionMenu } from '@/shared/ui';
import type { ChatMessage, DiffLine, LLMProvider, Project } from '@/shared/types';
import {
  downloadTranscriptExport,
  type TranscriptExportFormat,
} from '@/modules/chat/utils/chatExport';

type ChatExportMenuProps = {
  messages: ChatMessage[];
  sessionTitle?: string;
  provider: LLMProvider | string;
  selectedProject?: Project | null;
  createDiff: (oldStr: string, newStr: string) => DiffLine[];
  /**
   * Loads the rest of the conversation before exporting.
   *
   * The transcript is paged, so `messages` is usually the tail of it. Without
   * this, exporting a long session silently produced a file containing the
   * last twenty messages.
   */
  onLoadFullTranscript?: () => Promise<ChatMessage[]>;
  /** Opens the conversation usage dialog without adding another persistent toolbar. */
  onShowTokenUsage?: () => void;
};

const FORMATS: Array<{ id: TranscriptExportFormat; icon: typeof FileText; labelKey: string; descriptionKey: string }> = [
  { id: 'html', icon: FileCode2, labelKey: 'export.html.label', descriptionKey: 'export.html.description' },
  { id: 'markdown', icon: FileText, labelKey: 'export.markdown.label', descriptionKey: 'export.markdown.description' },
  { id: 'json', icon: Braces, labelKey: 'export.json.label', descriptionKey: 'export.json.description' },
];

/**
 * ChatMessagesPane uses this single conversation menu for usage and complete
 * transcript downloads as HTML, Markdown or JSON.
 */
export default function ChatExportMenu({
  messages,
  sessionTitle,
  provider,
  selectedProject,
  createDiff,
  onLoadFullTranscript,
  onShowTokenUsage,
}: ChatExportMenuProps) {
  const { t } = useTranslation('chat');
  // Building a large transcript takes long enough to notice, and the download
  // only appears at the end — without this the button looks unresponsive.
  const [busyFormat, setBusyFormat] = useState<TranscriptExportFormat | null>(null);

  if (messages.length === 0) {
    return null;
  }

  const runExport = async (format: TranscriptExportFormat) => {
    setBusyFormat(format);
    try {
      const fullMessages = (await onLoadFullTranscript?.()) ?? messages;
      await downloadTranscriptExport(format, {
        messages: fullMessages.length > 0 ? fullMessages : messages,
        sessionTitle: sessionTitle?.trim() || t('export.untitled'),
        provider,
        selectedProject,
        createDiff,
      });
    } catch (error) {
      console.error('Failed to export conversation:', error);
    } finally {
      setBusyFormat(null);
    }
  };

  return (
    <ActionMenu
      icon={busyFormat ? Loader2 : MoreHorizontal}
      iconOnly
      portal
      variant="ghost"
      label={t('misc.sessionOptions', { defaultValue: 'Session options' })}
      ariaLabel={t('misc.sessionOptions', { defaultValue: 'Session options' })}
      triggerClassName="h-8 w-8 rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground"
      menuClassName="w-[260px] rounded-xl p-1.5 shadow-xl"
      header={(
        <div className="mb-1 border-b border-border px-3 py-2">
          <p className="text-xs font-medium text-foreground">{t('export.heading')}</p>
        </div>
      )}
      items={[
        ...(onShowTokenUsage ? [{ key: 'usage', label: t('misc.showTokenUsage'), icon: Activity, onSelect: onShowTokenUsage }] : []),
        ...FORMATS.map((format, index) => ({
          key: format.id,
          label: t(format.labelKey),
          description: t(format.descriptionKey),
          icon: format.icon,
          loading: busyFormat === format.id,
          showDividerBefore: index === 0 && Boolean(onShowTokenUsage),
          onSelect: () => { void runExport(format.id); },
        })),
      ]}
    />
  );
}
