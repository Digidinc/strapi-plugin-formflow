import assert from 'node:assert/strict';
import test from 'node:test';
import { $getRoot, createEditor } from 'lexical';

import { exportLexicalToTelegramAst, importTelegramAstIntoLexical, replaceSelectedTelegramBlock, telegramEditorNodes } from '../components/TelegramTemplateEditor';
import type { TelegramTemplateDocument } from '../telegram/template-document';

test('runtime Lexical conversion preserves multiple paragraphs in quotes and list items', () => {
  const document: TelegramTemplateDocument = { version: 1, document: { type: 'document', children: [
    { type: 'blockquote', children: [
      { type: 'paragraph', children: [{ type: 'text', text: 'quote one' }] },
      { type: 'paragraph', children: [{ type: 'text', text: 'quote two' }] },
    ] },
    { type: 'list', style: 'unordered', children: [{ type: 'listItem', children: [
      { type: 'paragraph', children: [{ type: 'text', text: 'item one' }] },
      { type: 'paragraph', children: [{ type: 'text', text: 'item two' }] },
    ] }] },
  ] } };
  const editor = createEditor({ namespace: 'test', nodes: telegramEditorNodes, onError(error) { throw error; } });
  editor.update(() => importTelegramAstIntoLexical(document), { discrete: true });
  let restored: TelegramTemplateDocument | undefined;
  editor.getEditorState().read(() => { restored = exportLexicalToTelegramAst(); });
  assert.deepEqual(restored, document);
});

test('runtime toolbar converts paragraph to quote and back without nesting block nodes', () => {
  const document: TelegramTemplateDocument = { version: 1, document: { type: 'document', children: [
    { type: 'paragraph', children: [{ type: 'text', text: 'keep me', marks: ['bold'] }] },
  ] } };
  const editor = createEditor({ namespace: 'toolbar-test', nodes: telegramEditorNodes, onError(error) { throw error; } });
  editor.update(() => {
    importTelegramAstIntoLexical(document);
    $getRoot().getFirstChildOrThrow().selectEnd();
    replaceSelectedTelegramBlock('quote');
  }, { discrete: true });
  editor.getEditorState().read(() => {
    assert.deepEqual(exportLexicalToTelegramAst().document.children, [{ type: 'blockquote', children: [
      { type: 'paragraph', children: [{ type: 'text', text: 'keep me', marks: ['bold'] }] },
    ] }]);
  });
  editor.update(() => {
    $getRoot().getFirstChildOrThrow().selectEnd();
    replaceSelectedTelegramBlock('paragraph');
  }, { discrete: true });
  editor.getEditorState().read(() => assert.deepEqual(exportLexicalToTelegramAst(), document));
});
