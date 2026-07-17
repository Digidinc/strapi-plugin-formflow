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

test('runtime toolbar preserves multi-paragraph quote boundaries when converting to paragraph', () => {
  const document: TelegramTemplateDocument = { version: 1, document: { type: 'document', children: [
    { type: 'blockquote', children: [
      { type: 'paragraph', children: [{ type: 'text', text: 'quote one' }] },
      { type: 'paragraph', children: [{ type: 'text', text: 'quote two' }] },
    ] },
  ] } };
  const editor = createEditor({ namespace: 'quote-to-paragraph-test', nodes: telegramEditorNodes, onError(error) { throw error; } });
  editor.update(() => {
    importTelegramAstIntoLexical(document);
    $getRoot().getFirstChildOrThrow().selectEnd();
    replaceSelectedTelegramBlock('paragraph');
  }, { discrete: true });
  let converted!: TelegramTemplateDocument;
  editor.getEditorState().read(() => {
    converted = exportLexicalToTelegramAst();
    assert.equal($getRoot().getTextContent(), 'quote one\nquote two');
  });
  assert.deepEqual(converted.document.children, [{ type: 'paragraph', children: [
    { type: 'text', text: 'quote one\nquote two' },
  ] }]);
  editor.update(() => importTelegramAstIntoLexical(converted), { discrete: true });
  editor.getEditorState().read(() => {
    assert.equal($getRoot().getTextContent(), 'quote one\nquote two');
    assert.deepEqual(exportLexicalToTelegramAst().document.children, [{ type: 'paragraph', children: [
      { type: 'text', text: 'quote one' }, { type: 'text', text: '\n' }, { type: 'text', text: 'quote two' },
    ] }]);
  });
});

test('runtime toolbar preserves list item boundaries when converting list to paragraph', () => {
  const document: TelegramTemplateDocument = { version: 1, document: { type: 'document', children: [
    { type: 'list', style: 'unordered', children: [
      { type: 'listItem', children: [{ type: 'paragraph', children: [{ type: 'text', text: 'first' }] }] },
      { type: 'listItem', children: [{ type: 'paragraph', children: [{ type: 'text', text: 'second' }] }] },
    ] },
  ] } };
  const editor = createEditor({ namespace: 'list-to-paragraph-test', nodes: telegramEditorNodes, onError(error) { throw error; } });
  editor.update(() => {
    importTelegramAstIntoLexical(document);
    $getRoot().getFirstChildOrThrow().selectEnd();
    replaceSelectedTelegramBlock('paragraph');
  }, { discrete: true });
  let converted!: TelegramTemplateDocument;
  editor.getEditorState().read(() => {
    converted = exportLexicalToTelegramAst();
    assert.equal($getRoot().getTextContent(), 'first\nsecond');
  });
  editor.update(() => importTelegramAstIntoLexical(converted), { discrete: true });
  editor.getEditorState().read(() => {
    assert.equal($getRoot().getTextContent(), 'first\nsecond');
    assert.deepEqual(exportLexicalToTelegramAst().document.children, [{ type: 'paragraph', children: [
      { type: 'text', text: 'first' }, { type: 'text', text: '\n' }, { type: 'text', text: 'second' },
    ] }]);
  });
});

test('runtime import and export preserve visible soft line breaks as Lexical linebreak nodes', () => {
  const document: TelegramTemplateDocument = { version: 1, document: { type: 'document', children: [
    { type: 'paragraph', children: [{ type: 'text', text: 'Line one\nLine two' }] },
  ] } };
  const editor = createEditor({ namespace: 'linebreak-roundtrip-test', nodes: telegramEditorNodes, onError(error) { throw error; } });
  editor.update(() => importTelegramAstIntoLexical(document), { discrete: true });
  let exported!: TelegramTemplateDocument;
  editor.getEditorState().read(() => {
    assert.deepEqual(($getRoot().getFirstChildOrThrow() as any).getChildren().map((node: any) => node.getType()), [
      'text', 'linebreak', 'text',
    ]);
    assert.equal($getRoot().getTextContent(), 'Line one\nLine two');
    exported = exportLexicalToTelegramAst();
  });
  assert.deepEqual(exported.document.children, [{ type: 'paragraph', children: [
    { type: 'text', text: 'Line one' },
    { type: 'text', text: '\n' },
    { type: 'text', text: 'Line two' },
  ] }]);
  editor.update(() => importTelegramAstIntoLexical(exported), { discrete: true });
  editor.getEditorState().read(() => {
    assert.deepEqual(($getRoot().getFirstChildOrThrow() as any).getChildren().map((node: any) => node.getType()), [
      'text', 'linebreak', 'text',
    ]);
    assert.equal($getRoot().getTextContent(), 'Line one\nLine two');
  });
});
