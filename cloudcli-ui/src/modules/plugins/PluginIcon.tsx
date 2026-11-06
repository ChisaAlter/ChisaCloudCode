import { useState, useEffect, useSyncExternalStore } from 'react';
import DOMPurify from 'dompurify';

import { api } from '@/shared/api';
import { getAuthSessionSnapshot, isCurrentAuthSession, subscribeToAuthSession } from '@/modules/auth-session';

type Props = { pluginName: string; iconFile: string; className?: string };
const svgCache = new Map<string, string>();
subscribeToAuthSession(() => { svgCache.clear(); });
const FORBIDDEN_SVG_TAGS = ['script', 'foreignObject', 'iframe', 'object', 'embed', 'link', 'meta', 'style', 'animate', 'set', 'animateTransform', 'animateMotion'];
const FORBIDDEN_SVG_ATTRS = ['href', 'xlink:href', 'src', 'style'];
function sanitizeSvg(text: string): string | null {
  const sanitized = DOMPurify.sanitize(text, { USE_PROFILES: { svg: true, svgFilters: true }, FORBID_TAGS: FORBIDDEN_SVG_TAGS, FORBID_ATTR: FORBIDDEN_SVG_ATTRS });
  if (!sanitized) return null;
  try {
    const doc = new DOMParser().parseFromString(sanitized, 'image/svg+xml');
    return doc.documentElement.nodeName.toLowerCase() === 'svg' && !doc.querySelector('parsererror') ? sanitized : null;
  } catch { return null; }
}
/** Workspace tabs and plugin settings render sanitized icons partitioned by the current account incarnation. */
export default function PluginIcon({ pluginName, iconFile, className }: Props) {
  const session = useSyncExternalStore(subscribeToAuthSession, getAuthSessionSnapshot, getAuthSessionSnapshot);
  const key = `${session.serverKey}:${session.sessionInstanceId}:${pluginName}:${iconFile}`;
  // Store the identity beside the image so a render following logout cannot flash the old account's cached icon.
  const [image, setImage] = useState<{ key: string; svg: string } | null>(null);
  useEffect(() => {
    if (!iconFile || session.phase !== 'ready') return;
    const captured = session;
    const controller = new AbortController();
    const cached = svgCache.get(key);
    if (cached) return;
    void api.plugins.asset(pluginName, iconFile, { expectedSession: captured, signal: controller.signal }).then(async response => {
      if (!response.ok) return;
      const text = await response.text();
      if (controller.signal.aborted || !isCurrentAuthSession(captured)) return;
      const svg = sanitizeSvg(text);
      if (svg) { svgCache.set(key, svg); setImage({ key, svg }); }
    }).catch(() => {});
    return () => controller.abort();
  }, [key, pluginName, iconFile, session]);
  const svg = image?.key === key ? image.svg : svgCache.get(key);
  if (!svg || session.phase !== 'ready') return <span className={className} />;
  return <span className={className} dangerouslySetInnerHTML={{ __html: svg }} />;
}
