import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createDefaultTelegramDocument,
  deserializeTelegramDocument,
  previewTelegramDocument,
  sampleForField,
  serializeTelegramDocument,
  shouldSyncTelegramEditorValue,
  validateTelegramDocument,
} from '../telegram/template-document';

const fields = [
  { id: 'email-id', type: 'email', name: 'email', label: 'Email' },
  { id: 'password-id', type: 'password', name: 'password', label: 'Password' },
];

test('default document references fields by stable ID with dash fallbacks', () => {
  const document = createDefaultTelegramDocument(fields, 'Contact us');
  assert.match(JSON.stringify(document), /New Contact us submission/);
  const json = JSON.stringify(document);
  assert.match(json, /"fieldId":"email-id","fallback":"-"/);
  assert.doesNotMatch(json, /"fieldId":"email"/);
});

test('validation reports stale and sensitive field references', () => {
  const document = createDefaultTelegramDocument(fields);
  document.document.children.push({ type: 'paragraph', children: [{ type: 'formField', fieldId: 'deleted', fallback: '-' }] });
  const result = validateTelegramDocument(document, fields);
  assert.equal(result.valid, false);
  assert.equal(result.errors.some((item) => item.code === 'stale_field'), true);
  assert.deepEqual(result.warnings.map((item) => item.fieldId), ['password-id']);
});

test('sample values use a dash when a field has no useful sample', () => {
  assert.equal(sampleForField({ id: 'x', type: 'text', name: 'x', label: 'X' }), '-');
  assert.equal(sampleForField(fields[0]), 'person@example.com');
});

test('parent echoes do not sync but a true external replacement does', () => {
  const local = '{"version":1,"local":true}';
  assert.equal(shouldSyncTelegramEditorValue(local, local), false);
  assert.equal(shouldSyncTelegramEditorValue(local, '{"version":1,"reset":true}'), true);
});

test('serialization restores the public FormFlow AST and rejects private editor state', () => {
  const document = createDefaultTelegramDocument(fields);
  assert.deepEqual(deserializeTelegramDocument(serializeTelegramDocument(document)), document);
  assert.throws(() => deserializeTelegramDocument('{"root":{"type":"root"}}'), /FormFlow/);
});

test('unsafe links are rejected', () => {
  const document = createDefaultTelegramDocument([]);
  document.document.children = [{ type: 'paragraph', children: [{ type: 'link', url: 'javascript:alert(1)', children: [{ type: 'text', text: 'bad' }] }] }];
  assert.equal(validateTelegramDocument(document, []).errors.some((item) => item.code === 'unsafe_link'), true);
});

test('preview escapes text and samples before applying Telegram-safe markup', () => {
  const document = { version: 1 as const, document: { type: 'document' as const, children: [{ type: 'paragraph' as const, children: [{ type: 'text' as const, text: '<script>', marks: ['bold' as const] }, { type: 'formField' as const, fieldId: 'email-id', fallback: '-' as const }] }] } };
  const html = previewTelegramDocument(document, fields, { 'email-id': '<me@example.com>' });
  assert.match(html, /<b>&lt;script&gt;<\/b>/);
  assert.match(html, /&lt;me@example\.com&gt;/);
  assert.doesNotMatch(html, /<script>/);
});

test('admin validation rejects malformed server-contract nodes', () => {
  const invalid = { version: 2, document: { type: 'document', children: [] }, privateState: true } as any;
  assert.equal(validateTelegramDocument(invalid, []).valid, false);
  const badMark = { version: 1, document: { type: 'document', children: [{ type: 'paragraph', children: [{ type: 'text', text: 'x', marks: ['rainbow'], private: true }] }] } } as any;
  const result = validateTelegramDocument(badMark, []);
  assert.equal(result.errors.some((item) => item.code === 'unsupported_mark'), true);
  assert.equal(result.errors.some((item) => item.code === 'unknown_property'), true);
});

test('validation is nonthrowing for arbitrary malformed input', () => {
  const cyclic: any = { version: 1, document: { type: 'document', children: [] } }; cyclic.self = cyclic;
  for (const value of [null, undefined, 1, 'x', [], {}, cyclic,
    { version: 1, document: { type: 'document', children: [{ type: 'heading', level: 9, children: [] }] } },
    { version: 1, document: { type: 'document', children: [{ type: 'list', style: 'bad', children: [{}] }] } },
    { version: 1, document: { type: 'document', children: [{ type: 'blockquote', children: [{ type: 'text', text: 'x' }] }] } },
  ]) assert.doesNotThrow(() => validateTelegramDocument(value as any, fields));
});
