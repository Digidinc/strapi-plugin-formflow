/* SPDX-License-Identifier: LicenseRef-FormFlow-EE — Commercial. See LICENSE-EE. Not covered by MIT. */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createDefaultTelegramTemplate,
  renderTelegramTemplate,
  validateTemplate,
} from '../template';
import type { TelegramTemplateDocument } from '../types';

const fields = [
  { id: 'email', type: 'email', name: 'email', label: 'Email' },
  { id: 'secret', type: 'password', name: 'secret', label: 'Secret' },
  { id: 'hidden', type: 'hidden', name: 'hidden', label: 'Hidden' },
  { id: 'files', type: 'file', name: 'files', label: 'Files' },
];

const document = (children: unknown[]): TelegramTemplateDocument =>
  ({ version: 1, document: { type: 'document', children } }) as TelegramTemplateDocument;

test('compiles every approved block and inline mark to Telegram HTML', () => {
  const result = renderTelegramTemplate(
    document([
      {
        type: 'heading', level: 2, children: [
          { type: 'text', text: 'Alert', marks: ['bold', 'italic', 'underline', 'strikethrough', 'code'] },
        ],
      },
      { type: 'paragraph', children: [{ type: 'link', url: 'https://example.com/?a=1&b=2', children: [{ type: 'text', text: 'Open' }] }] },
      { type: 'blockquote', children: [{ type: 'paragraph', children: [{ type: 'text', text: 'Quoted' }] }] },
    ]),
    fields,
    {}
  );
  assert.equal(result.errors.length, 0);
  assert.equal(result.html,
    '<h2><code><s><u><i><b>Alert</b></i></u></s></code></h2>\n' +
    '<p><a href="https://example.com/?a=1&amp;b=2">Open</a></p>\n' +
    '<blockquote><p>Quoted</p></blockquote>'
  );
});

test('compiles code blocks, ordered and unordered lists, and dividers', () => {
  const result = renderTelegramTemplate(document([
    { type: 'codeBlock', code: '<deploy>&\nnext', language: 'sh' },
    { type: 'list', style: 'unordered', children: [
      { type: 'listItem', children: [{ type: 'paragraph', children: [{ type: 'text', text: 'First' }] }] },
      { type: 'listItem', children: [{ type: 'paragraph', children: [{ type: 'formField', fieldId: 'email', fallback: '-' }] }] },
    ] },
    { type: 'divider' },
    { type: 'list', style: 'ordered', children: [
      { type: 'listItem', children: [{ type: 'paragraph', children: [{ type: 'text', text: 'One' }] }] },
      { type: 'listItem', children: [{ type: 'paragraph', children: [{ type: 'text', text: 'Two' }] }] },
    ] },
  ]), fields, { email: '<person@example.com>' });
  assert.equal(result.errors.length, 0);
  assert.equal(result.html,
    '<pre><code class="language-sh">&lt;deploy&gt;&amp;\nnext</code></pre>\n' +
    '<ul><li><p>First</p></li><li><p>&lt;person@example.com&gt;</p></li></ul>\n' +
    '<hr/>\n' +
    '<ol><li><p>One</p></li><li><p>Two</p></li></ol>'
  );
});

test('escapes hostile submitted values and uses fallback for empty values', () => {
  const template = document([{ type: 'paragraph', children: [
    { type: 'formField', fieldId: 'email', fallback: '-' }, { type: 'text', text: ' / ' },
    { type: 'formField', fieldId: 'secret', fallback: '-' },
  ] }]);
  const result = renderTelegramTemplate(template, fields, {
    email: '<a href="tg://user?id=1">& attack</a>', secret: '',
  });
  assert.equal(result.html, '<p>&lt;a href=&quot;tg://user?id=1&quot;&gt;&amp; attack&lt;/a&gt; / -</p>');
  assert.deepEqual(result.warnings.map((warning) => warning.code), ['sensitive_field']);
});

test('warns for the same password and hidden sensitive fields as the admin validator', () => {
  const template = document([{ type: 'paragraph', children: [
    { type: 'formField', fieldId: 'secret', fallback: '-' },
    { type: 'formField', fieldId: 'hidden', fallback: '-' },
  ] }]);
  const result = validateTemplate(template, fields);
  assert.deepEqual(result.warnings.map((warning) => warning.fieldId), ['secret', 'hidden']);
});

test('formats arrays, booleans, files and objects within explicit bounds', () => {
  const variables = ['email', 'secret', 'files'].map((fieldId) => ({ type: 'formField', fieldId, fallback: '-' }));
  const result = renderTelegramTemplate(document([{ type: 'paragraph', children: variables }]), fields, {
    email: ['one', '<two>', 'three', 'four', 'five', 'six', 'seven'],
    secret: true,
    files: [{ name: '<invoice>.pdf', url: 'https://example.com/private' }, { name: 'second.txt', size: 12 }, { name: 'third' }, { name: 'fourth' }, { name: 'fifth' }, { name: 'sixth' }],
  });
  assert.match(result.html, /one, &lt;two&gt;.*\+2 more/);
  assert.match(result.html, /Yes/);
  assert.match(result.html, /&lt;invoice&gt;\.pdf.*\+1 more/);
  assert.ok(result.html.length < 2_000);
});

test('rejects invalid versions, stale variables, unsafe links, unknown nodes and empty documents', () => {
  const cases: Array<[string, unknown, string]> = [
    ['version', { version: 2, document: { type: 'document', children: [] } }, 'invalid_version'],
    ['stale', document([{ type: 'paragraph', children: [{ type: 'formField', fieldId: 'gone', fallback: '-' }] }]), 'stale_field'],
    ['unsafe link', document([{ type: 'paragraph', children: [{ type: 'link', url: 'javascript:alert(1)', children: [{ type: 'text', text: 'x' }] }] }]), 'unsafe_link'],
    ['unknown node', document([{ type: 'media', url: 'https://example.com/x' }]), 'unsupported_node'],
    ['empty', document([]), 'empty_document'],
  ];
  for (const [name, value, code] of cases) {
    const result = validateTemplate(value as TelegramTemplateDocument, fields);
    assert.ok(result.errors.some((error) => error.code === code), `${name}: ${JSON.stringify(result.errors)}`);
    assert.equal(result.valid, false);
  }
});

test('rejects excessive nesting, node counts and security-relevant unknown properties', () => {
  const tooMany = Array.from({ length: 201 }, () => ({ type: 'paragraph', children: [{ type: 'text', text: 'x' }] }));
  const nested = document([{ type: 'blockquote', children: [{ type: 'blockquote', children: [] }] } as unknown]);
  const extra = document([{ type: 'paragraph', children: [{ type: 'link', url: 'https://example.com', html: '<b>x</b>', children: [] }] }]);
  assert.ok(validateTemplate(document(tooMany), fields).errors.some((error) => error.code === 'node_limit'));
  assert.ok(validateTemplate(nested, fields).errors.some((error) => error.code === 'invalid_child'));
  assert.ok(validateTemplate(extra, fields).errors.some((error) => error.code === 'unknown_property'));
});

test('rejects post-render rich-message length overflow without truncating', () => {
  const result = renderTelegramTemplate(
    document([{ type: 'paragraph', children: [{ type: 'formField', fieldId: 'email', fallback: '-' }] }]),
    fields,
    { email: 'x'.repeat(10_001) }
  );
  assert.ok(result.errors.some((error) => error.code === 'rendered_length'));
  assert.equal(result.html, '');
});

test('rejects oversized hostile variables without emitting unescaped content', () => {
  const result = renderTelegramTemplate(
    document([{ type: 'paragraph', children: [{ type: 'formField', fieldId: 'email', fallback: '-' }] }]),
    fields,
    { email: `<script title="x">${'&'.repeat(20_001)}</script>` }
  );
  assert.equal(result.html, '');
  assert.ok(result.errors.some((error) => error.code === 'variable_length' && error.path.includes('email')));
});

test('rejects unsupported runtime values without invoking coercion or getters', () => {
  let invoked = 0;
  class Hostile { toString(): string { invoked += 1; return '<b>bad</b>'; } }
  const getter = Object.defineProperty({}, 'secret', { enumerable: true, get() { invoked += 1; return 'bad'; } });
  const values: unknown[] = [() => 'bad', Symbol('bad'), new Date(), new Hostile(), getter];
  for (const value of values) {
    const result = renderTelegramTemplate(
      document([{ type: 'paragraph', children: [{ type: 'formField', fieldId: 'email', fallback: '-' }] }]),
      fields,
      { email: value }
    );
    assert.equal(result.html, '');
    assert.ok(result.errors.some((error) => error.code === 'unsupported_value'));
  }
  assert.equal(invoked, 0);
});

test('rejects unsupported values nested at and beyond the formatting depth bound', () => {
  class NestedHostile {}
  const values: unknown[] = [
    { one: { two: () => 'bad' } },
    { one: { two: Symbol('bad') } },
    { one: { two: new Date() } },
    { one: [{ two: new NestedHostile() }] },
  ];
  for (const value of values) {
    const result = renderTelegramTemplate(
      document([{ type: 'paragraph', children: [{ type: 'formField', fieldId: 'email', fallback: '-' }] }]),
      fields,
      { email: value }
    );
    assert.equal(result.html, '');
    assert.ok(result.errors.some((error) => error.code === 'unsupported_value'));
  }
});

test('rejects lone surrogates in template text, code, URLs, and submitted values', () => {
  const invalid = '\ud800';
  const templates = [
    document([{ type: 'paragraph', children: [{ type: 'text', text: invalid }] }]),
    document([{ type: 'codeBlock', code: invalid }]),
    document([{ type: 'paragraph', children: [{ type: 'link', url: `https://example.com/${invalid}`, children: [{ type: 'text', text: 'x' }] }] }]),
  ];
  for (const template of templates) {
    assert.ok(validateTemplate(template, fields).errors.some((error) => error.code === 'invalid_unicode'));
  }
  const rendered = renderTelegramTemplate(
    document([{ type: 'paragraph', children: [{ type: 'formField', fieldId: 'email', fallback: '-' }] }]),
    fields,
    { email: invalid }
  );
  assert.ok(rendered.errors.some((error) => error.code === 'invalid_unicode'));
  assert.equal(rendered.html, '');
});

test('rejects structurally nonempty templates with no meaningful content', () => {
  const meaningless = [
    document([{ type: 'paragraph', children: [] }]),
    document([{ type: 'paragraph', children: [{ type: 'text', text: '   ' }] }]),
    document([{ type: 'blockquote', children: [{ type: 'paragraph', children: [] }] }]),
  ];
  for (const template of meaningless) {
    assert.ok(validateTemplate(template, fields).errors.some((error) => error.code === 'empty_document'));
  }
});

test('creates a title and current non-layout field rows in the default template', () => {
  const result = createDefaultTelegramTemplate({ title: '<Contact>', fields: [
    ...fields,
    { id: 'divider', type: 'divider', name: 'divider', label: 'Divider' },
  ] });
  assert.equal(result.document.children[0].type, 'heading');
  const rendered = renderTelegramTemplate(result, fields, { email: 'a@example.com' });
  assert.match(rendered.html, /&lt;Contact&gt;/);
  assert.match(rendered.html, /Email: a@example\.com/);
  assert.doesNotMatch(rendered.html, /Divider/);
});
