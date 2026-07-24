import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

import { matchPath } from 'react-router-dom';

type MenuLink = {
  block: string;
  label: string;
  to: string;
};

const indexSource = readFileSync('admin/src/index.ts', 'utf8');
const appSource = readFileSync('admin/src/pages/App.tsx', 'utf8');

const menuLinks = indexSource
  .split('app.addMenuLink({')
  .slice(1)
  .map((source) => source.split('\n    });', 1)[0])
  .map((block): MenuLink => {
    const label = block.match(/defaultMessage: '([^']+)'/)?.[1];
    const to = block.match(/to: `([^`]+)`/)?.[1].replace('${PLUGIN_ID}', 'formflow');

    assert.ok(label, 'Every FormFlow sidebar link must have a translated fallback label.');
    assert.ok(to, `The ${label} sidebar link must have a destination.`);

    return { block, label, to };
  });

const linkFor = (label: string) => {
  const link = menuLinks.find((candidate) => candidate.label === label);

  assert.ok(link, `Expected the ${label} sidebar link to be registered.`);
  return link;
};

const activeLabelsAt = (pathname: string) =>
  menuLinks
    .filter(({ to }) => matchPath({ path: `/${to}`, end: false }, pathname))
    .map(({ label }) => label);

test('settings and compliance use disjoint routes that activate only their own sidebar link', () => {
  const settings = linkFor('FormFlow Settings');
  const compliance = linkFor('Compliance');

  assert.deepEqual(activeLabelsAt(`/${settings.to}`), ['FormFlow Settings']);
  assert.deepEqual(activeLabelsAt(`/${compliance.to}`), ['Compliance']);
  assert.deepEqual(activeLabelsAt('/plugins/formflow/forms/example/edit'), ['FormFlow']);
});

test('dedicated settings and compliance route mounts preserve labels, permissions, and app wrappers', () => {
  const settings = linkFor('FormFlow Settings');
  const compliance = linkFor('Compliance');

  assert.match(settings.block, /permissions: PERMISSIONS\.settings\.read/);
  assert.match(settings.block, /Component:[\s\S]*SettingsApp/);
  assert.match(compliance.block, /permissions: PERMISSIONS\.main/);
  assert.match(compliance.block, /Component:[\s\S]*ComplianceApp/);

  assert.match(
    appSource,
    /const SettingsApp[\s\S]*<AppProviders>[\s\S]*permissions=\{PERMISSIONS\.settings\.read\}[\s\S]*<SettingsPage/
  );
  assert.match(
    appSource,
    /const ComplianceApp[\s\S]*<AppProviders>[\s\S]*permissions=\{PERMISSIONS\.main\}[\s\S]*<CompliancePage/
  );
});
