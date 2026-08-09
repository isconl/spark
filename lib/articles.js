'use strict';
/**
 * Articles & Content Studio -- the list side. Ported from isconl-agent's
 * server.js (~9134-9190).
 *
 * OUT OF SCOPE: /api/articles/generate (draft/polish/expand/summarize/seo,
 * all processAiChat) -- spark's own AI routing, not built yet in this pass.
 * `listFiles` is injected (a directory scan) so this stays fs-agnostic.
 */

function createArticlesClient(opts) {
  const {
    listFiles = () => [],   // () => [{ file, rel, raw, bytes, mtimeIso }]
  } = opts;

  function listArticles() {
    const files = listFiles();
    const articles = files.map(({ file, rel, raw, bytes, mtimeIso }) => {
      let title = file;
      if (/\.(md|markdown|txt)$/i.test(file)) {
        const m = (raw || '').match(/^#+\s*(.+)$/m);
        if (m) title = m[1].trim();
      } else {
        title = file.replace(/\.docx$/i, '').replace(/_/g, ' ');
      }
      const words = ((raw || '').match(/\S+/g) || []).length;
      const status = /draft|wip|v0/i.test(file) ? 'drafting' : /review|v1/i.test(file) ? 'review' : /approved|final/i.test(file) ? 'approved' : 'published';
      return { file: rel, name: file, title, bytes, words, readingTime: Math.max(1, Math.ceil(words / 200)) + ' min read',
        modified: mtimeIso.slice(0, 10), status, ext: (file.match(/\.[^.]+$/) || [''])[0].toLowerCase() };
    });

    const seen = new Set();
    const unique = [];
    for (const a of articles) { if (seen.has(a.file)) continue; seen.add(a.file); unique.push(a); }
    unique.sort((a, b) => b.modified.localeCompare(a.modified));
    return { articles: unique, count: unique.length };
  }

  return { listArticles };
}

module.exports = { createArticlesClient };
