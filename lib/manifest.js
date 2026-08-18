'use strict';
/**
 * spark's capability manifest -- same lightweight MCP-tool-list stand-in as
 * vault's/pulse's/scope's/circle's manifests (Decision 003).
 */
module.exports = {
  engine: 'spark',
  version: require('../package.json').version,
  description: 'Ideas pipeline, chat/NLU + the natural-language action parser, learning, articles.',
  capabilities: [
    { name: 'ideas.list', method: 'GET', path: '/ideas', description: 'Ideas with stats/facets/tags.' },
    { name: 'ideas.add', method: 'POST', path: '/ideas', description: 'Capture an idea.' },
    { name: 'ideas.update', method: 'POST', path: '/ideas/update', description: 'Edit an idea.' },
    { name: 'ideas.delete', method: 'POST', path: '/ideas/delete', description: 'Delete an idea.' },

    { name: 'act', method: 'POST', path: '/act', description: 'Parse (and, with confirm:true, execute) a natural-language action against tasks/Jira/ideas/navigation. Gated actions require the two-phase confirm round trip.' },

    { name: 'learning.courses', method: 'GET', path: '/learning', description: 'Course catalogue with lessons, intelligent groups, review dates, versions, and relevance.' },
    { name: 'learning.groups.list', method: 'GET', path: '/learning/groups', description: 'Intelligent learning tracks and group list with aggregated progress.' },
    { name: 'learning.group.save', method: 'POST', path: '/learning/group', description: 'Create or update a learning group / classification.' },
    { name: 'learning.group.archive', method: 'POST', path: '/learning/group/archive', description: 'Archive or restore a learning group.' },
    { name: 'learning.course.status', method: 'POST', path: '/learning/course/status', description: 'Update course status (active/archived/disabled) or reassign group.' },
    { name: 'learning.module.meta', method: 'POST', path: '/learning/module/meta', description: 'Update module relevance, version, date reviewed, or status.' },
    { name: 'learning.lesson', method: 'GET', path: '/learning/lesson', description: 'One lesson\'s content.' },
    { name: 'learning.note.get', method: 'GET', path: '/learning/notes', description: 'Read a lesson\'s margin note.' },
    { name: 'learning.note.save', method: 'POST', path: '/learning/notes', description: 'Save a lesson\'s margin note.' },
    { name: 'learning.resume', method: 'POST', path: '/learning/resume', description: 'Save reading position.' },
    { name: 'learning.progress', method: 'POST', path: '/learning/progress', description: 'Mark a lesson\'s progress.' },
    { name: 'learning.contributions', method: 'GET', path: '/learning/contributions', description: 'Learning activity heatmap.' },
    { name: 'learning.campus', method: 'GET', path: '/learning/campus', description: 'Standing advice on what to read next -- priority bands (Read now/This week/Before the room/When it comes up/Background) from hand-authored learning/campus.tsv rows, falling back to a computed next-step (resume point, then next unfinished module per course) when nothing is curated.' },
    { name: 'learning.prime', method: 'GET', path: '/learning/prime', description: 'Most relevant lesson in the vault for a task, by keyword overlap (no model call) -- powers the task-detail "Prime me" card.' },

    { name: 'articles.list', method: 'GET', path: '/articles', description: 'Article list with word count/status.' },
  ],
  // NOT wired: the tutor, idea refine/review, article generation -- all
  // processAiChat-dependent. NOT wired either: /act's scope integration
  // (createTask/setTaskStatus/deleteTask/pushTaskToJira/jira*) -- real
  // cross-engine composition is `hub`'s job (task #7), not built yet;
  // /act works standalone today for navigate/idea.create and reports a
  // clean "scope is not wired" failure for anything touching tasks/Jira.
};
