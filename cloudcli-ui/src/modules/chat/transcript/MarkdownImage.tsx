import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { api, authenticatedFetch } from '@/shared/api';
import { ImageLightbox } from '@/modules/chat/transcript/ChatMessageImages';

type MarkdownImageProps = {
  src?: string;
  alt?: string;
  title?: string;
  projectId?: string | null;
  disableFileLinks?: boolean;
};

type ImageSource =
  | { kind: 'direct'; url: string }
  | { kind: 'api'; path: string }
  | { kind: 'project'; projectId: string; path: string };

type ImageLoadState = {
  sourceKey: string;
  url: string | null;
  failed: boolean;
};

function resolveImageSource(src: string, projectId?: string | null, disableFileLinks = false): ImageSource | null {
  if (!src) return null;
  if (/^(?:https?:|blob:|data:image\/)/i.test(src)) return { kind: 'direct', url: src };
  if (src.startsWith('//')) return { kind: 'direct', url: `https:${src}` };
  if (src.startsWith('/api/')) return { kind: 'api', path: src };
  // Native-agent file paths belong to its local workspace, never the selected cloud project.
  if (disableFileLinks || !projectId) return null;

  try {
    let filePath: string;
    if (/^file:/i.test(src)) {
      const fileUrl = new URL(src);
      if (fileUrl.hostname && fileUrl.hostname !== 'localhost') return null;
      filePath = decodeURIComponent(fileUrl.pathname).replace(/^\/([a-z]:[\\/])/i, '$1');
    } else {
      if (/^[a-z][a-z\d+.-]*:/i.test(src) && !/^[a-z]:[\\/]/i.test(src)) return null;
      filePath = decodeURIComponent(src);
    }
    // Provider paths use /workspace as a virtual mount for this project's root.
    filePath = filePath.replace(/^\/workspace\//, '');
    return filePath ? { kind: 'project', projectId, path: filePath } : null;
  } catch {
    return null;
  }
}

/** Used by chat's Markdown renderer to show authenticated workspace images and expand their previews. */
export default function MarkdownImage({ src = '', alt = '', title, projectId, disableFileLinks = false }: MarkdownImageProps) {
  const { t } = useTranslation();
  const sourceKey = JSON.stringify([src, projectId ?? null, disableFileLinks]);
  const source = useMemo(() => resolveImageSource(src, projectId, disableFileLinks), [src, projectId, disableFileLinks]);
  // A fetched blob must retain its source identity so a project/path change cannot display old bytes.
  const [loaded, setLoaded] = useState<ImageLoadState | null>(null);
  // Browser decode errors are tied to the image that failed, independently of request success.
  const [failedSourceKey, setFailedSourceKey] = useState<string | null>(null);
  // Keep the lightbox attached to the image the user expanded when a streamed source changes.
  const [expandedSourceKey, setExpandedSourceKey] = useState<string | null>(null);

  useEffect(() => {
    setFailedSourceKey(null);
    setExpandedSourceKey(null);
    if (!source || source.kind === 'direct') return;
    const controller = new AbortController();
    let objectUrl: string | null = null;
    setLoaded({ sourceKey, url: null, failed: false });

    const load = async () => {
      try {
        const response = source.kind === 'api'
          ? await authenticatedFetch(source.path, { signal: controller.signal })
          : await api.readFileBlob(source.projectId, source.path, { signal: controller.signal });
        if (!response.ok) throw new Error(`Image request failed (${response.status})`);
        const blob = await response.blob();
        if (controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob);
        setLoaded({ sourceKey, url: objectUrl, failed: false });
      } catch {
        if (!controller.signal.aborted) setLoaded({ sourceKey, url: null, failed: true });
      }
    };
    void load();

    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [source, sourceKey]);

  const currentLoad = loaded?.sourceKey === sourceKey ? loaded : null;
  const displaySrc = source?.kind === 'direct' ? source.url : currentLoad?.url;
  const failed = !source || currentLoad?.failed || failedSourceKey === sourceKey;
  const label = alt || title || t('common:tabs.files');

  if (failed || !displaySrc) {
    return (
      <span role="status" className="my-2 flex max-w-full items-center rounded-lg border border-border/60 bg-muted/50 px-3 py-2 text-sm text-muted-foreground">
        {label && <span className="mr-2 min-w-0 truncate">{label}</span>}
        <span className="shrink-0">{t(failed ? 'common:fileTree.loadFailed' : 'common:status.loading')}</span>
      </span>
    );
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setExpandedSourceKey(sourceKey)}
        title={title}
        aria-label={t('chat:misc.expandImage', { name: label })}
        className="my-2 block max-w-full overflow-hidden rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
      >
        <img
          src={displaySrc}
          alt={alt}
          onError={() => setFailedSourceKey(sourceKey)}
          className="m-0 block h-auto max-h-[32rem] max-w-full cursor-zoom-in object-contain"
        />
      </button>
      {expandedSourceKey === sourceKey && <ImageLightbox src={displaySrc} alt={label} onClose={() => setExpandedSourceKey(null)} />}
    </>
  );
}
