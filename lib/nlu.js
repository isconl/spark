'use strict';
/**
 * The natural-language action parser: deterministic regex parsing (no
 * model), and its executor. Ported from isconl-agent's server.js
 * (tokenise/matchTask/resolveDue ~4889-4950, parseIntent ~4958-5117,
 * executePlan ~5123-5225).
 *
 * Two phases, same as the original: parseIntent() returns a `plan` that
 * states its own risk (`gated: true` for anything outward-facing or
 * destructive); the caller (the /act HTTP route) enforces that a gated
 * plan cannot execute without an explicit confirm:true round trip --
 * CLAUDE.md rule, not optional.
 *
 * CROSS-ENGINE: this resolves the canvas's third open judgment call ("the
 * NL-action parser reaches directly into Tasks and Jira -- either spark
 * gets an API client into scope, or the parser moves into scope"). Decided
 * here: the parser STAYS in spark (it's chat/NLU, not task management) and
 * calls scope through an injected client -- same pattern as every other
 * cross-engine seam in this split, not a special case. `scope` in opts is
 * spark's own narrow view of what it needs from scope (not scope's full
 * API), wired to a real HTTP/local client at the composition root.
 *
 * One faithful behavioral note: the NL `task.create` action does NOT sync
 * to Jira at creation (ORIGIN stays 'chat', ready for /api/jira/preview
 * later) -- this differs from scope's own POST /tasks, which syncs
 * immediately by default. That's the original's actual behavior, not a
 * simplification, so it's preserved rather than reusing scope's createTask
 * wholesale.
 */

const STOPWORDS = new Set(['the', 'a', 'an', 'to', 'for', 'of', 'on', 'in', 'my', 'and', 'is', 'it', 'that', 'this', 'with', 'please', 'can', 'you', 'i', 'me']);

function tokenise(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/).filter(w => w && !STOPWORDS.has(w));
}

function stripDashes(text) {
  if (typeof text !== 'string' || !text) return text;
  return text.replace(/(\d)\s*[··]\s*(\d)/g, '$1-$2').replace(/\s*[··]\s*/g, ' - ').replace(/[—–]/g, '-');
}

/** Find which task a phrase refers to. Returns a winner only when meaningfully better than the runner-up -- ambiguity is reported, never guessed through. */
function matchTask(phrase, tasks) {
  const want = tokenise(phrase);
  if (!want.length) return { match: null, reason: 'nothing to match on' };
  const scored = tasks.map(t => {
    const have = tokenise(t.TITLE);
    const hits = want.filter(w => have.some(h => h === w || h.startsWith(w) || w.startsWith(h)));
    let score = hits.length / want.length;
    if (t.ID.toLowerCase() === phrase.trim().toLowerCase()) score = 10;
    if (t.JIRA_KEY && t.JIRA_KEY.toLowerCase() === phrase.trim().toLowerCase()) score = 10;
    return { task: t, score };
  }).filter(x => x.score > 0).sort((a, b) => b.score - a.score);

  if (!scored.length) return { match: null, reason: 'no task resembles that' };
  const [best, second] = scored;
  if (best.score < 0.4) return { match: null, reason: 'nothing matched closely enough', near: scored.slice(0, 3) };
  if (second && second.score >= best.score * 0.85 && best.score < 10) return { match: null, reason: 'ambiguous', near: scored.slice(0, 3) };
  return { match: best.task, score: best.score };
}

const DUE_WORDS = [
  [/\btoday\b/i, 0], [/\btomorrow\b/i, 1], [/\bnext week\b/i, 7],
  [/\bin (\d+) days?\b/i, null], [/\bmonday\b/i, 'mon'], [/\btuesday\b/i, 'tue'],
  [/\bwednesday\b/i, 'wed'], [/\bthursday\b/i, 'thu'], [/\bfriday\b/i, 'fri'],
  [/\bsaturday\b/i, 'sat'], [/\bsunday\b/i, 'sun'],
];
const DAY_INDEX = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

function resolveDue(text) {
  const iso = text.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (iso) return iso[1];
  for (const [re, val] of DUE_WORDS) {
    const m = text.match(re);
    if (!m) continue;
    if (val === null) return new Date(Date.now() + Number(m[1]) * 864e5).toISOString().slice(0, 10);
    if (typeof val === 'number') return new Date(Date.now() + val * 864e5).toISOString().slice(0, 10);
    const target = DAY_INDEX[val];
    const d = new Date();
    let delta = (target - d.getDay() + 7) % 7;
    if (delta === 0) delta = 7;
    return new Date(Date.now() + delta * 864e5).toISOString().slice(0, 10);
  }
  return null;
}

const NAV_VIEWS = {
  command: 'today', dashboard: 'today', jira: 'jira', board: 'jira', kanban: 'jira',
  calendar: 'calendar', inbox: 'inbox', github: 'github', files: 'files',
  'file manager': 'files', tasks: 'tasks', 'scope tasks': 'tasks', spaces: 'spaces',
  decisions: 'decisions', 'decision log': 'decisions', risks: 'risks',
  'risk register': 'risks', audit: 'audit', settings: 'settings', social: 'social',
  ideas: 'ideas', 'idea pipeline': 'ideas', spark: 'ideas', journal: 'journal',
  learning: 'learning', courses: 'learning', circle: 'circle', finance: 'finance',
  money: 'finance', projects: 'projects', planning: 'planning', plans: 'planning',
  notifications: 'notifications', alerts: 'notifications',
};

/** Turn a sentence into a declared action, or null. Every plan states its own risk. */
function parseIntent(text, tasks) {
  const raw = String(text || '').trim();
  const q = raw.toLowerCase();
  const jiraKey = (raw.match(/\b([A-Z][A-Z0-9]+-\d+)\b/) || [])[1] || null;
  const plan = (o) => ({ ...o, utterance: raw });

  let m = raw.match(/\bassign\s+(?:([A-Z][A-Z0-9]+-\d+)|(.+?))\s+to\s+(.+)$/i);
  if (m) {
    const who = m[3].trim().replace(/[.!?]+$/, '');
    if (/\b(no one|nobody|unassigned|none)\b/i.test(who)) {
      return plan({ action: 'jira.unassign', jiraKey: m[1] || jiraKey, gated: true, describe: `Clear the assignee on ${m[1] || jiraKey}` });
    }
    return plan({ action: 'jira.assign', jiraKey: m[1] || jiraKey, who, gated: true, describe: `Assign ${m[1] || jiraKey || 'an issue'} to ${who}` });
  }

  m = raw.match(/\b(?:move|transition|put|set)\s+([A-Z][A-Z0-9]+-\d+)\s+(?:to|into)\s+(.+)$/i);
  if (m) return plan({ action: 'jira.transition', jiraKey: m[1], to: m[2].trim().replace(/[.!?]+$/, ''), gated: true, describe: `Move ${m[1]} to ${m[2].trim()}` });

  m = raw.match(/^(?:log|capture|save|record|note|add)\s+(?:this\s+|that\s+|the\s+|an?\s+)?(?:as\s+an?\s+)?(?:idea|improvement|feature request|note)\s*(?:that|about|for)?\s*[:,-]?\s*(.+)$/i)
   || raw.match(/^idea\s*[:-]\s*(.+)$/i);
  if (m) {
    let body = m[1].trim().replace(/[.!?]+$/, '');
    if (body) {
      const isAgent = /\b(agent|isconl|dashboard|interface|\bui\b|this app|the chat|the console)\b/i.test(raw);
      let domain = '';
      const scoped = body.match(/^(?:the\s+)?([a-z][a-z\s]{1,22}?)\s*:\s*(.+)$/i);
      if (scoped && scoped[2].trim().length > 8) { domain = scoped[1].trim().toLowerCase(); body = scoped[2].trim(); }
      const title = body.length > 90 ? body.slice(0, 87).replace(/\s+\S*$/, '') + '...' : body;
      return plan({ action: 'idea.create', title, body: body.length > 90 ? body : '', domain,
        type: isAgent ? 'agent' : 'general', gated: false, describe: `Capture "${title}" as an idea` });
    }
  }

  m = raw.match(/^(?:add|create|new)\s+(?:a\s+)?task\s*:?\s*(.+)$/i) || raw.match(/^(?:remind me to|i need to|todo)\s*:?\s*(.+)$/i);
  if (m) {
    let title = m[1].trim().replace(/[.!?]+$/, '');
    const due = resolveDue(title);
    const prio = /\b(urgent|asap|high priority|critical)\b/i.test(title) ? 'high' : /\b(low priority|whenever|someday)\b/i.test(title) ? 'low' : 'medium';
    title = title.replace(/\b(today|tomorrow|next week|in \d+ days?|by \d{4}-\d{2}-\d{2}|on \d{4}-\d{2}-\d{2})\b/gi, '')
                 .replace(/\b(urgent|asap|high priority|critical|low priority|whenever|someday)\b/gi, '')
                 .replace(/\s{2,}/g, ' ').replace(/\s+,/g, ',').trim().replace(/[,\s]+$/, '');
    if (!title) return null;
    return plan({ action: 'task.create', title, due, priority: prio, gated: false, describe: `Add "${title}"${due ? `, due ${due}` : ''}, ${prio} priority` });
  }

  m = raw.match(/^(?:mark|set)\s+(.+?)\s+(?:as\s+)?(done|complete|completed|finished|in review|review)\b/i)
   || raw.match(/^(?:complete|finish)\s+(.+)$/i)
   || raw.match(/^(.+?)\s+is\s+(done|complete|finished)$/i);
  if (m) {
    const target = m[1].trim();
    const wantReview = /review/i.test(m[2] || '');
    const r = matchTask(target, tasks);
    if (!r.match) return plan({ action: 'clarify', reason: r.reason, near: r.near, target, describe: `Which task did you mean by "${target}"?` });
    return plan({ action: 'task.complete', taskId: r.match.ID, target: r.match.TITLE,
      to: wantReview ? 'review' : 'done', gated: !wantReview, describe: `Mark "${r.match.TITLE}" as ${wantReview ? 'In Review' : 'Done'}` });
  }

  m = raw.match(/\bmake\s+(.+?)\s+(high|medium|low)(?:\s+priority)?$/i)
   || raw.match(/\bset\s+(.+?)\s+(?:priority\s+)?(?:to\s+)?(high|medium|low)(?:\s+priority)?$/i)
   || raw.match(/\b(.+?)\s+is\s+(high|medium|low)\s+priority$/i);
  if (m) {
    const r = matchTask(m[1].trim(), tasks);
    if (!r.match) return plan({ action: 'clarify', reason: r.reason, near: r.near, target: m[1].trim(), describe: `Which task did you mean by "${m[1].trim()}"?` });
    return plan({ action: 'task.priority', taskId: r.match.ID, priority: m[2].toLowerCase(), target: r.match.TITLE, gated: false,
      describe: `Set "${r.match.TITLE}" to ${m[2].toLowerCase()} priority` });
  }

  m = raw.match(/\b(?:move|push|reschedule|set)\s+(.+?)\s+(?:due\s+)?(?:to|until|for)\s+(.+)$/i) || raw.match(/\b(.+?)\s+(?:is\s+)?due\s+(.+)$/i);
  if (m && !/^[A-Z][A-Z0-9]+-\d+$/i.test(m[1].trim())) {
    const due = resolveDue(m[2]);
    if (due) {
      const r = matchTask(m[1].trim(), tasks);
      if (!r.match) return plan({ action: 'clarify', reason: r.reason, near: r.near, target: m[1].trim(), describe: `Which task did you mean by "${m[1].trim()}"?` });
      return plan({ action: 'task.due', taskId: r.match.ID, due, target: r.match.TITLE, gated: false, describe: `Move "${r.match.TITLE}" to ${due}` });
    }
  }

  m = raw.match(/^(?:delete|remove|drop)\s+(?:the\s+)?(?:task\s+)?(.+)$/i);
  if (m) {
    const r = matchTask(m[1].trim(), tasks);
    if (!r.match) return plan({ action: 'clarify', reason: r.reason, near: r.near, target: m[1].trim(), describe: `Which task did you mean by "${m[1].trim()}"?` });
    const jk = r.match.JIRA_KEY && r.match.JIRA_KEY !== '-' ? r.match.JIRA_KEY : null;
    return plan({ action: 'task.delete', taskId: r.match.ID, target: r.match.TITLE, jiraKey: jk, gated: true,
      describe: `Delete "${r.match.TITLE}"${jk ? ` and its Jira issue ${jk}` : ''}` });
  }

  m = raw.match(/\b(?:post|push|send|create)\s+(.+?)\s+(?:to|in|on)\s+jira$/i);
  if (m) {
    const r = matchTask(m[1].trim(), tasks);
    if (!r.match) return plan({ action: 'clarify', reason: r.reason, near: r.near, target: m[1].trim(), describe: `Which task did you mean by "${m[1].trim()}"?` });
    return plan({ action: 'task.toJira', taskId: r.match.ID, target: r.match.TITLE, gated: true, describe: `Create a Jira issue for "${r.match.TITLE}"` });
  }

  m = q.match(/^(?:open|show|go to|take me to)\s+(?:the\s+)?(.+?)[.!?]?$/i);
  if (m) {
    const view = NAV_VIEWS[m[1].trim()];
    if (view) return plan({ action: 'navigate', view, gated: false, describe: `Open ${m[1].trim()}` });
  }

  return null;
}

/**
 * Carry out a parsed plan. Assumes the GATE has already been satisfied for
 * anything marked gated -- the /act route enforces that, not this function.
 *
 * @param {object} scope injected -- spark's narrow view of what it needs
 *   from `scope`: createTask, setTaskStatus, setTaskPriority, setTaskDue,
 *   deleteTask, pushTaskToJira, jiraAssignableUsers, jiraAssignIssue,
 *   jiraTransitionIssue. All async, all optional (default to a "not wired"
 *   failure rather than throwing) so this module works standalone.
 */
function createNluClient(opts) {
  const {
    readTSV,
    ideas,   // required -- the object createIdeasClient() returns
    scope = {},
    auditLog = { log: () => {} },
    tasksFile = 'scope/tasks.tsv',
  } = opts;
  if (!readTSV) throw new Error('createNluClient requires readTSV');
  if (!ideas) throw new Error('createNluClient requires ideas (a createIdeasClient() instance)');

  const notWired = async () => ({ ok: false, error: 'scope is not wired to this spark instance' });
  const s = {
    createTask: scope.createTask || notWired,
    setTaskStatus: scope.setTaskStatus || notWired,
    setTaskPriority: scope.setTaskPriority || notWired,
    setTaskDue: scope.setTaskDue || notWired,
    deleteTask: scope.deleteTask || notWired,
    pushTaskToJira: scope.pushTaskToJira || notWired,
    jiraAssignableUsers: scope.jiraAssignableUsers || (async () => []),
    jiraAssignIssue: scope.jiraAssignIssue || notWired,
    jiraTransitionIssue: scope.jiraTransitionIssue || notWired,
  };

  async function parse(text) {
    return parseIntent(text, await readTSV(tasksFile));
  }

  async function execute(p) {
    switch (p.action) {
      case 'task.create': {
        const r = await s.createTask({ title: stripDashes(p.title), due: p.due || '-', priority: p.priority, origin: 'chat' });
        if (r?.ok === false) return r;
        auditLog.log('nl_task_created', { title: p.title });
        return { ok: true, message: `Added "${p.title}"${p.due ? `, due ${p.due}` : ''}.`, refresh: ['tasks'] };
      }
      case 'idea.create': {
        const row = await ideas.captureIdea({ title: stripDashes(p.title), body: p.body ? stripDashes(p.body) : '', type: p.type, domain: p.domain, source: 'chat' });
        return { ok: true, message: `Captured as ${row.ID}: "${row.TITLE}". It is in the vault and on OneDrive within the minute.`, refresh: ['ideas'] };
      }
      case 'task.complete': {
        const r = await s.setTaskStatus(p.taskId, p.to);
        auditLog.log('nl_task_completed', { taskId: p.taskId, to: p.to });
        if (r?.ok === false) return r;
        return { ok: true, refresh: ['tasks', 'jira'],
          message: `"${p.target}" is ${p.to === 'review' ? 'in review' : 'done'}` + (r?.jira?.success ? `, and it moved with it.` : '.') };
      }
      case 'task.priority': {
        const r = await s.setTaskPriority(p.taskId, p.priority);
        if (r?.ok === false) return r;
        auditLog.log('nl_task_priority', { taskId: p.taskId, priority: p.priority });
        return { ok: true, message: `"${p.target}" is now ${p.priority} priority.`, refresh: ['tasks'] };
      }
      case 'task.due': {
        const r = await s.setTaskDue(p.taskId, p.due);
        if (r?.ok === false) return r;
        auditLog.log('nl_task_due', { taskId: p.taskId, due: p.due });
        return { ok: true, message: `"${p.target}" now due ${p.due}.`, refresh: ['tasks'] };
      }
      case 'task.delete': {
        const r = await s.deleteTask(p.taskId, { jiraKey: p.jiraKey });
        if (r?.ok === false) return { ok: false, message: `Kept the task: ${r.error || 'delete failed'}.` };
        auditLog.log('nl_task_deleted', { taskId: p.taskId, jiraKey: p.jiraKey });
        return { ok: true, message: `Deleted "${p.target}".`, refresh: ['tasks', 'jira'] };
      }
      case 'task.toJira': {
        const r = await s.pushTaskToJira(p.taskId);
        if (r?.ok === false || !r?.key) return { ok: false, message: `Jira would not take it: ${r?.error || 'unknown'}.` };
        auditLog.log('nl_task_to_jira', { taskId: p.taskId, jiraKey: r.key });
        return { ok: true, message: `Filed as ${r.key}.`, refresh: ['tasks', 'jira'] };
      }
      case 'jira.assign': {
        const people = await s.jiraAssignableUsers();
        const want = tokenise(p.who);
        const scored = people.map(u => ({ u, score: want.filter(w => tokenise(u.displayName).some(h => h.startsWith(w))).length / Math.max(1, want.length) }))
          .sort((a, b) => b.score - a.score);
        if (!scored.length || scored[0].score < 0.5) return { ok: false, message: `No one on this project matches "${p.who}". Assignable: ${people.map(u => u.displayName).join(', ') || 'nobody'}.` };
        if (scored[1] && scored[1].score === scored[0].score) return { ok: false, message: `"${p.who}" could be ${scored[0].u.displayName} or ${scored[1].u.displayName}. Be more specific.` };
        const r = await s.jiraAssignIssue(p.jiraKey, scored[0].u.accountId);
        if (!r.success) return { ok: false, message: `Jira refused: ${r.error}` };
        return { ok: true, message: `${p.jiraKey} is ${scored[0].u.displayName}'s now.`, refresh: ['jira'] };
      }
      case 'jira.unassign': {
        const r = await s.jiraAssignIssue(p.jiraKey, null);
        return r.success ? { ok: true, message: `${p.jiraKey} is unassigned.`, refresh: ['jira'] } : { ok: false, message: `Jira refused: ${r.error}` };
      }
      case 'jira.transition': {
        const r = await s.jiraTransitionIssue(p.jiraKey, p.to);
        return r.success ? { ok: true, message: `${p.jiraKey} moved to ${r.newStatus || p.to}.`, refresh: ['jira'] } : { ok: false, message: r.error || `Could not move ${p.jiraKey}.` };
      }
      case 'navigate':
        return { ok: true, message: `Opening ${p.view}.`, navigate: p.view };
      default:
        return { ok: false, message: `I parsed that as "${p.action}" and then did not know what to do with it.` };
    }
  }

  /** The two-phase gate: without confirm, return the plan; with confirm:true (or an ungated plan), execute it. */
  async function act({ text, confirm = false, plan: given = null }) {
    const plan = given || await parse(text);
    if (!plan) return { understood: false };
    if (plan.action === 'clarify') {
      auditLog.log('nl_action_ambiguous', { utterance: plan.utterance, reason: plan.reason });
      return { understood: true, needsClarification: true, reason: plan.reason, describe: plan.describe,
        options: (plan.near || []).map(n => ({ id: n.task.ID, title: n.task.TITLE })) };
    }
    if (plan.gated && !confirm) {
      auditLog.log('nl_action_gated', { action: plan.action, utterance: plan.utterance });
      return { understood: true, needsConfirmation: true, plan, describe: plan.describe };
    }
    const result = await execute(plan);
    auditLog.log('nl_action_executed', { action: plan.action, ok: result.ok });
    return { understood: true, executed: true, ...result, plan };
  }

  return { parse, execute, act };
}

module.exports = { createNluClient, parseIntent, matchTask, resolveDue, tokenise, stripDashes, NAV_VIEWS };
