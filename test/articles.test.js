'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createArticlesClient } = require('../lib/articles');

test('listArticles derives title from the first markdown heading, falling back to the filename', () => {
  const client = createArticlesClient({ listFiles: () => [
    { file: '20260101_essay.md', rel: 'articles/20260101_essay.md', raw: '# The Real Title\n\nBody text here that is long enough to count words properly for reading time.', bytes: 100, mtimeIso: '2026-08-01T00:00:00Z' },
  ] });
  const r = client.listArticles();
  assert.equal(r.articles[0].title, 'The Real Title');
});

test('listArticles derives a docx title from the filename when there is no heading to read', () => {
  const client = createArticlesClient({ listFiles: () => [
    { file: 'my_report_final.docx', rel: 'articles/my_report_final.docx', raw: '', bytes: 500, mtimeIso: '2026-08-01T00:00:00Z' },
  ] });
  const r = client.listArticles();
  assert.equal(r.articles[0].title, 'my report final');
});

test('listArticles classifies status from filename hints (draft/review/approved/published)', () => {
  const client = createArticlesClient({ listFiles: () => [
    { file: 'a_draft.md', rel: 'a_draft.md', raw: '', bytes: 1, mtimeIso: '2026-08-01T00:00:00Z' },
    { file: 'b_review_v1.md', rel: 'b_review_v1.md', raw: '', bytes: 1, mtimeIso: '2026-08-02T00:00:00Z' },
    { file: 'c_approved.md', rel: 'c_approved.md', raw: '', bytes: 1, mtimeIso: '2026-08-03T00:00:00Z' },
    { file: 'd_plain.md', rel: 'd_plain.md', raw: '', bytes: 1, mtimeIso: '2026-08-04T00:00:00Z' },
  ] });
  const byName = Object.fromEntries(client.listArticles().articles.map(a => [a.name, a.status]));
  assert.equal(byName['a_draft.md'], 'drafting');
  assert.equal(byName['b_review_v1.md'], 'review');
  assert.equal(byName['c_approved.md'], 'approved');
  assert.equal(byName['d_plain.md'], 'published');
});

test('listArticles sorts newest-modified first and dedupes by rel path', () => {
  const client = createArticlesClient({ listFiles: () => [
    { file: 'old.md', rel: 'x/old.md', raw: '', bytes: 1, mtimeIso: '2026-01-01T00:00:00Z' },
    { file: 'new.md', rel: 'x/new.md', raw: '', bytes: 1, mtimeIso: '2026-08-01T00:00:00Z' },
    { file: 'new.md', rel: 'x/new.md', raw: '', bytes: 1, mtimeIso: '2026-08-01T00:00:00Z' },
  ] });
  const r = client.listArticles();
  assert.equal(r.count, 2);
  assert.equal(r.articles[0].name, 'new.md');
});

test('listArticles computes a rough reading time from word count', () => {
  const client = createArticlesClient({ listFiles: () => [
    { file: 'x.md', rel: 'x.md', raw: Array(400).fill('word').join(' '), bytes: 2000, mtimeIso: '2026-08-01T00:00:00Z' },
  ] });
  assert.equal(client.listArticles().articles[0].readingTime, '2 min read');
});
