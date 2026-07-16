/* SPDX-License-Identifier: LicenseRef-FormFlow-EE — Commercial. See LICENSE-EE. Not covered by MIT. */

import type {
  TelegramFormFieldNode,
  TelegramLinkNode,
  TelegramTemplateDocument,
  TelegramTemplateNode,
  TelegramTextNode,
} from './types';
import { isLayoutField } from '../../utils/validation-rules';

export interface TelegramTemplateField {
  id: string;
  type: string;
  name?: string;
  label: string;
}

export interface TemplateValidationError {
  code: string;
  path: string;
  message: string;
}

export interface TemplateValidationWarning {
  code: 'sensitive_field';
  fieldId: string;
  message: string;
}

export interface TemplateValidationResult {
  valid: boolean;
  errors: TemplateValidationError[];
  warnings: TemplateValidationWarning[];
}

export interface TelegramTemplateRenderResult extends TemplateValidationResult {
  html: string;
}

const MAX_NODES = 200;
const MAX_DEPTH = 6;
const MAX_RENDERED_LENGTH = 10_000;
const MAX_COLLECTION_ITEMS = 5;
const MAX_LIST_ITEMS = 50;
const MAX_OBJECT_KEYS = 8;
const MAX_FORMAT_DEPTH = 2;
const MAX_FORMATTED_VALUE_LENGTH = 20_000;
const MARK_TAGS = {
  bold: 'b', italic: 'i', underline: 'u', strikethrough: 's', code: 'code',
} as const;

type UnknownRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const hasInvalidUnicode = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!Number.isFinite(next) || next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return true;
  }
  return false;
};

const escapeHtml = (value: string): string => value
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

function allowedProperties(
  node: UnknownRecord,
  allowed: readonly string[],
  path: string,
  errors: TemplateValidationError[]
): void {
  for (const property of Object.keys(node)) {
    if (!allowed.includes(property)) {
      errors.push({ code: 'unknown_property', path: `${path}.${property}`, message: `Unsupported property "${property}".` });
    }
  }
}

export function validateTemplate(
  template: TelegramTemplateDocument,
  fields: readonly TelegramTemplateField[]
): TemplateValidationResult {
  const errors: TemplateValidationError[] = [];
  const warnings: TemplateValidationWarning[] = [];
  const fieldById = new Map(fields.map((field) => [field.id, field]));
  const warned = new Set<string>();
  let nodeCount = 0;
  let meaningful = false;

  const error = (code: string, path: string, message: string): void => { errors.push({ code, path, message }); };

  const visitInline = (value: unknown, path: string, depth: number): void => {
    if (!isRecord(value)) return error('invalid_node', path, 'Inline node must be an object.');
    if (++nodeCount > MAX_NODES) return;
    if (depth > MAX_DEPTH) return error('depth_limit', path, `Template nesting exceeds ${MAX_DEPTH}.`);
    switch (value.type) {
      case 'text': {
        allowedProperties(value, ['type', 'text', 'marks'], path, errors);
        if (typeof value.text !== 'string') error('invalid_text', `${path}.text`, 'Text must be a string.');
        else {
          if (hasInvalidUnicode(value.text)) error('invalid_unicode', `${path}.text`, 'Text contains an invalid Unicode surrogate.');
          if (value.text.trim().length > 0) meaningful = true;
        }
        if (value.marks !== undefined && (!Array.isArray(value.marks) || value.marks.some((mark) => typeof mark !== 'string' || !(mark in MARK_TAGS)))) {
          error('unsupported_mark', `${path}.marks`, 'Only Telegram-safe inline marks are supported.');
        }
        break;
      }
      case 'formField': {
        allowedProperties(value, ['type', 'fieldId', 'fallback'], path, errors);
        if (typeof value.fieldId !== 'string' || value.fieldId.length === 0) {
          error('invalid_field', `${path}.fieldId`, 'A stable field ID is required.');
          break;
        }
        if (value.fallback !== '-') error('invalid_fallback', `${path}.fallback`, 'The supported fallback is "-".');
        const field = fieldById.get(value.fieldId);
        meaningful = true;
        if (!field) error('stale_field', `${path}.fieldId`, `Field "${value.fieldId}" no longer exists.`);
        else if (field.type === 'password' && !warned.has(field.id)) {
          warned.add(field.id);
          warnings.push({ code: 'sensitive_field', fieldId: field.id, message: `Field "${field.label}" may contain sensitive data.` });
        }
        break;
      }
      case 'link': {
        allowedProperties(value, ['type', 'url', 'children'], path, errors);
        if (typeof value.url !== 'string') error('invalid_link', `${path}.url`, 'Link URL must be a string.');
        else {
          if (hasInvalidUnicode(value.url)) error('invalid_unicode', `${path}.url`, 'Link URL contains an invalid Unicode surrogate.');
          try {
            const protocol = new URL(value.url).protocol;
            if (!['http:', 'https:', 'mailto:'].includes(protocol)) error('unsafe_link', `${path}.url`, 'Only http, https, and mailto links are allowed.');
          } catch {
            error('invalid_link', `${path}.url`, 'Link URL must be absolute and valid.');
          }
        }
        if (!Array.isArray(value.children)) error('invalid_children', `${path}.children`, 'Link children must be an array.');
        else value.children.forEach((child, index) => {
          if (isRecord(child) && child.type === 'link') error('invalid_child', `${path}.children[${index}]`, 'Links cannot contain links.');
          else visitInline(child, `${path}.children[${index}]`, depth + 1);
        });
        break;
      }
      default: error('unsupported_node', `${path}.type`, `Unsupported inline node type "${String(value.type)}".`);
    }
  };

  const visitBlock = (value: unknown, path: string, depth: number): void => {
    if (!isRecord(value)) return error('invalid_node', path, 'Block node must be an object.');
    if (++nodeCount > MAX_NODES) return;
    if (depth > MAX_DEPTH) return error('depth_limit', path, `Template nesting exceeds ${MAX_DEPTH}.`);
    switch (value.type) {
      case 'paragraph':
      case 'heading': {
        allowedProperties(value, value.type === 'heading' ? ['type', 'level', 'children'] : ['type', 'children'], path, errors);
        if (value.type === 'heading' && ![1, 2, 3].includes(value.level as number)) error('invalid_heading', `${path}.level`, 'Heading level must be 1, 2, or 3.');
        if (!Array.isArray(value.children)) error('invalid_children', `${path}.children`, 'Inline children must be an array.');
        else value.children.forEach((child, index) => visitInline(child, `${path}.children[${index}]`, depth + 1));
        break;
      }
      case 'blockquote': {
        allowedProperties(value, ['type', 'children'], path, errors);
        if (!Array.isArray(value.children)) error('invalid_children', `${path}.children`, 'Blockquote children must be paragraphs.');
        else value.children.forEach((child, index) => {
          if (!isRecord(child) || child.type !== 'paragraph') error('invalid_child', `${path}.children[${index}]`, 'Blockquotes may contain paragraphs only.');
          else visitBlock(child, `${path}.children[${index}]`, depth + 1);
        });
        break;
      }
      case 'codeBlock': {
        allowedProperties(value, ['type', 'code', 'language'], path, errors);
        if (typeof value.code !== 'string') error('invalid_code', `${path}.code`, 'Code block content must be a string.');
        else {
          if (hasInvalidUnicode(value.code)) error('invalid_unicode', `${path}.code`, 'Code contains an invalid Unicode surrogate.');
          if (value.code.trim().length > 0) meaningful = true;
        }
        if (value.language !== undefined &&
          (typeof value.language !== 'string' || !/^[a-z0-9_+-]{1,32}$/i.test(value.language))) {
          error('invalid_language', `${path}.language`, 'Code block language must be a short safe identifier.');
        }
        break;
      }
      case 'list': {
        allowedProperties(value, ['type', 'style', 'children'], path, errors);
        if (value.style !== 'ordered' && value.style !== 'unordered') {
          error('invalid_list_style', `${path}.style`, 'List style must be ordered or unordered.');
        }
        if (!Array.isArray(value.children)) error('invalid_children', `${path}.children`, 'List children must be list items.');
        else {
          if (value.children.length > MAX_LIST_ITEMS) error('list_limit', `${path}.children`, `List exceeds ${MAX_LIST_ITEMS} items.`);
          value.children.forEach((item, itemIndex) => {
            const itemPath = `${path}.children[${itemIndex}]`;
            if (!isRecord(item) || item.type !== 'listItem') return error('invalid_child', itemPath, 'Lists may contain list items only.');
            if (++nodeCount > MAX_NODES) return;
            allowedProperties(item, ['type', 'children'], itemPath, errors);
            if (!Array.isArray(item.children)) error('invalid_children', `${itemPath}.children`, 'List item children must be paragraphs.');
            else item.children.forEach((child, childIndex) => {
              if (!isRecord(child) || child.type !== 'paragraph') error('invalid_child', `${itemPath}.children[${childIndex}]`, 'List items may contain paragraphs only.');
              else visitBlock(child, `${itemPath}.children[${childIndex}]`, depth + 2);
            });
          });
        }
        break;
      }
      case 'divider':
        allowedProperties(value, ['type'], path, errors);
        meaningful = true;
        break;
      default: error('unsupported_node', `${path}.type`, `Unsupported block node type "${String(value.type)}".`);
    }
  };

  if (!isRecord(template)) error('invalid_document', '$', 'Template must be an object.');
  else {
    allowedProperties(template, ['version', 'document'], '$', errors);
    if (template.version !== 1) error('invalid_version', '$.version', 'Only template version 1 is supported.');
    if (!isRecord(template.document) || template.document.type !== 'document' || !Array.isArray(template.document.children)) {
      error('invalid_document', '$.document', 'A document node with children is required.');
    } else {
      allowedProperties(template.document, ['type', 'children'], '$.document', errors);
      if (template.document.children.length === 0) error('empty_document', '$.document.children', 'Template must contain at least one block.');
      template.document.children.forEach((child, index) => visitBlock(child, `$.document.children[${index}]`, 1));
      if (template.document.children.length > 0 && !meaningful) error('empty_document', '$.document.children', 'Template must contain meaningful content.');
    }
  }
  if (nodeCount > MAX_NODES) error('node_limit', '$.document', `Template exceeds ${MAX_NODES} nodes.`);
  return { valid: errors.length === 0, errors, warnings };
}

type FormattedValue = { ok: true; value: string } | { ok: false; message: string };

function validateRuntimeValue(value: unknown, depth = 0, budget = { nodes: 0 }): string | undefined {
  budget.nodes += 1;
  if (budget.nodes > MAX_NODES || depth > MAX_DEPTH) return 'Submitted value exceeds structural bounds.';
  if (value === null || value === undefined || ['string', 'boolean', 'bigint'].includes(typeof value)) return undefined;
  if (typeof value === 'number') return Number.isFinite(value) ? undefined : 'Submitted number must be finite.';
  if (Array.isArray(value)) {
    const count = Math.min(value.length, MAX_COLLECTION_ITEMS);
    for (let index = 0; index < count; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, `${index}`);
      if (!descriptor || !('value' in descriptor)) return 'Submitted arrays may not contain accessors or sparse entries.';
      const error = validateRuntimeValue(descriptor.value, depth + 1, budget);
      if (error) return error;
    }
    return undefined;
  }
  if (!isRecord(value)) return 'Submitted value type is not supported.';
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return 'Submitted objects must be plain objects.';
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Object.keys(descriptors);
  if (keys.some((key) => !('value' in descriptors[key]))) return 'Submitted objects may not contain accessors.';
  for (const key of keys.slice(0, MAX_OBJECT_KEYS)) {
    const error = validateRuntimeValue(descriptors[key].value, depth + 1, budget);
    if (error) return error;
  }
  return undefined;
}

function formatValue(value: unknown, depth = 0): FormattedValue {
  if (depth === 0) {
    const admissibilityError = validateRuntimeValue(value);
    if (admissibilityError) return { ok: false, message: admissibilityError };
  }
  if (value === null || value === undefined || value === '') return { ok: true, value: '-' };
  if (typeof value === 'boolean') return { ok: true, value: value ? 'Yes' : 'No' };
  if (typeof value === 'string') return hasInvalidUnicode(value)
    ? { ok: false, message: 'Submitted value contains an invalid Unicode surrogate.' }
    : { ok: true, value };
  if (typeof value === 'number') return Number.isFinite(value)
    ? { ok: true, value: `${value}` }
    : { ok: false, message: 'Submitted number must be finite.' };
  if (typeof value === 'bigint') return { ok: true, value: `${value}` };
  if (depth >= MAX_FORMAT_DEPTH) return { ok: true, value: '[value]' };
  if (Array.isArray(value)) {
    const shown: string[] = [];
    const count = Math.min(value.length, MAX_COLLECTION_ITEMS);
    for (let index = 0; index < count; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, `${index}`);
      if (!descriptor || !('value' in descriptor)) return { ok: false, message: 'Submitted arrays may not contain accessors or sparse entries.' };
      const formatted = formatValue(descriptor.value, depth + 1);
      if (!formatted.ok) return formatted;
      shown.push(formatted.value);
    }
    if (value.length > shown.length) shown.push(`+${value.length - shown.length} more`);
    return { ok: true, value: shown.join(', ') || '-' };
  }
  if (isRecord(value)) {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return { ok: false, message: 'Submitted objects must be plain objects.' };
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Object.keys(descriptors);
    if (keys.some((key) => !('value' in descriptors[key]))) return { ok: false, message: 'Submitted objects may not contain accessors.' };
    const name = descriptors.name?.value;
    if (typeof name === 'string') {
      if (hasInvalidUnicode(name)) return { ok: false, message: 'Submitted file name contains an invalid Unicode surrogate.' };
      const size = descriptors.size?.value;
      if (size !== undefined && (typeof size !== 'number' || !Number.isFinite(size))) return { ok: false, message: 'Submitted file size must be a finite number.' };
      return { ok: true, value: `${name}${typeof size === 'number' ? ` (${size} bytes)` : ''}` };
    }
    const entries: string[] = [];
    for (const key of keys.slice(0, MAX_OBJECT_KEYS)) {
      const formatted = formatValue(descriptors[key].value, depth + 1);
      if (!formatted.ok) return formatted;
      entries.push(`${key}: ${formatted.value}`);
    }
    if (keys.length > entries.length) entries.push(`+${keys.length - entries.length} more`);
    return { ok: true, value: entries.join(', ') || '-' };
  }
  return { ok: false, message: 'Submitted value type is not supported.' };
}

export function renderTelegramTemplate(
  template: TelegramTemplateDocument,
  fields: readonly TelegramTemplateField[],
  data: Readonly<Record<string, unknown>>
): TelegramTemplateRenderResult {
  const validation = validateTemplate(template, fields);
  if (!validation.valid) return { ...validation, html: '' };
  const renderErrors: TemplateValidationError[] = [];

  type InlineNode = TelegramTextNode | TelegramFormFieldNode | TelegramLinkNode;
  const renderInline = (node: InlineNode): string => {
    switch (node.type) {
      case 'text': {
        let text = escapeHtml(node.text);
        for (const mark of node.marks ?? []) text = `<${MARK_TAGS[mark]}>${text}</${MARK_TAGS[mark]}>`;
        return text;
      }
      case 'formField': {
        const descriptor = Object.getOwnPropertyDescriptor(data, node.fieldId);
        if (descriptor && !('value' in descriptor)) {
          renderErrors.push({ code: 'unsupported_value', path: `$.data.${node.fieldId}`, message: 'Submitted field may not be an accessor.' });
          return '';
        }
        const formatted = formatValue(descriptor?.value);
        if (formatted.ok === false) {
          const code = formatted.message.includes('Unicode') ? 'invalid_unicode' : 'unsupported_value';
          renderErrors.push({ code, path: `$.data.${node.fieldId}`, message: formatted.message });
          return '';
        }
        if (formatted.value.length > MAX_FORMATTED_VALUE_LENGTH) {
          renderErrors.push({ code: 'variable_length', path: `$.data.${node.fieldId}`, message: `Formatted field exceeds ${MAX_FORMATTED_VALUE_LENGTH} characters.` });
          return '';
        }
        return escapeHtml(formatted.value);
      }
      case 'link':
        return `<a href="${escapeHtml(node.url)}">${node.children.map(renderInline).join('')}</a>`;
    }
  };
  const renderBlock = (node: TelegramTemplateNode): string => {
    switch (node.type) {
      case 'paragraph': return node.children.map(renderInline).join('');
      case 'heading': return `<b>${node.children.map(renderInline).join('')}</b>`;
      case 'blockquote': return `<blockquote>${node.children.map(renderBlock).join('\n')}</blockquote>`;
      case 'codeBlock': {
        const language = node.language ? ` class="language-${escapeHtml(node.language)}"` : '';
        return `<pre><code${language}>${escapeHtml(node.code)}</code></pre>`;
      }
      case 'list': return node.children.map((item, index) => {
        const marker = node.style === 'ordered' ? `${index + 1}.` : '•';
        return `${marker} ${item.children.map(renderBlock).join('\n')}`;
      }).join('\n');
      case 'divider': return '────────';
    }
  };
  const html = template.document.children.map(renderBlock).join('\n');
  const errors = [...validation.errors, ...renderErrors];
  if (hasInvalidUnicode(html)) errors.push({ code: 'invalid_unicode', path: '$.document', message: 'Rendered message contains an invalid Unicode surrogate.' });
  if (html.trim().length === 0) errors.push({ code: 'empty_render', path: '$.document', message: 'Rendered message is empty.' });
  if (html.length > MAX_RENDERED_LENGTH) errors.push({ code: 'rendered_length', path: '$.document', message: `Rendered message exceeds ${MAX_RENDERED_LENGTH} characters.` });
  return { valid: errors.length === 0, errors, warnings: validation.warnings, html: errors.length ? '' : html };
}

export function createDefaultTelegramTemplate(form: {
  title: string;
  fields: readonly TelegramTemplateField[];
}): TelegramTemplateDocument {
  const children: TelegramTemplateDocument['document']['children'] = [
    { type: 'heading', level: 2, children: [{ type: 'text', text: form.title }] },
  ];
  for (const field of form.fields) {
    if (isLayoutField(field.type)) continue;
    children.push({ type: 'paragraph', children: [
      { type: 'text', text: `${field.label}: ` },
      { type: 'formField', fieldId: field.id, fallback: '-' },
    ] });
  }
  return { version: 1, document: { type: 'document', children } };
}
