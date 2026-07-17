import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const workflow = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
const ciWorkflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
const packageJson = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8')
);

assert.match(workflow, /id: changesets/, 'the Changesets action needs a stable step id');
assert.match(
  workflow,
  /VERSION_FILE: package\.json/,
  'the release PR title must read the plugin package version'
);

for (const script of [
  'test:unit:telegram-server',
  'test:unit:telegram-admin',
  'test:unit:telegram-lexical',
  'test:unit:telegram',
]) {
  assert.equal(
    typeof packageJson.scripts?.[script],
    'string',
    `package.json must expose ${script}`
  );
}
assert.match(
  packageJson.scripts['test:unit:entitlement'],
  /npm run test:unit:telegram/,
  'the aggregate unit suite must execute Telegram regressions'
);
assert.match(
  ciWorkflow,
  /run: npm run test:unit:entitlement/,
  'CI must run the aggregate unit suite, including Telegram regressions'
);
assert.match(
  workflow,
  /title="Version Packages \(v\$version\)"/,
  'the release PR title must include the computed package version'
);

console.log('All assertions passed: plugin release workflow contracts.');
