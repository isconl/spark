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
    listLessonFiles = () => [],       // (courseId) => [{ file, raw, mtimeIso }]
    readLessonFile = () => null,      // (courseId, file) => string|null
    readNoteFile = () => '',          // (courseId, file) => string
    writeNoteFile = () => {},         // (courseId, file, text) => void
  } = opts;
  if (!readTSV || !appendTSV || !rewriteTSV) throw new Error('createLearningClient requires readTSV/appendTSV/rewriteTSV');

  function listCourses() {
    const courses = readTSV('learning/courses.tsv');
    const progress = readTSV('learning/progress.tsv');
    const resume = readTSV('learning/resume.tsv').filter(r => r.COURSE_ID && r.LESSON)
      .sort((a, b) => String(b.UPDATED_AT || '').localeCompare(String(a.UPDATED_AT || '')));

    const out = courses.map(c => {
      const lessons = listLessonFiles(c.ID).map(({ file, raw, mtimeIso }) => {
        const first = raw.split(/\r?\n/, 1)[0];
        const p = progress.find(r => r.COURSE_ID === c.ID && r.LESSON === file);
        return { file, title: first.replace(/^#+\s*/, '').trim() || file,
          status: p ? p.STATUS : 'new', touchedAt: p && p.UPDATED_AT && p.UPDATED_AT !== '-' ? p.UPDATED_AT : null,
          revisedAt: mtimeIso, words: (raw.match(/\S+/g) || []).length, vaultPath: `learning/${c.ID}/${file}` };
      });
      return { ...c, lessons };
    });
    return { courses: out, resume };
  }

  function getLesson(course, file) {
    if (!/^[\w-]+$/.test(course) || !/^[\w.-]+\.md$/i.test(file) || file.includes('..')) throw new Error('bad lesson reference');
    const content = readLessonFile(course, file);
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

  function saveResume(p) {
    if (!/^[\w-]+$/.test(String(p.course || '')) || !/^[\w.-]+\.md$/i.test(String(p.lesson || ''))) throw new Error('course and lesson required');
    const pct = Math.max(0, Math.min(100, Math.round(Number(p.scrollPct) || 0)));
    let found = false;
    rewriteTSV('learning/resume.tsv', rows => rows.map(r => {
      if (r.COURSE_ID === p.course) { found = true; return { COURSE_ID: p.course, LESSON: p.lesson, SCROLL_PCT: String(pct), UPDATED_AT: new Date().toISOString() }; }
      return r;
    }));
    if (!found) appendTSV('learning/resume.tsv', { COURSE_ID: p.course, LESSON: p.lesson, SCROLL_PCT: String(pct), UPDATED_AT: new Date().toISOString() });
    return { success: true };
  }

  function saveProgress(p) {
    if (!p.course || !p.lesson) throw new Error('course and lesson required');
    const status = ['new', 'learning', 'done'].includes(p.status) ? p.status : 'learning';
    let found = false;
    rewriteTSV('learning/progress.tsv', rows => rows.map(r => {
      if (r.COURSE_ID === p.course && r.LESSON === p.lesson) { found = true; return { ...r, STATUS: status, UPDATED_AT: new Date().toISOString().slice(0, 10) }; }
      return r;
    }));
    if (!found) appendTSV('learning/progress.tsv', { COURSE_ID: p.course, LESSON: p.lesson, STATUS: status, UPDATED_AT: new Date().toISOString().slice(0, 10) });
    auditLog.log('lesson_progress', { course: p.course, lesson: p.lesson, status });
    return { success: true };
  }

  function contributions() {
    const resumeRows = readTSV('learning/resume.tsv');
    const countsByDate = {};
    const today = new Date();
    for (let i = 364; i >= 0; i--) countsByDate[new Date(today.getTime() - i * 86400000).toISOString().slice(0, 10)] = 0;
    for (const r of resumeRows) {
      if (r.UPDATED_AT) { const dt = String(r.UPDATED_AT).slice(0, 10); if (countsByDate[dt] !== undefined) countsByDate[dt]++; }
    }
    return { days: Object.entries(countsByDate).map(([date, count]) => ({ date, count })) };
  }

  return { listCourses, getLesson, getNote, saveNote, saveResume, saveProgress, contributions };
}

module.exports = { createLearningClient };
