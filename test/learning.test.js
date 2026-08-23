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

test('getManifest returns flat list of all lessons with revisions and versions', async () => {
  const store = makeStore({
    'learning/courses.tsv': [{ ID: 'js101', NAME: 'JS Basics' }],
    'learning/modules_meta.tsv': [{ COURSE_ID: 'js101', LESSON_FILE: '01-intro.md', VERSION: 'v1.2.0', REVIEWED_AT: '2026-08-20' }],
  });
  const client = createLearningClient({ ...store,
    listLessonFiles: (id) => id === 'js101' ? [{ file: '01-intro.md', raw: '# Intro\nHello world', mtimeIso: '2026-08-20T00:00:00Z' }] : [],
  });
  const r = await client.getManifest();
  assert.equal(r.ok, true);
  assert.equal(r.count, 1);
  assert.equal(r.lessons[0].course, 'js101');
  assert.equal(r.lessons[0].file, '01-intro.md');
  assert.equal(r.lessons[0].version, 'v1.2.0');
  assert.equal(r.lessons[0].rev, 'v1.2.0');
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

function daysAgo(n) {
  const d = new Date(); d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

test('campus() drops a TRIGGER=always row once it is older than 14 days', async () => {
  const store = makeStore({
    'learning/courses.tsv': [{ ID: 'c1', TITLE: 'Course 1' }],
    'learning/campus.tsv': [
      { ID: 'stale', BAND: 'now', COURSE_ID: 'c1', LESSON: '01-a.md', TRIGGER: 'always', STATUS: 'active', UPDATED_AT: daysAgo(20) },
    ],
  });
  const client = createLearningClient({ ...store,
    listLessonFiles: (id) => id === 'c1' ? [{ file: '01-a.md', raw: '# A', mtimeIso: daysAgo(20) }] : [],
  });
  const r = await client.campus();
  const nowBand = r.bands.find(b => b.key === 'now');
  assert.ok(!nowBand || !nowBand.items.some(i => i.lesson === '01-a.md'),
    'a 20-day-old always row should have expired out of "now"');
});

test('campus() keeps a TRIGGER=always row alive past 14 days when its module is RELEVANCE=evergreen', async () => {
  const store = makeStore({
    'learning/courses.tsv': [{ ID: 'c1', TITLE: 'Course 1' }],
    'learning/modules_meta.tsv': [{ COURSE_ID: 'c1', LESSON_FILE: '01-a.md', RELEVANCE: 'evergreen' }],
    'learning/campus.tsv': [
      { ID: 'evg', BAND: 'now', COURSE_ID: 'c1', LESSON: '01-a.md', TRIGGER: 'always', STATUS: 'active', UPDATED_AT: daysAgo(20) },
    ],
  });
  const client = createLearningClient({ ...store,
    listLessonFiles: (id) => id === 'c1' ? [{ file: '01-a.md', raw: '# A', mtimeIso: daysAgo(20) }] : [],
  });
  const r = await client.campus();
  const nowBand = r.bands.find(b => b.key === 'now');
  assert.ok(nowBand && nowBand.items.some(i => i.lesson === '01-a.md'),
    'an evergreen module should stay in "now" regardless of the row\'s own age');
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

test('primeBrief returns the lesson with the highest keyword overlap against the query', async () => {
  const store = makeStore({
    'learning/courses.tsv': [{ ID: 'js101', TITLE: 'JS Basics' }, { ID: 'py101', TITLE: 'Python Basics' }],
  });
  const client = createLearningClient({ ...store,
    listLessonFiles: async (id) => ({
      js101: [{ file: '01-intro.md', raw: 'closures and scope in javascript, closures again' }],
      py101: [{ file: '01-intro.md', raw: 'variables and loops in python' }],
    }[id] || []),
  });
  const r = await client.primeBrief({ q: 'explain closures in javascript' });
  assert.equal(r.ok, true);
  assert.equal(r.course, 'JS Basics');
  assert.equal(r.file, '01-intro.md');
});

test('primeBrief returns ok:false when nothing overlaps or no query is given', async () => {
  const store = makeStore({ 'learning/courses.tsv': [{ ID: 'js101', TITLE: 'JS Basics' }] });
  const client = createLearningClient({ ...store, listLessonFiles: async () => [{ file: '01.md', raw: 'unrelated content here' }] });
  assert.equal((await client.primeBrief({ q: 'zzzzz nomatch terms' })).ok, false);
  assert.equal((await client.primeBrief({})).ok, false);
});

