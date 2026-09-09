'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseMarkdownBlockTree, parseChartSpec, parseMapSpec } = require('../lib/learning-parser');

test('parseChartSpec parses bar chart with title and values', () => {
  const raw = `type: bar\ntitle: Debtor days\nYear 1: 73\nYear 2: 82`;
  const spec = parseChartSpec(raw);
  assert.equal(spec.type, 'bar');
  assert.equal(spec.title, 'Debtor days');
  assert.equal(spec.items.length, 2);
  assert.equal(spec.items[0].label, 'Year 1');
  assert.equal(spec.items[0].value, 73);
});

test('parseMapSpec parses coordinates and label', () => {
  const raw = `lat: 59.437\nlon: 24.7536\nzoom: 11\nlabel: Tallinn, Estonia`;
  const spec = parseMapSpec(raw);
  assert.equal(spec.lat, 59.437);
  assert.equal(spec.lon, 24.7536);
  assert.equal(spec.zoom, 11);
  assert.equal(spec.label, 'Tallinn, Estonia');
});

test('parseMarkdownBlockTree produces structured typed nodes', () => {
  const md = `# Title of Lesson

**You will be able to:** Understand cashflow velocity.

A standard paragraph describing the core idea.

$$
E = mc^2
$$

\`\`\`chart
type: bar
title: Revenue
2025: 100
2026: 250
\`\`\`

\`\`\`map
lat: -1.286389
lon: 36.817223
zoom: 12
label: Nairobi, Kenya
\`\`\`

| Metric | Target |
|---|---|
| Velocity | 5x |
| Retention | 90% |

**In a book:** Read The Sovereign Individual. [James Dale Davidson, 1997]

![Workflow Diagram](_assets/diagram.png)
`;

  const { blocks } = parseMarkdownBlockTree(md);
  assert.ok(Array.isArray(blocks));
  
  const types = blocks.map(b => b.type);
  assert.ok(types.includes('heading'));
  assert.ok(types.includes('callout'));
  assert.ok(types.includes('paragraph'));
  assert.ok(types.includes('equation'));
  assert.ok(types.includes('chart'));
  assert.ok(types.includes('map'));
  assert.ok(types.includes('table'));
  assert.ok(types.includes('image'));

  const callout = blocks.find(b => b.type === 'callout' && b.calloutType === 'book');
  assert.ok(callout);
  assert.equal(callout.citation, 'James Dale Davidson, 1997');
});

test('parseMarkdownBlockTree degrades book callout without citation to paragraph per standard §3', () => {
  const md = `**In a book:** This claim has no source citation attached.`;
  const { blocks } = parseMarkdownBlockTree(md);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, 'paragraph');
  assert.match(blocks[0].text, /In a book/);
});
