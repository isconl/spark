'use strict';
/**
 * Learning space: course catalogue, resume tracking, contribution heatmap,
 * intelligent track/group classification, module metadata (version, reviewedAt, relevance),
 * and lifecycle management (decommission/archive/disable groups, courses, modules).
 *
 * Courses live in the vault (learning/<course>/*.md + registry TSVs).
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

  // Current 5-track taxonomy, crystallized 3 Sep 2026 (course-standards.md
  // §0) -- GROUP_IDs here must match courses.tsv's own GROUP_ID column
  // exactly (verified live 3 Sep 2026 against all 32 course rows) so every
  // course resolves through its real GROUP_ID below instead of falling
  // back to CLASSROOM text-matching. Replaces the stale Aug-17 6-group
  // list (inside-the-engagement/platform-and-systems/business-and-market/
  // money-that-compounds/people-and-mentoring/medicine-and-surgery), none
  // of which matched any live course's GROUP_ID -- every course was
  // silently falling through to text-matching and landing under a
  // mislabeled "and"-joined bucket instead of the real "&"-joined track.
  const DEFAULT_GROUPS = [
    {
      GROUP_ID: 'corporate-mandate',
      LABEL: 'Corporate & Mandate',
      DESCRIPTION: 'The live Viva engagement end to end -- the mandate, meetings decoded, task execution, mentoring new talent, the twin portals, and WABBA/Wellspring site work.',
      ICON: '🏢',
      COLOR: '#3b82f6',
      STATUS: 'active',
      SORT_ORDER: '1',
      UPDATED_AT: '2026-09-03'
    },
    {
      GROUP_ID: 'markets-economics',
      LABEL: 'Markets & Economics',
      DESCRIPTION: 'Country-by-country market intelligence -- business etiquette, culture, and negotiation gotchas across the ten live markets.',
      ICON: '🌍',
      COLOR: '#0ea5e9',
      STATUS: 'active',
      SORT_ORDER: '2',
      UPDATED_AT: '2026-09-03'
    },
    {
      GROUP_ID: 'medicine-surgery',
      LABEL: 'Medicine & Surgery',
      DESCRIPTION: 'Anatomy, first aid, trauma response, conditions, pharmacology, prevention, population-specific care, and surgery -- zero to hero, one module at a time.',
      ICON: '🩺',
      COLOR: '#ef4444',
      STATUS: 'active',
      SORT_ORDER: '3',
      UPDATED_AT: '2026-09-03'
    },
    {
      GROUP_ID: 'sales-persuasion',
      LABEL: 'Sales & Persuasion',
      DESCRIPTION: 'World-class sales and negotiation from zero to hero, plus the Command the Room speaking tracks -- craft, rhetoric, formats, and legendary presence.',
      ICON: '🤝',
      COLOR: '#f59e0b',
      STATUS: 'active',
      SORT_ORDER: '4',
      UPDATED_AT: '2026-09-03'
    },
    {
      GROUP_ID: 'wealth-finance',
      LABEL: 'Wealth & Finance',
      DESCRIPTION: 'Sovereign capital allocation, compounding velocity, valuation math, debt leverage, and the roadmap to $1B net worth.',
      ICON: '📈',
      COLOR: '#10b981',
      STATUS: 'active',
      SORT_ORDER: '5',
      UPDATED_AT: '2026-09-03'
    }
  ];

  // Module filename format per course-standards.md §0 (crystallized 3 Sep
  // 2026): YYYYMMDD_track_course_module_v#_#_#.md -- track is GROUP_ID
  // with underscores, course is the Course ID with underscores (always
  // known here as courseId), module is an index_slug, version is
  // underscore-separated (v1_0_0, not the old dot-separated v1.0.0).
  // courseId anchors the match so the variable-length track segment never
  // has to be guessed. Replaces the pre-3-Sep `..._campus_..._v0.0.0.md`
  // pattern, which no current file matches at all -- every real,
  // correctly-named file was silently falling through to the hardcoded
  // fallback below (blank index, version forced to v0.0.0, reviewedAt
  // forced to 2026-08-16 regardless of the file's real date).
  function parseLessonFilename(filename, courseId) {
    const courseSlug = String(courseId || '').replace(/-/g, '_');
    if (courseSlug) {
      const re = new RegExp(`^(\\d{4})(\\d{2})(\\d{2})_[a-z0-9_]+?_${courseSlug}_([0-9]+)_(.+?)_v(\\d+)_(\\d+)_(\\d+)\\.md$`, 'i');
      const m = filename.match(re);
      if (m) {
        return {
          reviewedAt: `${m[1]}-${m[2]}-${m[3]}`,
          index: m[4],
          slug: m[5],
          version: `v${m[6]}.${m[7]}.${m[8]}`
        };
      }
    }
    // Legacy pre-3-Sep pattern, kept for any not-yet-renamed file.
    const legacy = filename.match(/^(\d{4})(\d{2})(\d{2})_campus_[a-z0-9_-]+_([0-9a-z]+)_(.+?)_(v\d+\.\d+\.\d+)\.md$/i);
    if (legacy) {
      return {
        reviewedAt: `${legacy[1]}-${legacy[2]}-${legacy[3]}`,
        index: legacy[4],
        slug: legacy[5],
        version: legacy[6]
      };
    }
    return {
      reviewedAt: '2026-08-16',
      index: '',
      slug: filename.replace(/\.md$/i, ''),
      version: 'v0.0.0'
    };
  }

  function defaultRelevanceFor(courseId, file) {
    if (courseId === 'viva-meetings' && !file.includes('_00_') && !file.includes('_01_')) {
      return { relevance: 'period-specific', note: 'Historical engagement meeting / sprint record from August 2026' };
    }
    return { relevance: 'current', note: 'Verified current operational standard' };
  }

  async function getRawGroups() {
    const raw = await readTSV('learning/groups.tsv');
    if (!raw || !raw.length) return DEFAULT_GROUPS;
    return raw;
  }

  async function listCourses(opts = {}) {
    const { includeArchived = true } = opts;
    const coursesRaw = await readTSV('learning/courses.tsv');
    const progress = await readTSV('learning/progress.tsv');
    const resume = (await readTSV('learning/resume.tsv')).filter(r => r.COURSE_ID && r.LESSON)
      .sort((a, b) => String(b.UPDATED_AT || '').localeCompare(String(a.UPDATED_AT || '')));
    const groupsRaw = await getRawGroups();
    const modulesMetaRaw = await readTSV('learning/modules_meta.tsv');

    const metaMap = {};
    for (const m of modulesMetaRaw) {
      if (m.COURSE_ID && m.LESSON_FILE) {
        metaMap[`${m.COURSE_ID}/${m.LESSON_FILE}`] = m;
      }
    }

    const groupsMap = {};
    for (const g of groupsRaw) {
      groupsMap[g.GROUP_ID] = {
        id: g.GROUP_ID,
        label: g.LABEL || g.GROUP_ID,
        description: g.DESCRIPTION || '',
        icon: g.ICON || '📚',
        color: g.COLOR || '#3b82f6',
        status: String(g.STATUS || 'active').toLowerCase(),
        sortOrder: Number(g.SORT_ORDER) || 99,
        updatedAt: g.UPDATED_AT || '',
        courseCount: 0,
        moduleCount: 0,
        doneCount: 0,
        progressPct: 0,
        courseIds: []
      };
    }

    const courses = await Promise.all(coursesRaw.map(async c => {
      const files = await listLessonFiles(c.ID);
      const lessons = files.map(({ file, raw, mtimeIso }) => {
        const first = raw.split(/\r?\n/, 1)[0];
        const p = progress.find(r => r.COURSE_ID === c.ID && r.LESSON === file);
        const parsed = parseLessonFilename(file, c.ID);
        const customMeta = metaMap[`${c.ID}/${file}`];
        const defRel = defaultRelevanceFor(c.ID, file);

        const relevance = customMeta?.RELEVANCE || defRel.relevance;
        const relevanceNote = customMeta?.RELEVANCE_NOTE || defRel.note;
        const moduleStatus = String(customMeta?.STATUS || 'active').toLowerCase();
        const version = customMeta?.VERSION || parsed.version || 'v0.0.0';
        const reviewedAt = customMeta?.REVIEWED_AT || parsed.reviewedAt || '2026-08-16';

        return {
          file,
          title: first.replace(/^#+\s*/, '').trim() || file,
          status: p ? p.STATUS : 'new',
          touchedAt: p && p.UPDATED_AT && p.UPDATED_AT !== '-' ? p.UPDATED_AT : null,
          revisedAt: mtimeIso,
          reviewedAt,
          version,
          relevance,
          relevanceNote,
          moduleStatus,
          words: (raw.match(/\S+/g) || []).length,
          vaultPath: `learning/${c.ID}/${file}`
        };
      });

      // Match group -- c.GROUP_ID (from courses.tsv) is the real source of
      // truth and matches every current course; the CLASSROOM text-match
      // below is a safety net only, for a course that somehow has no
      // GROUP_ID set yet.
      let groupId = c.GROUP_ID;
      if (!groupId || !groupsMap[groupId]) {
        const cl = String(c.CLASSROOM || '').toLowerCase();
        if (cl.includes('wealth') || cl.includes('finance') || cl.includes('money') || c.ID === 'applied-financial-intelligence') groupId = 'wealth-finance';
        else if (cl.includes('sales') || cl.includes('persuasion') || cl.includes('speak') || c.ID.startsWith('sales-') || c.ID.startsWith('speak-')) groupId = 'sales-persuasion';
        else if (cl.includes('medicine') || cl.includes('surgery') || c.ID.startsWith('med-')) groupId = 'medicine-surgery';
        else if (cl.includes('markets') || cl.includes('economics') || c.ID.includes('markets')) groupId = 'markets-economics';
        else groupId = 'corporate-mandate';
      }

      const courseStatus = String(c.STATUS || 'active').toLowerCase();
      const group = groupsMap[groupId] || groupsMap['corporate-mandate'];

      if (group) {
        group.courseCount++;
        group.moduleCount += lessons.length;
        group.doneCount += lessons.filter(l => l.status === 'done').length;
        group.courseIds.push(c.ID);
      }

      return {
        ...c,
        GROUP_ID: groupId,
        groupLabel: group ? group.label : c.CLASSROOM || 'General',
        groupIcon: group ? group.icon : '📚',
        groupColor: group ? group.color : '#3b82f6',
        STATUS: courseStatus,
        lessons
      };
    }));

    // Calculate group progress
    const groups = Object.values(groupsMap).map(g => {
      g.progressPct = g.moduleCount ? Math.round((g.doneCount / g.moduleCount) * 100) : 0;
      return g;
    }).sort((a, b) => a.sortOrder - b.sortOrder);

    return {
      groups,
      courses: includeArchived ? courses : courses.filter(c => c.STATUS !== 'archived' && c.STATUS !== 'disabled'),
      resume
    };
  }

  async function getLesson(course, file) {
    if (!/^[\w-]+$/.test(course) || !/^[\w.-]+\.md$/i.test(file) || file.includes('..')) throw new Error('bad lesson reference');
    const content = await readLessonFile(course, file);
    if (content == null) throw new Error('no such lesson');
    const { parseMarkdownBlockTree } = require('./learning-parser');
    const { blocks } = parseMarkdownBlockTree(content);
    return { content, blocks };
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

  // --- Group & Module Lifecycle Operations ---

  async function listGroups() {
    const { groups } = await listCourses();
    return { groups };
  }

  async function saveGroup(p) {
    const id = String(p.id || p.GROUP_ID || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-');
    if (!id) throw new Error('group id required');
    const label = String(p.label || p.LABEL || id).trim();
    const description = String(p.description || p.DESCRIPTION || '').trim();
    const icon = String(p.icon || p.ICON || '📚').trim();
    const color = String(p.color || p.COLOR || '#3b82f6').trim();
    const status = ['active', 'archived', 'disabled'].includes(String(p.status || p.STATUS || '').toLowerCase())
      ? String(p.status || p.STATUS).toLowerCase() : 'active';
    const sortOrder = String(Number(p.sortOrder || p.SORT_ORDER) || 99);
    const updatedAt = new Date().toISOString().slice(0, 10);

    let found = false;
    await rewriteTSV('learning/groups.tsv', rows => {
      const updated = rows.map(r => {
        if (r.GROUP_ID === id) {
          found = true;
          return { GROUP_ID: id, LABEL: label, DESCRIPTION: description, ICON: icon, COLOR: color, STATUS: status, SORT_ORDER: sortOrder, UPDATED_AT: updatedAt };
        }
        return r;
      });
      if (!found) {
        updated.push({ GROUP_ID: id, LABEL: label, DESCRIPTION: description, ICON: icon, COLOR: color, STATUS: status, SORT_ORDER: sortOrder, UPDATED_AT: updatedAt });
      }
      return updated;
    });

    auditLog.log('learning_group_saved', { groupId: id, label, status });
    return { success: true, group: { id, label, description, icon, color, status, sortOrder, updatedAt } };
  }

  async function archiveGroup(groupId, status = 'archived') {
    const st = ['active', 'archived', 'disabled'].includes(status) ? status : 'archived';
    await rewriteTSV('learning/groups.tsv', rows => rows.map(r => {
      if (r.GROUP_ID === groupId) return { ...r, STATUS: st, UPDATED_AT: new Date().toISOString().slice(0, 10) };
      return r;
    }));
    auditLog.log('learning_group_status_changed', { groupId, status: st });
    return { success: true, groupId, status: st };
  }

  async function setCourseStatus(p) {
    const courseId = String(p.courseId || p.ID || '').trim();
    if (!courseId) throw new Error('courseId required');
    const status = ['active', 'archived', 'disabled'].includes(String(p.status || p.STATUS || '').toLowerCase())
      ? String(p.status || p.STATUS).toLowerCase() : 'active';
    const groupId = p.groupId || p.GROUP_ID;
    const classroom = p.classroom || p.CLASSROOM;

    let found = false;
    await rewriteTSV('learning/courses.tsv', rows => rows.map(r => {
      if (r.ID === courseId) {
        found = true;
        const out = { ...r, STATUS: status, UPDATED_AT: new Date().toISOString().slice(0, 10) };
        if (groupId) out.GROUP_ID = groupId;
        if (classroom) out.CLASSROOM = classroom;
        return out;
      }
      return r;
    }));

    if (!found) throw new Error(`Course ${courseId} not found`);
    auditLog.log('learning_course_status_changed', { courseId, status, groupId });
    return { success: true, courseId, status, groupId };
  }

  async function setModuleMeta(p) {
    const courseId = String(p.courseId || '').trim();
    const lessonFile = String(p.lessonFile || p.file || '').trim();
    if (!courseId || !lessonFile) throw new Error('courseId and lessonFile required');

    const relevance = ['current', 'period-specific', 'outdated', 'evergreen', 'archived'].includes(String(p.relevance || '').toLowerCase())
      ? String(p.relevance).toLowerCase() : 'current';
    const relevanceNote = String(p.relevanceNote || '').trim();
    const status = ['active', 'archived', 'disabled'].includes(String(p.status || '').toLowerCase())
      ? String(p.status).toLowerCase() : 'active';
    const version = String(p.version || 'v0.0.0').trim();
    const reviewedAt = String(p.reviewedAt || new Date().toISOString().slice(0, 10)).trim();
    const updatedAt = new Date().toISOString().slice(0, 10);

    let found = false;
    await rewriteTSV('learning/modules_meta.tsv', rows => {
      const updated = rows.map(r => {
        if (r.COURSE_ID === courseId && r.LESSON_FILE === lessonFile) {
          found = true;
          return {
            COURSE_ID: courseId,
            LESSON_FILE: lessonFile,
            RELEVANCE: relevance,
            RELEVANCE_NOTE: relevanceNote,
            STATUS: status,
            VERSION: version,
            REVIEWED_AT: reviewedAt,
            UPDATED_AT: updatedAt
          };
        }
        return r;
      });
      if (!found) {
        updated.push({
          COURSE_ID: courseId,
          LESSON_FILE: lessonFile,
          RELEVANCE: relevance,
          RELEVANCE_NOTE: relevanceNote,
          STATUS: status,
          VERSION: version,
          REVIEWED_AT: reviewedAt,
          UPDATED_AT: updatedAt
        });
      }
      return updated;
    });

    auditLog.log('learning_module_meta_saved', { courseId, lessonFile, relevance, status, version, reviewedAt });
    return { success: true, courseId, lessonFile, relevance, relevanceNote, status, version, reviewedAt };
  }

  /**
   * "The campus": standing advice on what to read next.
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
      const k1 = `${r.COURSE_ID}/${r.LESSON}`;
      const status = String(r.STATUS || '').toLowerCase();
      doneOf[k1] = status;
      // Also index by short lesson name / index for flexible matching
      const shortLesson = String(r.LESSON || '').replace(/^2026\d{4}_campus_[a-z-]+_\d{2}_/, '').replace(/\.md$/, '');
      if (shortLesson) doneOf[`${r.COURSE_ID}/${shortLesson}`] = status;
    }

    const lessonOf = (courseId, file) => {
      const ls = byId[courseId]?.lessons || [];
      if (!file || file === '-') return null;
      // 1. Exact match
      const exact = ls.find(l => l.file === file);
      if (exact) return exact;
      // 2. Contains
      const contains = ls.find(l => l.file.includes(file));
      if (contains) return contains;
      // 3. Match numeric index (e.g. "16" in "16-the-directive.md" -> "_16_")
      const numMatch = file.match(/(\d+)/);
      if (numMatch) {
        const num = numMatch[1].padStart(2, '0');
        const numHit = ls.find(l => l.file.includes(`_${num}_`) || l.file.startsWith(`${num}-`) || l.file.includes(`_${num}.`));
        if (numHit) return numHit;
      }
      // 4. Match slug base
      const slug = file.replace(/^\d+[-_]?/, '').replace(/\.md$/, '').toLowerCase().replace(/[^a-z0-9]/g, '_');
      if (slug.length > 3) {
        const slugHit = ls.find(l => l.file.toLowerCase().includes(slug));
        if (slugHit) return slugHit;
      }
      return null;
    };

    const isDone = (courseId, file) => {
      if (!file) return false;
      if (doneOf[`${courseId}/${file}`] === 'done') return true;
      const l = lessonOf(courseId, file);
      if (l && doneOf[`${courseId}/${l.file}`] === 'done') return true;
      return false;
    };

    // A TRIGGER=always row is evergreen only if its own module says so
    // (modules_meta.tsv RELEVANCE=evergreen) -- otherwise "always" is treated
    // as `until:<UPDATED_AT + 14 days>`, so hand-authored advice that never
    // gets refreshed drops out of "Read now" instead of staying pinned there
    // indefinitely. 14 days is a starting point, not a hard rule -- it just
    // has to be longer than the "five days later, still stale" complaint
    // that prompted this. Once a row expires past this window, campus()'s
    // own self-updating fallback below takes over automatically -- there is
    // no separate storage for "recomputed advice", it's computed live on
    // every call, and that's also what keeps this self-checking without a
    // cron: today's date is compared against the row's own UPDATED_AT on
    // every read.
    const ALWAYS_TTL_DAYS = 14;
    const rowLive = (row) => {
      if (String(row.STATUS || 'active').toLowerCase() !== 'active') return false;
      const trig = String(row.TRIGGER || 'always').toLowerCase();
      if (trig === 'always') {
        const l = lessonOf(String(row.COURSE_ID), String(row.LESSON));
        if (l && String(l.relevance || '').toLowerCase() === 'evergreen') return true;
        const updated = String(row.UPDATED_AT || '');
        if (!/^\d{4}-\d{2}-\d{2}$/.test(updated)) return true; // no date to age against -- don't guess it stale
        const expiry = new Date(`${updated}T00:00:00`);
        expiry.setDate(expiry.getDate() + ALWAYS_TTL_DAYS);
        return today <= expiry.toISOString().slice(0, 10);
      }
      if (trig === 'unread') return !isDone(String(row.COURSE_ID), String(row.LESSON));
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
      const lessonRef = r.LESSON && r.LESSON !== '-' ? String(r.LESSON) : '';
      const l = lessonRef ? lessonOf(String(r.COURSE_ID), lessonRef) : null;
      const resolvedFile = l ? l.file : lessonRef;
      const readMinutes = Number(r.MINUTES) || (l?.words ? Math.max(1, Math.round(l.words / 200)) : 10);
      return {
        courseId: String(r.COURSE_ID),
        courseTitle: course ? String(course.TITLE || course.ID) : String(r.COURSE_ID),
        lesson: resolvedFile,
        title: r.HEADLINE && r.HEADLINE !== '-' ? String(r.HEADLINE) : (l ? String(l.title || resolvedFile) : String(course?.TITLE || r.COURSE_ID)),
        headline: l ? String(l.title || '') : '',
        why: r.WHY && r.WHY !== '-' ? String(r.WHY) : '',
        minutes: readMinutes,
        status: resolvedFile ? (doneOf[`${r.COURSE_ID}/${resolvedFile}`] || 'new') : 'new',
        missing: Boolean(lessonRef && !l),
      };
    };

    let bands = BANDS
      .map(b => ({ ...b, items: rows.filter(r => String(r.BAND || '').toLowerCase() === b.key).map(itemFrom) }))
      .filter(b => b.items.length);

    let computed = false;
    // Self-updating fallback intelligence: if static bands are empty or all read, synthesize live intelligent advice
    if (!bands.length || !bands.some(b => b.key === 'now' && b.items.length)) {
      computed = true;
      const nowItems = [];
      const weekItems = [];

      // 1. Resume item first
      for (const r of (resume || []).slice(0, 1)) {
        const course = byId[String(r.COURSE_ID)];
        if (!course) continue;
        const l = lessonOf(String(r.COURSE_ID), String(r.LESSON));
        if (l && !isDone(String(r.COURSE_ID), l.file)) {
          nowItems.push({
            courseId: String(r.COURSE_ID),
            courseTitle: String(course.TITLE || course.ID),
            lesson: l.file,
            title: String(l.title || l.file),
            headline: 'Active Reading Position',
            why: `Continue where you left off (${parseInt(r.SCROLL_PCT, 10) || 0}% read).`,
            minutes: l.words ? Math.max(1, Math.round(l.words / 200)) : 8,
            status: 'learning',
            missing: false,
          });
        }
      }

      // 2. High-priority live operational modules
      const priorityPointers = [
        { courseId: 'viva-meetings', file: '08', why: 'Sam alignment: team vetting on HR portal, Egypt/Turkey mapping, CDN latency.' },
        { courseId: 'viva-portals', file: '20', why: 'The full deal flow end-to-end: surfaces, roles, testing board, and live findings.' },
        { courseId: 'viva-model', file: '03', why: 'The 9 competitors analyzed: why trust verification is the product.' },
        { courseId: 'wellspring-pipeline', file: '02', why: 'Hero image composition rules: search the message, text on left, subject on right.' },
        { courseId: 'financial-intelligence', file: '01', why: 'Sovereign wealth compounding: master capital allocation across all ventures.' },
      ];

      for (const ptr of priorityPointers) {
        const c = byId[ptr.courseId];
        if (!c) continue;
        const l = lessonOf(ptr.courseId, ptr.file);
        if (l && !isDone(ptr.courseId, l.file) && !nowItems.some(i => i.courseId === ptr.courseId && i.lesson === l.file)) {
          const targetArray = nowItems.length < 3 ? nowItems : weekItems;
          targetArray.push({
            courseId: ptr.courseId,
            courseTitle: String(c.TITLE || c.ID),
            lesson: l.file,
            title: String(l.title || l.file),
            headline: '',
            why: ptr.why,
            minutes: l.words ? Math.max(1, Math.round(l.words / 200)) : 10,
            status: doneOf[`${ptr.courseId}/${l.file}`] || 'new',
            missing: false,
          });
        }
      }

      // 3. Fill in next unread modules from active courses
      for (const c of live) {
        if (String(c.STATUS || 'active').toLowerCase() !== 'active') continue;
        const next = (c.lessons || []).find(l => !isDone(c.ID, l.file)
          && !nowItems.some(i => i.courseId === String(c.ID) && i.lesson === l.file)
          && !weekItems.some(i => i.courseId === String(c.ID) && i.lesson === l.file));
        if (!next) continue;
        weekItems.push({
          courseId: String(c.ID),
          courseTitle: String(c.TITLE || c.ID),
          lesson: String(next.file),
          title: String(next.title || next.file),
          headline: '',
          why: 'Next sequential module in this track.',
          minutes: next.words ? Math.max(1, Math.round(next.words / 200)) : 8,
          status: 'new',
          missing: false,
        });
        if (weekItems.length >= 6) break;
      }

      bands = [];
      if (nowItems.length) bands.push({ key: 'now', label: 'Read now', tone: 'urgent', items: nowItems });
      if (weekItems.length) bands.push({ key: 'week', label: 'This week', tone: 'warm', items: weekItems });
    }

    return {
      bands,
      minutes: (bands.find(b => b.key === 'now')?.items || []).reduce((a, i) => a + (i.minutes || 0), 0),
      computed,
      updatedAt: updatedAt || new Date().toISOString().slice(0, 10),
      total: bands.reduce((a, b) => a + b.items.length, 0),
    };
  }

  /**
   * "Prime me" -- the most relevant lesson in the vault for a piece of task
   * text, so a task-detail screen can show the framework before the deadline.
   * Pure keyword overlap on lesson content vs. the supplied query text, no
   * model call -- same algorithm the legacy monolith used.
   */
  async function primeBrief({ q } = {}) {
    const terms = String(q || '').toLowerCase().split(/[\s,;.]+/).filter(s => s.length > 3);
    if (!terms.length) return { ok: false, error: 'No search terms supplied' };

    const coursesRaw = await readTSV('learning/courses.tsv');
    let best = null, bestScore = 0;

    for (const course of coursesRaw) {
      const files = await listLessonFiles(course.ID);
      for (const { file, raw } of files) {
        if (!raw) continue;
        const lc = raw.toLowerCase();
        const score = terms.reduce((n, t) => n + (lc.split(t).length - 1), 0);
        if (score > bestScore) { bestScore = score; best = { course, file, content: raw }; }
      }
    }

    return best && bestScore > 0
      ? { ok: true, course: best.course.TITLE || best.course.ID, file: best.file, content: best.content.slice(0, 12000) }
      : { ok: false, error: 'No relevant lesson found' };
  }

  /**
   * Learning-activity contribution map. Sourced from the audit log's
   * `lesson_progress` entries (one per open/progress event, real per-day
   * history) rather than `learning/progress.tsv`/`resume.tsv`, which each
   * upsert by course+lesson key and so only ever hold the latest status --
   * no history to draw a heatmap from.
   */
  async function contributions() {
    const countsByDate = {};
    const today = new Date();
    for (let i = 364; i >= 0; i--) countsByDate[new Date(today.getTime() - i * 86400000).toISOString().slice(0, 10)] = 0;

    let lines = [];
    try {
      const fs = require('fs');
      lines = fs.readFileSync(auditLog.auditFile, 'utf8').trimEnd().split('\n').filter(Boolean);
    } catch { /* no audit log yet */ }

    for (const line of lines) {
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      if (entry.action !== 'lesson_progress' || !entry.ts) continue;
      const dt = String(entry.ts).slice(0, 10);
      if (countsByDate[dt] !== undefined) countsByDate[dt]++;
    }

    return { days: Object.entries(countsByDate).map(([date, count]) => ({ date, count })) };
  }

  async function getManifest() {
    const { courses = [] } = await listCourses({ includeArchived: true });
    const lessons = [];
    for (const c of courses) {
      const courseId = c.ID || c.id || '';
      for (const l of c.lessons || []) {
        lessons.push({
          course: courseId,
          file: l.file,
          title: l.title,
          rev: l.version || l.reviewedAt || 'v0.0.0',
          version: l.version,
          reviewedAt: l.reviewedAt,
          words: l.words,
          status: l.status,
          relevance: l.relevance,
        });
      }
    }
    return { ok: true, count: lessons.length, lessons };
  }

  return {
    listCourses,
    getManifest,
    getLesson,
    getNote,
    saveNote,
    saveResume,
    saveProgress,
    contributions,
    primeBrief,
    campus,
    listGroups,
    saveGroup,
    archiveGroup,
    setCourseStatus,
    setModuleMeta
  };
}

module.exports = { createLearningClient };
