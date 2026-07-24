import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

const SECTION_HEADING_PATH = 'admin/src/components/shared/SectionHeading.tsx';

const readSource = (path: string): string => readFileSync(path, 'utf8');

const sectionHeadingCallContaining = (source: string, marker: string): string => {
  const markerIndex = source.indexOf(marker);
  assert.notEqual(markerIndex, -1, `Missing audited heading marker: ${marker}`);

  const callStart = source.lastIndexOf('<SectionHeading', markerIndex);
  const callEnd = source.indexOf('/>', markerIndex);

  assert.notEqual(callStart, -1, `${marker} must be rendered by SectionHeading`);
  assert.notEqual(callEnd, -1, `${marker} must be rendered by SectionHeading`);

  const interveningClose = source.lastIndexOf('/>', markerIndex);
  assert.ok(
    interveningClose < callStart,
    `${marker} must belong to the nearest SectionHeading call`
  );

  return source.slice(callStart, callEnd + 2);
};

test('SectionHeading follows the Strapi title and description layout convention', () => {
  assert.ok(existsSync(SECTION_HEADING_PATH), 'SectionHeading must be a shared component');
  if (!existsSync(SECTION_HEADING_PATH)) return;

  const source = readSource(SECTION_HEADING_PATH);

  assert.match(source, /<Flex[^>]*direction="column"[^>]*alignItems="stretch"[^>]*gap=\{1\}/);
  assert.match(source, /<Typography[^>]*variant="delta"[^>]*tag="h2"/);
  assert.match(source, /<Typography[^>]*variant="pi"[^>]*tag="p"[^>]*textColor="neutral600"/);
  assert.match(source, /titleAdornment/);
});

test('all audited section title and description pairs use SectionHeading', () => {
  const auditedPairs = [
    ['admin/src/components/FormBuilder/index.tsx', 'builder.subtitle'],
    ['admin/src/components/FormSettings/EmailSettings.tsx', 'notifications.email.subtitle'],
    ['admin/src/components/FormSettings/IntegrationsSettings.tsx', 'integrations.subtitle'],
    ['admin/src/components/FormSettings/WebhookSettings.tsx', 'notifications.webhook.subtitle'],
    ['admin/src/components/FormSettings/LocalesEditor.tsx', 'translations.subtitle'],
    [
      'admin/src/ee/components/TelegramNotificationSettings.tsx',
      'notifications.telegram.description',
    ],
    ['admin/src/ee/components/TelegramConnectionsSettings.tsx', 'settings.telegram.title'],
    [
      'admin/src/ee/components/FormBuilder/ConditionalLogicBuilder.tsx',
      'fieldEditor.conditional.description',
    ],
  ] as const;

  for (const [path, marker] of auditedPairs) {
    const source = readSource(path);
    const call = sectionHeadingCallContaining(source, marker);

    assert.match(call, /\btitle=\{/);
    assert.match(call, /\bdescription=\{/);
  }
});

test('the conditional-logic heading keeps its plan badge as a title adornment', () => {
  const source = readSource('admin/src/ee/components/FormBuilder/ConditionalLogicBuilder.tsx');
  const call = sectionHeadingCallContaining(source, 'fieldEditor.conditional.description');

  assert.match(call, /\btitleAdornment=\{/);
  assert.match(call, /<ProBadge\s+feature="conditionalLogic"/);
});

test('SectionHeading is exported from the shared component barrel', () => {
  assert.match(
    readSource('admin/src/components/shared/index.ts'),
    /export\s+\{\s*SectionHeading\s*\}\s+from\s+['"]\.\/SectionHeading['"]/
  );
});
