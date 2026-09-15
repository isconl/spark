'use strict';
/** FL26091204: default-schema.js's own comment warns that a path present in
 *  code but absent from the schema is silently dropped on every read/write --
 *  that's exactly what happened to learning/groups.tsv and
 *  learning/modules_meta.tsv, unnoticed until the Track/Relevance editors
 *  were found to persist nothing. This asserts every path learning.js
 *  actually touches is declared in vault's schema, so that bug class can't
 *  ship silently again.
 *
 *  Cross-repo by nature (schema lives in the vault repo) -- skips cleanly
 *  when vault isn't checked out as a sibling directory, which is the one
 *  layout this fleet actually runs (see CLAUDE.md's registry), rather than
 *  failing a CI run that only has spark. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

function loadVaultSchema() {
  const schemaPath = path.join(__dirname, '..', '..', 'vault', 'lib', 'default-schema.js');
  if (!fs.existsSync(schemaPath)) return null;
  delete require.cache[require.resolve(schemaPath)];
  return require(schemaPath);
}

function tsvPathsUsedBy(sourceFile) {
  const src = fs.readFileSync(sourceFile, 'utf8');
  const paths = new Set();
  const re = /\b(?:readTSV|appendTSV|rewriteTSV)\(\s*['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(src))) paths.add(m[1]);
  return paths;
}

test('every learning/* TSV path spark/lib/learning.js touches is declared in vault/lib/default-schema.js', () => {
  const schema = loadVaultSchema();
  if (!schema) { console.warn('[learning-schema-consistency] vault repo not checked out alongside spark -- skipping'); return; }

  const learningJs = path.join(__dirname, '..', 'lib', 'learning.js');
  const used = [...tsvPathsUsedBy(learningJs)].filter(p => p.startsWith('learning/'));
  assert.ok(used.length > 0, 'sanity check: expected to find at least one learning/*.tsv reference in learning.js');

  const missing = used.filter(p => !(p in schema));
  assert.deepEqual(missing, [], `these paths are read/written by learning.js but missing from default-schema.js: ${missing.join(', ')}`);
});
