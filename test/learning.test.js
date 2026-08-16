'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createLearningClient } = require('../lib/learning');

function makeStore(seed = {}) {
  const data = { ...seed };
  return {
    data,
    readTSV: async (rel) => (data[rel] || []).slice(),
    appendTSV: async (rel, row) => { (data[rel] = data[rel] || []).push(row); return true; },
    rewriteTSV: async (rel, fn) => { const before = (data[rel] || []).length; data[rel] = fn((data[rel] || []).slice()); return before - data[rel].length; },
  };
}

test('createLearningClient throws without readTSV/appendTSV/rewriteTSV', () => {
  assert.throws(() => createLearningClient({}));
});

test('listCourses attaches lessons (with progress status) and the resume list, newest first', async () => {
  const store = makeStore({
    'learning/courses.tsv': [{ ID: 'js101', NAME: 'JS Basics' }],
    'learning/progress.tsv': [{ COURSE_ID: 'js101', LESSON: '01-intro.md', STATUS: 'done', UPDATED_AT: '2026-08-01' }],
    'learning/resume.tsv': [{ COURSE_ID: 'js101', LESSON: '01-intro.md', UPDATED_AT: '2026-08-01T00:00:00Z' }],
  });
  const client = createLearningClient({ ...store,
    listLessonFiles: (id) => id === 'js101' ? [{ file: '01-intro.md', raw: '# Intro\nHello world', mtimeIso: '2026-08-01T00:00:00Z' }] : [],
  });
  const r = await client.listCourses();
  assert.equal(r.courses[0].lessons[0].title, 'Intro');
  assert.equal(r.courses[0].lessons[0].status, 'done');
  assert.equal(r.resume.length, 1);
});

test('getLesson rejects a path-escaping reference and throws for a missing lesson', async () => {
  const client = createLearningClient({ ...makeStore(), readLessonFile: async () => null });
  await assert.rejects(() => client.getLesson('js101', '../../etc/passwd'));
  await assert.rejects(() => client.getLesson('js101', 'missing.md'));
});

test('getLesson returns content for a valid reference', async () => {
  const client = createLearningClient({ ...makeStore(), readLessonFile: async () => '# Hello' });
  assert.equal((await client.getLesson('js101', '01-intro.md')).content, '# Hello');
});

test('saveNote writes via the injected writer and getNote reads it back', () => {
  let written = null;
  const client = createLearningClient({ ...makeStore(), writeNoteFile: (c, f, t) => { written = { c, f, t }; }, readNoteFile: () => written?.t || '' });
  client.saveNote('js101', '01-intro.md', 'my margin note');
  assert.equal(written.t, 'my margin note');
  assert.equal(client.getNote('js101', '01-intro.md').text, 'my margin note');
});

test('saveResume creates a new row, then updates it in place on a repeat call for the same course', async () => {
  const store = makeStore();
  const client = createLearningClient({ ...store });
  await client.saveResume({ course: 'js101', lesson: '01-intro.md', scrollPct: 40 });
  await client.saveResume({ course: 'js101', lesson: '02-vars.md', scrollPct: 80 });
  assert.equal(store.data['learning/resume.tsv'].length, 1);
  assert.equal(store.data['learning/resume.tsv'][0].LESSON, '02-vars.md');
  assert.equal(store.data['learning/resume.tsv'][0].SCROLL_PCT, '80');
});

test('saveProgress clamps status to a known value and creates or updates as appropriate', async () => {
  const store = makeStore();
  const client = createLearningClient({ ...store });
  await client.saveProgress({ course: 'js101', lesson: '01-intro.md', status: 'bogus' });
  assert.equal(store.data['learning/progress.tsv'][0].STATUS, 'learning');
  await client.saveProgress({ course: 'js101', lesson: '01-intro.md', status: 'done' });
  assert.equal(store.data['learning/progress.tsv'].length, 1);
  assert.equal(store.data['learning/progress.tsv'][0].STATUS, 'done');
});

test('contributions returns a 365-day series ending today', async () => {
  const client = createLearningClient({ ...makeStore() });
  const r = await client.contributions();
  assert.equal(r.days.length, 365);
  assert.equal(r.days[r.days.length - 1].date, new Date().toISOString().slice(0, 10));
});

test('saveGroup creates and updates groups, archiveGroup changes status', async () => {
  const store = makeStore({
    'learning/groups.tsv': []
  });
  const client = createLearningClient({ ...store });
  await client.saveGroup({ id: 'core-track', label: 'Core Track', description: 'Main topics', icon: '🚀' });
  assert.equal(store.data['learning/groups.tsv'].length, 1);
  assert.equal(store.data['learning/groups.tsv'][0].LABEL, 'Core Track');

  await client.archiveGroup('core-track', 'archived');
  assert.equal(store.data['learning/groups.tsv'][0].STATUS, 'archived');
});

test('setCourseStatus updates course status and group assignment', async () => {
  const store = makeStore({
    'learning/courses.tsv': [{ ID: 'c1', TITLE: 'Course 1', STATUS: 'active', GROUP_ID: 'g1' }]
  });
  const client = createLearningClient({ ...store });
  await client.setCourseStatus({ courseId: 'c1', status: 'archived', groupId: 'g2' });
  assert.equal(store.data['learning/courses.tsv'][0].STATUS, 'archived');
  assert.equal(store.data['learning/courses.tsv'][0].GROUP_ID, 'g2');
});

test('setModuleMeta saves and updates module relevance, version, reviewedAt', async () => {
  const store = makeStore({
    'learning/modules_meta.tsv': []
  });
  const client = createLearningClient({ ...store });
  await client.setModuleMeta({
    courseId: 'c1',
    lessonFile: '01-intro.md',
    relevance: 'period-specific',
    relevanceNote: 'August 2026 baseline',
    version: 'v1.0.0',
    reviewedAt: '2026-08-16'
  });
  assert.equal(store.data['learning/modules_meta.tsv'].length, 1);
  assert.equal(store.data['learning/modules_meta.tsv'][0].RELEVANCE, 'period-specific');
  assert.equal(store.data['learning/modules_meta.tsv'][0].VERSION, 'v1.0.0');
});

