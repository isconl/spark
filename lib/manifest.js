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
    { name: 'learning.manifest', method: 'GET', path: '/learning/manifest', description: 'Manifest of all learning modules with versions and revisions for offline prefetch.' },
    { name: 'learning.parseMd', method: 'POST', path: '/learning/parse-md', description: 'BL26082601 -- parse learning markdown into a canonical JSON block-tree (equations, charts, maps, callouts, tables, etc.).' },

    { name: 'articles.list', method: 'GET', path: '/articles', description: 'Article list with word count/status.' },

    { name: 'writer.research_field', method: 'POST', path: '/writer/research-field', description: 'BA26081812 -- AI-propose ONE Writer field\'s value from a brief + the other fields already filled in. Groq-backed. Never touches layout/formatting.' },
    { name: 'writer.full_draft', method: 'POST', path: '/writer/full-draft', description: 'BA26081812 -- AI-propose every field of a Writer archetype at once from a single brief. Groq-backed. Always lands in the same reviewable input form as manual entry.' },
    { name: 'dia.generate', method: 'POST', path: '/generate-dia', description: 'BM26082601 -- regenerate a person\'s dossier strengths/weaknesses/personality sections from their interaction history. Groq-backed. Called by circle over HTTP; returns JSON only, never touches a dossier file directly.' },
    { name: 'statusBrief.generate', method: 'POST', path: '/generate-status-brief', description: 'BA26082420 -- draft a subject\'s weekly status-brief (signal/substance/trajectory bullets) from its week of real activity data. Groq-backed. Called by scope over HTTP; never invents an activity not given.' },
    { name: 'ai.chat.complete', method: 'POST', path: '/ai/chat', description: 'FI26090501 -- one Groq-backed chat-completion call ({messages:[{role,content}]} -> {response}). Called by hub for the web Chat panel; caller owns conversation history/threading.' },
  ],
  // BA26081812 (20 Aug 2026) built spark's first real AI-calling layer
  // (lib/ai-provider.js, Groq-backed) and wired it for Writer's two AI
  // modes only. Still NOT wired on top of it: the tutor, idea refine/
  // review, article generation -- those need their own prompt/contract
  // work, this pass only did Writer's. NOT wired either: /act's scope integration
  // (createTask/setTaskStatus/deleteTask/pushTaskToJira/jira*) -- real
  // cross-engine composition is `hub`'s job (task #7), not built yet;
  // /act works standalone today for navigate/idea.create and reports a
  // clean "scope is not wired" failure for anything touching tasks/Jira.
};
