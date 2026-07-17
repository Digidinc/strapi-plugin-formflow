import assert from 'node:assert/strict';
import test from 'node:test';
import { createEditor } from 'lexical';

import { exportLexicalToTelegramAst, importTelegramAstIntoLexical, telegramEditorNodes } from '../components/TelegramTemplateEditor';
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
