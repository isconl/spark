'use strict';
/**
 * Learning space: course catalogue, resume tracking, contribution heatmap.
 * Ported from isconl-agent's server.js (~9245-9345, ~9474-9550 notes/lesson/progress).
 *
 * Courses live in the vault (learning/<course>/*.md + the registry), so
 * lessons are read here as plain files. OUT OF SCOPE: the tutor
 * (/api/learning/tutor, processAiChat-grounded) -- spark's own AI routing,
 * not built yet in this pass. `readLessonFile`/`writeNoteFile` are injected
 * (small fs helpers) so this module doesn't hard-depend on a real
 * filesystem in tests.
 */

function createLearningClient(opts) {
  const {
    readTSV, appendTSV, rewriteTSV,
    auditLog = { log: () => {} },
    listLessonFiles = async () => [],       // (courseId) => Promise<[{ file, raw, mtimeIso }]>
    readLessonFile = async () => null,      // (courseId, file) => Promise<string|null>
    readNoteFile = () => '',                // (courseId, file) => string
    writeNoteFile = () => {},               // (courseId, file, text) => void
  } = opts;
  if (!readTSV || !appendTSV || !rewriteTSV) throw new Error('createLearningClient requires readTSV/appendTSV/rewriteTSV');

  async function listCourses() {
    const courses = await readTSV('learning/courses.tsv');
    const progress = await readTSV('learning/progress.tsv');
    const resume = (await readTSV('learning/resume.tsv')).filter(r => r.COURSE_ID && r.LESSON)
      .sort((a, b) => String(b.UPDATED_AT || '').localeCompare(String(a.UPDATED_AT || '')));

    const out = await Promise.all(courses.map(async c => {
      const files = await listLessonFiles(c.ID);
      const lessons = files.map(({ file, raw, mtimeIso }) => {
        const first = raw.split(/\r?\n/, 1)[0];
        const p = progress.find(r => r.COURSE_ID === c.ID && r.LESSON === file);
        return { file, title: first.replace(/^#+\s*/, '').trim() || file,
          status: p ? p.STATUS : 'new', touchedAt: p && p.UPDATED_AT && p.UPDATED_AT !== '-' ? p.UPDATED_AT : null,
          revisedAt: mtimeIso, words: (raw.match(/\S+/g) || []).length, vaultPath: `learning/${c.ID}/${file}` };
      });
      return { ...c, lessons };
    }));
    return { courses: out, resume };
  }

  async function getLesson(course, file) {
    if (!/^[\w-]+$/.test(course) || !/^[\w.-]+\.md$/i.test(file) || file.includes('..')) throw new Error('bad lesson reference');
    const content = await readLessonFile(course, file);
    if (content == null) throw new Error('no such lesson');
    return { content };
  }

  function getNote(course, file) {
    if (!/^[\w-]+$/.test(course) || !/^[\w.-]+\.md$/i.test(file) || file.includes('..')) throw new Error('bad lesson reference');
    return { course, file, text: readNoteFile(course, file) || '' };
  }

  function saveNote(course, file, text) {
    if (!/^[\w-]+$/.test(course) || !/^[\w.-]+\.md$/i.test(file) || file.includes('..')) throw new Error('bad lesson reference');
    writeNoteFile(course, file, String(text || ''));
    auditLog.log('lesson_note_saved', { course, lesson: file, chars: String(text || '').length });
    return { success: true, updatedAt: new Date().toISOString() };
  }

  async function saveResume(p) {
    if (!/^[\w-]+$/.test(String(p.course || '')) || !/^[\w.-]+\.md$/i.test(String(p.lesson || ''))) throw new Error('course and lesson required');
    const pct = Math.max(0, Math.min(100, Math.round(Number(p.scrollPct) || 0)));
    let found = false;
    await rewriteTSV('learning/resume.tsv', rows => rows.map(r => {
      if (r.COURSE_ID === p.course) { found = true; return { COURSE_ID: p.course, LESSON: p.lesson, SCROLL_PCT: String(pct), UPDATED_AT: new Date().toISOString() }; }
      return r;
    }));
    if (!found) await appendTSV('learning/resume.tsv', { COURSE_ID: p.course, LESSON: p.lesson, SCROLL_PCT: String(pct), UPDATED_AT: new Date().toISOString() });
    return { success: true };
  }

  async function saveProgress(p) {
    if (!p.course || !p.lesson) throw new Error('course and lesson required');
    const status = ['new', 'learning', 'done'].includes(p.status) ? p.status : 'learning';
    let found = false;
    await rewriteTSV('learning/progress.tsv', rows => rows.map(r => {
      if (r.COURSE_ID === p.course && r.LESSON === p.lesson) { found = true; return { ...r, STATUS: status, UPDATED_AT: new Date().toISOString().slice(0, 10) }; }
      return r;
    }));
    if (!found) await appendTSV('learning/progress.tsv', { COURSE_ID: p.course, LESSON: p.lesson, STATUS: status, UPDATED_AT: new Date().toISOString().slice(0, 10) });
    auditLog.log('lesson_progress', { course: p.course, lesson: p.lesson, status });
    return { success: true };
  }

  /**
   * "The campus": standing advice on what to read next, ported from legacy's
   * buildCampus() (server.js ~12262-12384, dev branch). Hand-authored rows in
   * learning/campus.tsv (BAND/COURSE_ID/LESSON/HEADLINE/WHY/TRIGGER/MINUTES)
   * assign lessons to priority bands; when nothing is live there, it computes
   * a fallback instead of going blank -- the resume point first, then the
   * first unfinished module of each active course -- and marks itself
   * `computed: true` so the UI can say "this was worked out for you" rather
   * than implying someone curated it.
   *
   * TRIGGER: always (permanent) | unread (drops off once done) |
   * until:YYYY-MM-DD (time-boxed, expires on its own).
   */
  async function campus() {
    const BANDS = [
      { key: 'now',          label: 'Read now',         tone: 'urgent' },
      { key: 'week',         label: 'This week',        tone: 'warm' },
      { key: 'before-event', label: 'Before the room',  tone: 'warm' },
      { key: 'reference',    label: 'When it comes up',  tone: 'plain' },
      { key: 'background',   label: 'Background',       tone: 'quiet' },
    ];
    const today = new Date().toISOString().slice(0, 10);
    const { courses, resume } = await listCourses();
    const live = courses.filter(c => String(c.STATUS || 'active').toLowerCase() !== 'archived');
    const byId = {};
    for (const c of live) byId[String(c.ID)] = c;

    const doneOf = {};
    for (const r of await readTSV('learning/progress.tsv')) {
      doneOf[`${r.COURSE_ID}/${r.LESSON}`] = String(r.STATUS || '').toLowerCase();
    }
    const lessonOf = (courseId, file) => (byId[courseId]?.lessons || []).find(l => l.file === file) || null;

    const rowLive = (row) => {
      if (String(row.STATUS || 'active').toLowerCase() !== 'active') return false;
      const trig = String(row.TRIGGER || 'always').toLowerCase();
      if (trig === 'always') return true;
      if (trig === 'unread') return doneOf[`${row.COURSE_ID}/${row.LESSON}`] !== 'done';
      const until = trig.match(/^until:(\d{4}-\d{2}-\d{2})$/);
      if (until) return today <= until[1];
      return true;
    };

    let rows = [];
    let updatedAt = '';
    for (const r of await readTSV('learning/campus.tsv')) {
      const u = String(r.UPDATED_AT || '');
      if (u > updatedAt) updatedAt = u;
      if (r.COURSE_ID && byId[String(r.COURSE_ID)] && rowLive(r)) rows.push(r);
    }

    const itemFrom = (r) => {
      const course = byId[String(r.COURSE_ID)];
      const lesson = r.LESSON && r.LESSON !== '-' ? String(r.LESSON) : '';
      const l = lesson ? lessonOf(String(r.COURSE_ID), lesson) : null;
      return {
        courseId: String(r.COURSE_ID),
        courseTitle: course ? String(course.TITLE || course.ID) : String(r.COURSE_ID),
        lesson,
        title: r.HEADLINE && r.HEADLINE !== '-' ? String(r.HEADLINE) : (l ? String(l.title || lesson) : String(course?.TITLE || r.COURSE_ID)),
        headline: l ? String(l.title || '') : '',
        why: r.WHY && r.WHY !== '-' ? String(r.WHY) : '',
        minutes: Number(r.MINUTES) || 0,
        status: lesson ? (doneOf[`${r.COURSE_ID}/${lesson}`] || 'new') : 'new',
        missing: Boolean(lesson && !l),
      };
    };

    let bands = BANDS
      .map(b => ({ ...b, items: rows.filter(r => String(r.BAND || '').toLowerCase() === b.key).map(itemFrom) }))
      .filter(b => b.items.length);

    let computed = false;
    if (!bands.length) {
      computed = true;
      const items = [];
      for (const r of (resume || []).slice(0, 1)) {
        const course = byId[String(r.COURSE_ID)];
        if (!course) continue;
        const l = lessonOf(String(r.COURSE_ID), String(r.LESSON));
        items.push({
          courseId: String(r.COURSE_ID), courseTitle: String(course.TITLE || course.ID),
          lesson: String(r.LESSON), title: l ? String(l.title || r.LESSON) : String(r.LESSON),
          headline: '', why: 'Where you stopped reading.', minutes: 0,
          status: doneOf[`${r.COURSE_ID}/${r.LESSON}`] || 'learning', missing: !l,
        });
      }
      for (const c of live) {
        if (String(c.STATUS || 'active').toLowerCase() !== 'active') continue;
        const next = (c.lessons || []).find(l => doneOf[`${c.ID}/${l.file}`] !== 'done'
          && !items.some(i => i.courseId === String(c.ID) && i.lesson === l.file));
        if (!next) continue;
        items.push({
          courseId: String(c.ID), courseTitle: String(c.TITLE || c.ID),
          lesson: String(next.file), title: String(next.title || next.file),
          headline: '', why: 'The next module in this course.', minutes: 0, status: 'new', missing: false,
        });
        if (items.length >= 6) break;
      }
      if (items.length) bands = [{ key: 'now', label: 'Next up', tone: 'warm', items }];
    }

    return {
      bands,
      minutes: (bands.find(b => b.key === 'now')?.items || []).reduce((a, i) => a + (i.minutes || 0), 0),
      computed, updatedAt: updatedAt || null,
      total: bands.reduce((a, b) => a + b.items.length, 0),
    };
  }

  async function contributions() {
    const resumeRows = await readTSV('learning/resume.tsv');
    const countsByDate = {};
    const today = new Date();
    for (let i = 364; i >= 0; i--) countsByDate[new Date(today.getTime() - i * 86400000).toISOString().slice(0, 10)] = 0;
    for (const r of resumeRows) {
      if (r.UPDATED_AT) { const dt = String(r.UPDATED_AT).slice(0, 10); if (countsByDate[dt] !== undefined) countsByDate[dt]++; }
    }
    return { days: Object.entries(countsByDate).map(([date, count]) => ({ date, count })) };
  }

  return { listCourses, getLesson, getNote, saveNote, saveResume, saveProgress, contributions, campus };
}

module.exports = { createLearningClient };
