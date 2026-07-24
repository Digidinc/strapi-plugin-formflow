import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

import { buildTelegramTestPayload, createDefaultTelegramDocument, telegramNotificationState } from '../telegram/template-document';

const template = createDefaultTelegramDocument([]);
const settings = { enabled: true, connectionId: 'connection-1', destination: '@alerts', template };

test('test payload uses current unsaved configuration without wrapper or saved values', () => {
  assert.deepEqual(buildTelegramTestPayload(settings), { connectionId: 'connection-1', destination: '@alerts', template });
});

test('missing and inactive connections block sending while preserving configuration', () => {
  assert.equal(telegramNotificationState(settings, []).state, 'missing');
  assert.equal(telegramNotificationState(settings, [{ id: 'connection-1', active: false }]).state, 'inactive');
  assert.equal(telegramNotificationState(settings, [{ id: 'connection-1', active: true }]).state, 'connected');
  assert.deepEqual({ ...settings, enabled: false }, { enabled: false, connectionId: 'connection-1', destination: '@alerts', template });
});

test('form edit notifications tab round-trips one telegram object alongside existing settings', () => {
  const source = readFileSync('admin/src/pages/FormEditPage.tsx', 'utf8');
  assert.match(source, /TelegramNotificationSettings/);
  assert.match(source, /telegramNotification/);
  assert.match(source, /\.\.\.formData\.settings, telegramNotification/);
});

test('editor source uses the focused Lexical plugins and never persists private JSON or raw HTML', () => {
  const source = readFileSync('admin/src/ee/components/TelegramTemplateEditor.tsx', 'utf8');
  for (const plugin of ['LexicalComposer', 'RichTextPlugin', 'HistoryPlugin', 'ListPlugin', 'LinkPlugin']) assert.match(source, new RegExp(plugin));
  assert.doesNotMatch(source, /editorState\.toJSON\(\)/);
  assert.doesNotMatch(source, /dangerouslySetInnerHTML/);
  assert.match(source, /export const importTelegramAstIntoLexical/);
  assert.match(source, /export const exportLexicalToTelegramAst/);
  assert.match(source, /formflow-external-sync/);
  assert.match(source, /item\.children\.forEach/);
  assert.match(source, /node\.getChildren\(\)\.map/);
});

test('editor uses themed Strapi controls and preserves the Lexical selection from toolbar interactions', () => {
  const source = readFileSync('admin/src/ee/components/TelegramTemplateEditor.tsx', 'utf8');
  for (const component of ['IconButton', 'IconButtonGroup', 'SingleSelect', 'StyledContentEditable']) {
    assert.match(source, new RegExp(component));
  }
  assert.doesNotMatch(source, /<button\b/);
  assert.doesNotMatch(source, /<select\b/);
  assert.doesNotMatch(source, /theme:\s*\{\s*\}/);
  assert.match(source, /onPointerDown/);
  assert.match(source, /preventDefault\(\)/);
  assert.match(source, /theme\.colors\.neutral800/);
  assert.match(source, /data-field-id/);
  assert.match(source, /list-style-type:\s*disc/);
  assert.match(source, /list-style-type:\s*decimal/);
});

test('editor toolbar separates pointer selection preservation from keyboard-compatible activation', () => {
  const source = readFileSync('admin/src/ee/components/TelegramTemplateEditor.tsx', 'utf8');
  const iconButtons = source.match(/<IconButton\b[\s\S]*?<\/IconButton>/g) ?? [];

  assert.ok(iconButtons.length > 0);
  for (const button of iconButtons) {
    assert.match(button, /onPointerDown=\{preserveSelection\}/);
    assert.match(button, /onClick=\{runToolbarAction\(/);
    assert.doesNotMatch(button, /onPointerDown=\{preserveSelection\(\(\) =>/);
  }
  assert.match(source, /const preserveSelection = \(event: PointerEvent<HTMLButtonElement>\) => \{\s*event\.preventDefault\(\);\s*\};/);
});

test('block-style dropdown does not falsely report paragraph after applying another style', () => {
  const source = readFileSync('admin/src/ee/components/TelegramTemplateEditor.tsx', 'utf8');
  const blockStyleSelect = source.match(/<SingleSelect[\s\S]*?aria-label=\{t\('block', 'Block style'\)\}[\s\S]*?>/)?.[0];

  assert.ok(blockStyleSelect);
  assert.match(blockStyleSelect, /value=\{null\}/);
  assert.match(blockStyleSelect, /placeholder=\{t\('block', 'Block style'\)\}/);
  assert.doesNotMatch(blockStyleSelect, /value="paragraph"/);
});

test('template and theme-aware sandboxed preview use a responsive two-column grid before full-width alerts', () => {
  const source = readFileSync('admin/src/ee/components/TelegramNotificationSettings.tsx', 'utf8');
  assert.match(source, /useTheme\(\)/);
  assert.match(source, /<Grid\.Root[^>]*gap=\{4\}/);
  assert.equal((source.match(/<Grid\.Item[^>]*col=\{6\}[^>]*xs=\{12\}/g) ?? []).length, 2);
  assert.match(source, /sandbox=""/);
  assert.match(source, /buildTelegramPreviewDocument/);
  assert.ok(source.indexOf('</Grid.Root>') < source.indexOf('validation.errors.length'));
});
