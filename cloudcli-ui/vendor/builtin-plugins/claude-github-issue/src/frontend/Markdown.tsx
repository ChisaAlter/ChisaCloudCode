import React from 'react';

/**
 * Lightweight, dependency-free Markdown → React renderer.
 * Renders the GitHub-flavored subset that appears in issue bodies/comments:
 * headings, bold/italic/strikethrough, inline code, fenced code blocks,
 * links, ordered/unordered lists, tables, blockquotes, horizontal rules.
 *
 * Images are intentionally NOT rendered here — callers strip them out first
 * (see imageUtils) and show them in a separate thumbnail grid / lightbox.
 *
 * No dangerouslySetInnerHTML is used, so user content can never inject HTML.
 */

type Key = string | number;

// ---------------------------------------------------------------------------
// Inline parsing: code, bold, italic, strikethrough, links.
// ---------------------------------------------------------------------------

function renderInline(text: string, keyPrefix: Key): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  let remaining = text;
  let i = 0;

  // Order matters: inline code first (its contents are literal), then links,
  // then bold, then strikethrough, then italic.
  const patterns: { re: RegExp; render: (m: RegExpExecArray, k: string) => React.ReactNode }[] = [
    {
      re: /`([^`]+)`/,
      render: (m, k) => <code key={k} className="cgi-md-code">{m[1]}</code>,
    },
    {
      re: /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/,
      render: (m, k) => (
        <a key={k} href={m[2]} target="_blank" rel="noopener noreferrer" className="cgi-md-link">
          {m[1]}
        </a>
      ),
    },
    {
      re: /\*\*([^*]+)\*\*/,
      render: (m, k) => <strong key={k}>{renderInline(m[1], k)}</strong>,
    },
    {
      re: /__([^_]+)__/,
      render: (m, k) => <strong key={k}>{renderInline(m[1], k)}</strong>,
    },
    {
      re: /~~([^~]+)~~/,
      render: (m, k) => <del key={k}>{renderInline(m[1], k)}</del>,
    },
    {
      re: /\*([^*]+)\*/,
      render: (m, k) => <em key={k}>{renderInline(m[1], k)}</em>,
    },
    {
      re: /_([^_]+)_/,
      render: (m, k) => <em key={k}>{renderInline(m[1], k)}</em>,
    },
  ];

  while (remaining.length > 0) {
    let best: { index: number; match: RegExpExecArray; p: typeof patterns[number] } | null = null;
    for (const p of patterns) {
      const m = p.re.exec(remaining);
      if (m && (best === null || m.index < best.index)) {
        best = { index: m.index, match: m, p };
      }
    }

    if (!best) {
      nodes.push(remaining);
      break;
    }

    if (best.index > 0) {
      nodes.push(remaining.slice(0, best.index));
    }
    nodes.push(best.p.render(best.match, `${keyPrefix}-i${i++}`));
    remaining = remaining.slice(best.index + best.match[0].length);
  }

  return nodes;
}

// ---------------------------------------------------------------------------
// Block parsing.
// ---------------------------------------------------------------------------

function splitTableRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map(c => c.trim());
}

function isTableSeparator(line: string): boolean {
  return /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)+\|?\s*$/.test(line);
}

export const Markdown: React.FC<{ text: string; className?: string }> = ({ text, className }) => {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const blocks: React.ReactNode[] = [];
  let key = 0;
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Blank line
    if (line.trim() === '') {
      i++;
      continue;
    }

    // Fenced code block
    const fence = line.match(/^\s*```(.*)$/);
    if (fence) {
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // skip closing fence
      blocks.push(
        <pre key={key++} className="cgi-md-pre">
          <code>{codeLines.join('\n')}</code>
        </pre>
      );
      continue;
    }

    // Heading
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = heading[1].length;
      const Tag = (`h${Math.min(level, 6)}`) as keyof JSX.IntrinsicElements;
      blocks.push(
        <Tag key={key++} className={`cgi-md-h cgi-md-h${level}`}>
          {renderInline(heading[2], key)}
        </Tag>
      );
      i++;
      continue;
    }

    // Horizontal rule
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      blocks.push(<hr key={key++} className="cgi-md-hr" />);
      i++;
      continue;
    }

    // Table
    if (line.includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      const header = splitTableRow(line);
      i += 2; // skip header + separator
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
        rows.push(splitTableRow(lines[i]));
        i++;
      }
      blocks.push(
        <div key={key++} className="cgi-md-table-wrap">
          <table className="cgi-md-table">
            <thead>
              <tr>
                {header.map((c, ci) => (
                  <th key={ci}>{renderInline(c, `${key}-th${ci}`)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri}>
                  {r.map((c, ci) => (
                    <td key={ci}>{renderInline(c, `${key}-td${ri}-${ci}`)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
      continue;
    }

    // Blockquote
    if (/^\s*>\s?/.test(line)) {
      const quoteLines: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        quoteLines.push(lines[i].replace(/^\s*>\s?/, ''));
        i++;
      }
      blocks.push(
        <blockquote key={key++} className="cgi-md-quote">
          {renderInline(quoteLines.join(' '), key)}
        </blockquote>
      );
      continue;
    }

    // Ordered list
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: React.ReactNode[] = [];
      let li = 0;
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        const content = lines[i].replace(/^\s*\d+\.\s+/, '');
        items.push(<li key={li++}>{renderInline(content, `${key}-ol${li}`)}</li>);
        i++;
      }
      blocks.push(<ol key={key++} className="cgi-md-ol">{items}</ol>);
      continue;
    }

    // Unordered list
    if (/^\s*[-*+]\s+/.test(line)) {
      const items: React.ReactNode[] = [];
      let li = 0;
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        const content = lines[i].replace(/^\s*[-*+]\s+/, '');
        items.push(<li key={li++}>{renderInline(content, `${key}-ul${li}`)}</li>);
        i++;
      }
      blocks.push(<ul key={key++} className="cgi-md-ul">{items}</ul>);
      continue;
    }

    // Paragraph: consume consecutive non-blank, non-special lines
    const paraLines: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !/^\s*```/.test(lines[i]) &&
      !/^(#{1,6})\s+/.test(lines[i]) &&
      !/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(lines[i]) &&
      !/^\s*>\s?/.test(lines[i]) &&
      !/^\s*\d+\.\s+/.test(lines[i]) &&
      !/^\s*[-*+]\s+/.test(lines[i]) &&
      !(lines[i].includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1]))
    ) {
      paraLines.push(lines[i]);
      i++;
    }
    if (paraLines.length > 0) {
      blocks.push(
        <p key={key++} className="cgi-md-p">
          {renderInline(paraLines.join('\n'), key).flatMap((node, ni, arr) =>
            // Preserve single line breaks within a paragraph.
            typeof node === 'string'
              ? node.split('\n').flatMap((seg, si, segs) =>
                  si < segs.length - 1 ? [seg, <br key={`br-${ni}-${si}`} />] : [seg]
                )
              : [node]
          )}
        </p>
      );
    }
  }

  return <div className={`cgi-md${className ? ' ' + className : ''}`}>{blocks}</div>;
};
