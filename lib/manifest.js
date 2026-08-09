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

    { name: 'learning.courses', method: 'GET', path: '/learning', description: 'Course catalogue with lessons and resume points.' },
    { name: 'learning.lesson', method: 'GET', path: '/learning/lesson', description: 'One lesson\'s content.' },
    { name: 'learning.note.get', method: 'GET', path: '/learning/notes', description: 'Read a lesson\'s margin note.' },
    { name: 'learning.note.save', method: 'POST', path: '/learning/notes', description: 'Save a lesson\'s margin note.' },
    { name: 'learning.resume', method: 'POST', path: '/learning/resume', description: 'Save reading position.' },
    { name: 'learning.progress', method: 'POST', path: '/learning/progress', description: 'Mark a lesson\'s progress.' },
    { name: 'learning.contributions', method: 'GET', path: '/learning/contributions', description: 'Learning activity heatmap.' },

    { name: 'articles.list', method: 'GET', path: '/articles', description: 'Article list with word count/status.' },
  ],
  // NOT wired: the tutor, idea refine/review, article generation -- all
  // processAiChat-dependent. NOT wired either: /act's scope integration
  // (createTask/setTaskStatus/deleteTask/pushTaskToJira/jira*) -- real
  // cross-engine composition is `hub`'s job (task #7), not built yet;
  // /act works standalone today for navigate/idea.create and reports a
  // clean "scope is not wired" failure for anything touching tasks/Jira.
};
