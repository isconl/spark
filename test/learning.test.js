'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createLearningClient } = require('../lib/learning');

function makeStore(seed = {}) {
  const data = { ...seed };
  return {
    data,
    readTSV: (rel) => (data[rel] || []).slice(),
    appendTSV: (rel, row) => { (data[rel] = data[rel] || []).push(row); },
    rewriteTSV: (rel, fn) => { const before = (data[rel] || []).length; data[rel] = fn((data[rel] || []).slice()); return before - data[rel].length; },
  };
}

test('createLearningClient throws without readTSV/appendTSV/rewriteTSV', () => {
  assert.throws(() => createLearningClient({}));
});

test('listCourses attaches lessons (with progress status) and the resume list, newest first', () => {
  const store = makeStore({
    'learning/courses.tsv': [{ ID: 'js101', NAME: 'JS Basics' }],
    'learning/progress.tsv': [{ COURSE_ID: 'js101', LESSON: '01-intro.md', STATUS: 'done', UPDATED_AT: '2026-08-01' }],
    'learning/resume.tsv': [{ COURSE_ID: 'js101', LESSON: '01-intro.md', UPDATED_AT: '2026-08-01T00:00:00Z' }],
  });
  const client = createLearningClient({ ...store,
    listLessonFiles: (id) => id === 'js101' ? [{ file: '01-intro.md', raw: '# Intro\nHello world', mtimeIso: '2026-08-01T00:00:00Z' }] : [],
  });
  const r = client.listCourses();
  assert.equal(r.courses[0].lessons[0].title, 'Intro');
  assert.equal(r.courses[0].lessons[0].status, 'done');
  assert.equal(r.resume.length, 1);
});

test('getLesson rejects a path-escaping reference and throws for a missing lesson', () => {
  const client = createLearningClient({ ...makeStore(), readLessonFile: () => null });
  assert.throws(() => client.getLesson('js101', '../../etc/passwd'));
  assert.throws(() => client.getLesson('js101', 'missing.md'));
});

test('getLesson returns content for a valid reference', () => {
  const client = createLearningClient({ ...makeStore(), readLessonFile: () => '# Hello' });
  assert.equal(client.getLesson('js101', '01-intro.md').content, '# Hello');
});

test('saveNote writes via the injected writer and getNote reads it back', () => {
  let written = null;
  const client = createLearningClient({ ...makeStore(), writeNoteFile: (c, f, t) => { written = { c, f, t }; }, readNoteFile: () => written?.t || '' });
  client.saveNote('js101', '01-intro.md', 'my margin note');
  assert.equal(written.t, 'my margin note');
  assert.equal(client.getNote('js101', '01-intro.md').text, 'my margin note');
});

test('saveResume creates a new row, then updates it in place on a repeat call for the same course', () => {
  const store = makeStore();
  const client = createLearningClient({ ...store });
  client.saveResume({ course: 'js101', lesson: '01-intro.md', scrollPct: 40 });
  client.saveResume({ course: 'js101', lesson: '02-vars.md', scrollPct: 80 });
  assert.equal(store.data['learning/resume.tsv'].length, 1);
  assert.equal(store.data['learning/resume.tsv'][0].LESSON, '02-vars.md');
  assert.equal(store.data['learning/resume.tsv'][0].SCROLL_PCT, '80');
});

test('saveProgress clamps status to a known value and creates or updates as appropriate', () => {
  const store = makeStore();
  const client = createLearningClient({ ...store });
  client.saveProgress({ course: 'js101', lesson: '01-intro.md', status: 'bogus' });
  assert.equal(store.data['learning/progress.tsv'][0].STATUS, 'learning');
  client.saveProgress({ course: 'js101', lesson: '01-intro.md', status: 'done' });
  assert.equal(store.data['learning/progress.tsv'].length, 1);
  assert.equal(store.data['learning/progress.tsv'][0].STATUS, 'done');
});

test('contributions returns a 365-day series ending today', () => {
  const client = createLearningClient({ ...makeStore() });
  const r = client.contributions();
  assert.equal(r.days.length, 365);
  assert.equal(r.days[r.days.length - 1].date, new Date().toISOString().slice(0, 10));
});
