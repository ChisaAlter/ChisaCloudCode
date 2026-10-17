export interface ExtractedImage {
  alt: string;
  url: string;
}

/** Decode HTML entities in a URL extracted from raw HTML text */
function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x2F;/g, '/');
}

/** Extract all image URLs from markdown AND inline HTML <img> tags */
export function extractImages(text: string): ExtractedImage[] {
  const results: ExtractedImage[] = [];
  const seen = new Set<string>();

  const add = (rawUrl: string, alt: string) => {
    if (!rawUrl) return;
    const url = decodeHtmlEntities(rawUrl);
    if (seen.has(url)) return;
    seen.add(url);
    results.push({ alt, url });
  };

  // Markdown: ![alt](url)
  const mdRe = /!\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = mdRe.exec(text)) !== null) {
    add(m[2] ?? '', m[1] ?? '');
  }

  // HTML img tags: <img ... src="url" ... /> or <img ... src='url' ... />
  const htmlRe = /<img\b([^>]*)>/gi;
  while ((m = htmlRe.exec(text)) !== null) {
    const attrs = m[1] ?? '';
    const srcMatch = attrs.match(/src=["'](https?:\/\/[^"']+)["']/i);
    const altMatch = attrs.match(/alt=["']([^"']*)["']/i);
    if (srcMatch?.[1]) {
      add(srcMatch[1], altMatch?.[1] ?? '');
    }
  }

  return results;
}

/** Strip markdown image syntax AND HTML img tags from text */
export function stripImages(text: string): string {
  return text
    .replace(/!\[[^\]]*\]\(https?:\/\/[^)\s]+\)/g, '')
    .replace(/<img\b[^>]*>/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
