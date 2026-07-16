import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const workflow = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');

assert.match(workflow, /id: changesets/, 'the Changesets action needs a stable step id');
assert.match(
  workflow,
  /VERSION_FILE: package\.json/,
  'the release PR title must read the plugin package version'
);
assert.match(
  workflow,
  /title="Version Packages \(v\$version\)"/,
  'the release PR title must include the computed package version'
);

console.log('All assertions passed: plugin release workflow contracts.');
