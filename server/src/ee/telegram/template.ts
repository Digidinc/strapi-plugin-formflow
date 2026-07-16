/* SPDX-License-Identifier: LicenseRef-FormFlow-EE — Commercial. See LICENSE-EE. Not covered by MIT. */

import type {
  TelegramFormFieldNode,
  TelegramLinkNode,
  TelegramTemplateDocument,
  TelegramTemplateNode,
  TelegramTextNode,
} from './types';

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
const MAX_OBJECT_KEYS = 8;
const MAX_FORMAT_DEPTH = 2;
const MAX_FORMATTED_VALUE_LENGTH = 20_000;
const MARK_TAGS = {
  bold: 'b', italic: 'i', underline: 'u', strikethrough: 's', code: 'code',
} as const;

type UnknownRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

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

  const error = (code: string, path: string, message: string): void => { errors.push({ code, path, message }); };

  const visitInline = (value: unknown, path: string, depth: number): void => {
    if (!isRecord(value)) return error('invalid_node', path, 'Inline node must be an object.');
    if (++nodeCount > MAX_NODES) return;
    if (depth > MAX_DEPTH) return error('depth_limit', path, `Template nesting exceeds ${MAX_DEPTH}.`);
    switch (value.type) {
      case 'text': {
        allowedProperties(value, ['type', 'text', 'marks'], path, errors);
        if (typeof value.text !== 'string') error('invalid_text', `${path}.text`, 'Text must be a string.');
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
    }
  }
  if (nodeCount > MAX_NODES) error('node_limit', '$.document', `Template exceeds ${MAX_NODES} nodes.`);
  return { valid: errors.length === 0, errors, warnings };
}

function formatValue(value: unknown, depth = 0): string {
  if (value === null || value === undefined || value === '') return '-';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint') return String(value);
  if (depth >= MAX_FORMAT_DEPTH) return '[value]';
  if (Array.isArray(value)) {
    const shown = value.slice(0, MAX_COLLECTION_ITEMS).map((item) => formatValue(item, depth + 1));
    if (value.length > shown.length) shown.push(`+${value.length - shown.length} more`);
    return shown.join(', ') || '-';
  }
  if (isRecord(value)) {
    if (typeof value.name === 'string') {
      const metadata = typeof value.size === 'number' ? ` (${value.size} bytes)` : '';
      return `${value.name}${metadata}`;
    }
    const entries = Object.entries(value).slice(0, MAX_OBJECT_KEYS)
      .map(([key, item]) => `${key}: ${formatValue(item, depth + 1)}`);
    if (Object.keys(value).length > entries.length) entries.push(`+${Object.keys(value).length - entries.length} more`);
    return entries.join(', ') || '-';
  }
  return String(value);
}

export function renderTelegramTemplate(
  template: TelegramTemplateDocument,
  fields: readonly TelegramTemplateField[],
  data: Readonly<Record<string, unknown>>
): TelegramTemplateRenderResult {
  const validation = validateTemplate(template, fields);
  if (!validation.valid) return { ...validation, html: '' };

  type InlineNode = TelegramTextNode | TelegramFormFieldNode | TelegramLinkNode;
  const renderInline = (node: InlineNode): string => {
    switch (node.type) {
      case 'text': {
        let text = escapeHtml(node.text);
        for (const mark of node.marks ?? []) text = `<${MARK_TAGS[mark]}>${text}</${MARK_TAGS[mark]}>`;
        return text;
      }
      case 'formField': {
        const value = formatValue(data[node.fieldId]);
        if (value.length > MAX_FORMATTED_VALUE_LENGTH) return value;
        return escapeHtml(value);
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
    }
  };
  const html = template.document.children.map(renderBlock).join('\n');
  const errors = [...validation.errors];
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
    if (['divider', 'heading', 'paragraph', 'section', 'pageBreak'].includes(field.type)) continue;
    children.push({ type: 'paragraph', children: [
      { type: 'text', text: `${field.label}: ` },
      { type: 'formField', fieldId: field.id, fallback: '-' },
    ] });
  }
  return { version: 1, document: { type: 'document', children } };
}
