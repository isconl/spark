'use strict';
/**
 * BL26082601: Canonical learning markdown parser turning .md into a
 * normalized JSON block-tree (equations, charts, maps, images, callouts, tables, etc.).
 *
 * Implements course-standards.md §3 (the 6 callouts) and §4 (inline media:
 * equations, charts, maps, images), reused by both web and mobile readers.
 */

const CALLOUT_TYPES = {
  'you will be able to': { kind: 'objective', icon: '🎯', color: '#10b981' },
  'what you will learn': { kind: 'objective', icon: '🎯', color: '#10b981' },
  'what will be learnt': { kind: 'objective', icon: '🎯', color: '#10b981' },
  'watch for': { kind: 'watch_for', icon: '⚠️', color: '#f59e0b' },
  'what to watch for': { kind: 'watch_for', icon: '⚠️', color: '#f59e0b' },
  'watch out for': { kind: 'watch_for', icon: '⚠️', color: '#f59e0b' },
  'careful': { kind: 'watch_for', icon: '⚠️', color: '#f59e0b' },
  'jargon': { kind: 'jargon', icon: '💡', color: '#3b82f6' },
  'in plain language': { kind: 'jargon', icon: '💡', color: '#3b82f6' },
  'plain language': { kind: 'jargon', icon: '💡', color: '#3b82f6' },
  'the word': { kind: 'jargon', icon: '💡', color: '#3b82f6' },
  'in a book': { kind: 'book', icon: '📖', color: '#8b5cf6', requiresCitation: true },
  'book': { kind: 'book', icon: '📖', color: '#8b5cf6', requiresCitation: true },
  'book quote': { kind: 'book_quote', icon: '💬', color: '#ec4899', requiresCitation: true },
  'research': { kind: 'research', icon: '📊', color: '#0ea5e9', requiresCitation: true },
  'fun fact': { kind: 'fun_fact', icon: '✨', color: '#14b8a6' },
};

const CALLOUT_REGEX = /^\*\*(Jargon|In plain language|Plain language|The word|In a book|Book|Research|Book quote|Fun fact|You will be able to|What you will learn|What will be learnt|Watch for|What to watch for|Watch out for|Careful):?\*\*\s*([\s\S]*)/i;

function parseChartSpec(body) {
  const lines = body.trim().split(/\r?\n/);
  const spec = { type: 'bar', title: '', items: [] };
  for (const line of lines) {
    const mType = line.match(/^type:\s*(bar|line|pie)/i);
    if (mType) { spec.type = mType[1].toLowerCase(); continue; }
    const mTitle = line.match(/^title:\s*(.*)/i);
    if (mTitle) { spec.title = mTitle[1].trim(); continue; }
    const mVal = line.match(/^([^:]+):\s*(-?\d+(?:\.\d+)?)/);
    if (mVal) {
      spec.items.push({ label: mVal[1].trim(), value: parseFloat(mVal[2]) });
    }
  }
  return spec;
}

function parseMapSpec(body) {
  const lines = body.trim().split(/\r?\n/);
  const spec = { lat: 0, lon: 0, zoom: 11, label: '' };
  for (const line of lines) {
    const mLat = line.match(/^lat:\s*(-?\d+(?:\.\d+)?)/i);
    if (mLat) { spec.lat = parseFloat(mLat[1]); continue; }
    const mLon = line.match(/^lon:\s*(-?\d+(?:\.\d+)?)/i);
    if (mLon) { spec.lon = parseFloat(mLon[1]); continue; }
    const mZoom = line.match(/^zoom:\s*(\d+)/i);
    if (mZoom) { spec.zoom = parseInt(mZoom[1], 10); continue; }
    const mLabel = line.match(/^label:\s*(.*)/i);
    if (mLabel) { spec.label = mLabel[1].trim(); continue; }
  }
  return spec;
}

function parseMarkdownBlockTree(markdown) {
  const src = String(markdown || '');
  const lines = src.split(/\r?\n/);
  const blocks = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Blank line
    if (!line.trim()) {
      i++;
      continue;
    }

    // Fenced code block or media block
    if (line.startsWith('```')) {
      const tag = line.slice(3).trim().toLowerCase();
      const codeLines = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      if (i < lines.length && lines[i].startsWith('```')) i++;
      const body = codeLines.join('\n');

      if (tag === 'chart') {
        blocks.push({ type: 'chart', spec: parseChartSpec(body), raw: body });
      } else if (tag === 'map') {
        blocks.push({ type: 'map', spec: parseMapSpec(body), raw: body });
      } else {
        blocks.push({ type: 'code', language: tag || 'text', code: body });
      }
      continue;
    }

    // Display math equation $$...$$
    if (line.startsWith('$$')) {
      const eqLines = [];
      if (line.endsWith('$$') && line.length > 2) {
        eqLines.push(line.slice(2, -2).trim());
        i++;
      } else {
        eqLines.push(line.slice(2));
        i++;
        while (i < lines.length && !lines[i].includes('$$')) {
          eqLines.push(lines[i]);
          i++;
        }
        if (i < lines.length) {
          const last = lines[i];
          const endIdx = last.indexOf('$$');
          eqLines.push(last.slice(0, endIdx));
          i++;
        }
      }
      blocks.push({ type: 'equation', block: true, latex: eqLines.join('\n').trim() });
      continue;
    }

    // Headings
    const headingMatch = line.match(/^(#{1,6})\s+(.*)$/);
    if (headingMatch) {
      blocks.push({
        type: 'heading',
        level: headingMatch[1].length,
        text: headingMatch[2].trim()
      });
      i++;
      continue;
    }

    // Horizontal Rule
    if (/^\s*(---+|\*\*\*+|___+)\s*$/.test(line)) {
      blocks.push({ type: 'divider' });
      i++;
      continue;
    }

    // Blockquote
    if (/^>\s?/.test(line)) {
      const quoteLines = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        quoteLines.push(lines[i].replace(/^>\s?/, ''));
        i++;
      }
      blocks.push({ type: 'blockquote', text: quoteLines.join('\n').trim() });
      continue;
    }

    // Tables
    if (/^\s*\|.*\|\s*$/.test(line)) {
      const tableLines = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
        tableLines.push(lines[i]);
        i++;
      }
      if (tableLines.length >= 2) {
        const rows = tableLines
          .filter(l => !/^\s*\|[\s:|-]+\|\s*$/.test(l))
          .map(l => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim()));
        if (rows.length) {
          blocks.push({
            type: 'table',
            header: rows[0],
            rows: rows.slice(1)
          });
          continue;
        }
      }
    }

    // Callout
    const calloutMatch = line.match(CALLOUT_REGEX);
    if (calloutMatch) {
      const key = calloutMatch[1].toLowerCase();
      const meta = CALLOUT_TYPES[key] || { kind: 'custom', icon: '📌', color: '#6366f1' };
      const parts = [calloutMatch[2]];
      i++;
      while (i < lines.length && lines[i].trim() && !lines[i].startsWith('#') && !lines[i].startsWith('```') && !lines[i].startsWith('|') && !CALLOUT_REGEX.test(lines[i])) {
        parts.push(lines[i]);
        i++;
      }
      const fullText = parts.join(' ').trim();
      const citationMatch = fullText.match(/\[([^\]]+)\]\s*$/);
      const citation = citationMatch ? citationMatch[1].trim() : null;
      const bodyText = citationMatch ? fullText.slice(0, citationMatch.index).trim() : fullText;

      // Lint check / degradation check
      if (meta.requiresCitation && !citation) {
        // Degrade to paragraph per course-standards.md §3
        blocks.push({ type: 'paragraph', text: `**${calloutMatch[1]}:** ${fullText}` });
      } else {
        blocks.push({
          type: 'callout',
          calloutType: meta.kind,
          label: calloutMatch[1],
          icon: meta.icon,
          color: meta.color,
          text: bodyText,
          citation: citation,
          raw: fullText
        });
      }
      continue;
    }

    // List item (ordered or unordered)
    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const listItems = [];
      const isOrdered = /^\s*\d+\.\s+/.test(line);
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) {
        const itemText = lines[i].replace(/^\s*([-*]|\d+\.)\s+/, '').trim();
        listItems.push(itemText);
        i++;
      }
      blocks.push({
        type: 'list',
        ordered: isOrdered,
        items: listItems
      });
      continue;
    }

    // Standalone image: ![alt](url)
    const imgMatch = line.match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
    if (imgMatch) {
      blocks.push({
        type: 'image',
        alt: imgMatch[1].trim(),
        url: imgMatch[2].trim()
      });
      i++;
      continue;
    }

    // Default: Paragraph (accumulate until blank line or next block)
    const pLines = [line];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() &&
      !lines[i].startsWith('#') &&
      !lines[i].startsWith('```') &&
      !lines[i].startsWith('$$') &&
      !lines[i].startsWith('>') &&
      !lines[i].startsWith('|') &&
      !/^\s*([-*]|\d+\.)\s+/.test(lines[i]) &&
      !CALLOUT_REGEX.test(lines[i]) &&
      !lines[i].match(/^!\[([^\]]*)\]\(([^)]+)\)$/)
    ) {
      pLines.push(lines[i]);
      i++;
    }
    blocks.push({
      type: 'paragraph',
      text: pLines.join(' ').trim()
    });
  }

  return { blocks };
}

module.exports = {
  parseMarkdownBlockTree,
  parseChartSpec,
  parseMapSpec
};
