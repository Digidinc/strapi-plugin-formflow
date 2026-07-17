/* SPDX-License-Identifier: LicenseRef-FormFlow-EE — Commercial. See LICENSE-EE. Not covered by MIT. */

export type TelegramMark = 'bold' | 'italic' | 'underline' | 'strikethrough' | 'code';
export type TelegramTextNode = { type: 'text'; text: string; marks?: TelegramMark[] };
export type TelegramFormFieldNode = { type: 'formField'; fieldId: string; fallback: '-' };
export type TelegramLinkNode = { type: 'link'; url: string; children: Array<TelegramTextNode | TelegramFormFieldNode> };
export type TelegramInlineNode = TelegramTextNode | TelegramFormFieldNode | TelegramLinkNode;
export type TelegramParagraphNode = { type: 'paragraph'; children: TelegramInlineNode[] };
export type TelegramTemplateNode = TelegramParagraphNode
  | { type: 'heading'; level: 1 | 2 | 3; children: TelegramInlineNode[] }
  | { type: 'blockquote'; children: TelegramParagraphNode[] }
  | { type: 'codeBlock'; code: string; language?: string }
  | { type: 'list'; style: 'ordered' | 'unordered'; children: Array<{ type: 'listItem'; children: TelegramParagraphNode[] }> }
  | { type: 'divider' };
export interface TelegramTemplateDocument { version: 1; document: { type: 'document'; children: TelegramTemplateNode[] } }
export interface TelegramTemplateField { id: string; type: string; name?: string; label: string; defaultValue?: unknown }
export interface TelegramDocumentIssue { code: string; path: string; message: string }
export interface TelegramDocumentWarning { code: 'sensitive_field'; fieldId: string; message: string }
export interface TelegramNotificationValue { enabled: boolean; connectionId: string; destination: string; template: TelegramTemplateDocument }
export const buildTelegramTestPayload = (value: TelegramNotificationValue) => ({ connectionId: value.connectionId, destination: value.destination, template: value.template });
export const telegramNotificationState = (value: TelegramNotificationValue, connections: readonly { id: string; active: boolean; credentialConfigured: boolean }[]) => {
  if (!value.connectionId) return { state: 'unselected' as const, canSend: false };
  const connection = connections.find((item) => item.id === value.connectionId);
  if (!connection) return { state: 'missing' as const, canSend: false };
  if (!connection.active) return { state: 'inactive' as const, canSend: false };
  if (!connection.credentialConfigured) return { state: 'disconnected' as const, canSend: false };
  return { state: 'connected' as const, canSend: true };
};

const escapeHtml = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const isSafeUrl = (url: string) => { try { return ['http:', 'https:', 'mailto:'].includes(new URL(url).protocol); } catch { return false; } };

export const createDefaultTelegramDocument = (fields: readonly TelegramTemplateField[]): TelegramTemplateDocument => ({
  version: 1,
  document: {
    type: 'document',
    children: [
      { type: 'heading', level: 2, children: [{ type: 'text', text: 'New form submission' }] },
      ...fields.map((field): TelegramParagraphNode => ({ type: 'paragraph', children: [
        { type: 'text', text: `${field.label}: `, marks: ['bold'] },
        { type: 'formField', fieldId: field.id, fallback: '-' },
      ] })),
    ],
  },
});

export const sampleForField = (field: TelegramTemplateField): string => {
  if (typeof field.defaultValue === 'string' && field.defaultValue.trim()) return field.defaultValue;
  if (field.type === 'email') return 'person@example.com';
  if (field.type === 'number') return '42';
  if (field.type === 'date') return '2026-01-15';
  return '-';
};

export const validateTelegramDocument = (template: TelegramTemplateDocument, fields: readonly TelegramTemplateField[]) => {
  const errors: TelegramDocumentIssue[] = [];
  const warnings: TelegramDocumentWarning[] = [];
  const fieldMap = new Map(fields.map((field) => [field.id, field]));
  const warned = new Set<string>();
  const inline = (nodes: TelegramInlineNode[], path: string) => nodes.forEach((node, index) => {
    const nodePath = `${path}[${index}]`;
    if (node.type === 'formField') {
      const field = fieldMap.get(node.fieldId);
      if (!field) errors.push({ code: 'stale_field', path: `${nodePath}.fieldId`, message: `Field "${node.fieldId}" no longer exists.` });
      else if ((field.type === 'password' || field.type === 'hidden') && !warned.has(field.id)) {
        warned.add(field.id); warnings.push({ code: 'sensitive_field', fieldId: field.id, message: `Field "${field.label}" may contain sensitive data.` });
      }
    } else if (node.type === 'link') {
      if (!isSafeUrl(node.url)) errors.push({ code: 'unsafe_link', path: `${nodePath}.url`, message: 'Only http, https, and mailto links are allowed.' });
      inline(node.children, `${nodePath}.children`);
    }
  });
  template.document.children.forEach((node, index) => {
    const path = `$.document.children[${index}]`;
    if (node.type === 'paragraph' || node.type === 'heading') inline(node.children, `${path}.children`);
    else if (node.type === 'blockquote') node.children.forEach((child, childIndex) => inline(child.children, `${path}.children[${childIndex}].children`));
    else if (node.type === 'list') node.children.forEach((item, itemIndex) => item.children.forEach((child, childIndex) => inline(child.children, `${path}.children[${itemIndex}].children[${childIndex}].children`)));
  });
  return { valid: errors.length === 0, errors, warnings };
};

export const serializeTelegramDocument = (document: TelegramTemplateDocument): string => JSON.stringify(document);
export const deserializeTelegramDocument = (value: string): TelegramTemplateDocument => {
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== 'object' || (parsed as TelegramTemplateDocument).version !== 1 || (parsed as TelegramTemplateDocument).document?.type !== 'document' || !Array.isArray((parsed as TelegramTemplateDocument).document.children)) throw new Error('Expected a FormFlow Telegram template document.');
  return parsed as TelegramTemplateDocument;
};

export const previewTelegramDocument = (template: TelegramTemplateDocument, fields: readonly TelegramTemplateField[], samples: Record<string, unknown> = {}): string => {
  const fieldMap = new Map(fields.map((field) => [field.id, field]));
  const renderInline = (node: TelegramInlineNode): string => {
    if (node.type === 'formField') return escapeHtml(String(samples[node.fieldId] ?? (fieldMap.has(node.fieldId) ? sampleForField(fieldMap.get(node.fieldId)!) : node.fallback)));
    if (node.type === 'link') return isSafeUrl(node.url) ? `<a href="${escapeHtml(node.url)}">${node.children.map(renderInline).join('')}</a>` : node.children.map(renderInline).join('');
    let value = escapeHtml(node.text);
    for (const mark of node.marks ?? []) value = `<${({ bold: 'b', italic: 'i', underline: 'u', strikethrough: 's', code: 'code' } as const)[mark]}>${value}</${({ bold: 'b', italic: 'i', underline: 'u', strikethrough: 's', code: 'code' } as const)[mark]}>`;
    return value;
  };
  const para = (node: TelegramParagraphNode | Extract<TelegramTemplateNode, { type: 'heading' }>) => node.children.map(renderInline).join('');
  return template.document.children.map((node) => {
    if (node.type === 'paragraph') return `${para(node)}\n`;
    if (node.type === 'heading') return `<b>${para(node)}</b>\n`;
    if (node.type === 'blockquote') return `<blockquote>${node.children.map(para).join('\n')}</blockquote>\n`;
    if (node.type === 'codeBlock') return `<pre>${escapeHtml(node.code)}</pre>\n`;
    if (node.type === 'divider') return '──────────\n';
    return node.children.map((item, index) => `${node.style === 'ordered' ? `${index + 1}.` : '•'} ${item.children.map(para).join(' ')}`).join('\n');
  }).join('').trim();
};
