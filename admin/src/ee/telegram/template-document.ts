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
export const telegramNotificationState = (value: TelegramNotificationValue, connections: readonly { id: string; active: boolean }[]) => {
  if (!value.connectionId) return { state: 'unselected' as const, canSend: false };
  const connection = connections.find((item) => item.id === value.connectionId);
  if (!connection) return { state: 'missing' as const, canSend: false };
  if (!connection.active) return { state: 'inactive' as const, canSend: false };
  return { state: 'connected' as const, canSend: true };
};
export const shouldSyncTelegramEditorValue = (currentEditorSerialization: string, incomingSerialization: string): boolean =>
  currentEditorSerialization !== incomingSerialization;

const escapeHtml = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const isSafeUrl = (url: string) => { try { return ['http:', 'https:', 'mailto:'].includes(new URL(url).protocol); } catch { return false; } };

export const createDefaultTelegramDocument = (fields: readonly TelegramTemplateField[], formTitle = 'Form'): TelegramTemplateDocument => ({
  version: 1,
  document: {
    type: 'document',
    children: [
      { type: 'heading', level: 2, children: [{ type: 'text', text: `New ${formTitle.trim() || 'form'} submission` }] },
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

export const validateTelegramDocument = (template: unknown, fields: readonly TelegramTemplateField[]) => {
  const errors: TelegramDocumentIssue[] = []; const warnings: TelegramDocumentWarning[] = [];
  const issue = (code: string, path: string, message: string): void => { errors.push({ code, path, message }); };
  const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
  const allowed = (node: Record<string, unknown>, names: string[], path: string) => Object.keys(node).forEach((key) => { if (!names.includes(key)) issue('unknown_property', `${path}.${key}`, `Unsupported property "${key}".`); });
  const invalidUnicode = (value: string) => { for (let i = 0; i < value.length; i += 1) { const unit = value.charCodeAt(i); if (unit >= 0xd800 && unit <= 0xdbff) { const next = value.charCodeAt(++i); if (!(next >= 0xdc00 && next <= 0xdfff)) return true; } else if (unit >= 0xdc00 && unit <= 0xdfff) return true; } return false; };
  const fieldMap = new Map(fields.map((field) => [field.id, field])); const warned = new Set<string>();
  let count = 0; let meaningful = false;
  const visitInline = (value: unknown, path: string, depth: number): void => {
    if (!record(value)) return issue('invalid_node', path, 'Inline node must be an object.');
    if (++count > 200) return; if (depth > 6) return issue('depth_limit', path, 'Template nesting exceeds 6.');
    if (value.type === 'text') { allowed(value, ['type','text','marks'], path); if (typeof value.text !== 'string') issue('invalid_text', `${path}.text`, 'Text must be a string.'); else { meaningful ||= value.text.trim().length > 0; if (invalidUnicode(value.text)) issue('invalid_unicode', `${path}.text`, 'Text contains invalid Unicode.'); } if (value.marks !== undefined && (!Array.isArray(value.marks) || value.marks.some((mark) => typeof mark !== 'string' || !['bold','italic','underline','strikethrough','code'].includes(mark)))) issue('unsupported_mark', `${path}.marks`, 'Unsupported text mark.'); return; }
    if (value.type === 'formField') { allowed(value, ['type','fieldId','fallback'], path); meaningful = true; if (typeof value.fieldId !== 'string' || !value.fieldId) return issue('invalid_field', `${path}.fieldId`, 'A stable field ID is required.'); if (value.fallback !== '-') issue('invalid_fallback', `${path}.fallback`, 'The supported fallback is "-".'); const field = fieldMap.get(value.fieldId); if (!field) issue('stale_field', `${path}.fieldId`, `Field "${value.fieldId}" no longer exists.`); else if ((field.type === 'password' || field.type === 'hidden') && !warned.has(field.id)) { warned.add(field.id); warnings.push({ code: 'sensitive_field', fieldId: field.id, message: `Field "${field.label}" may contain sensitive data.` }); } return; }
    if (value.type === 'link') { allowed(value, ['type','url','children'], path); if (typeof value.url !== 'string' || !isSafeUrl(value.url)) issue('unsafe_link', `${path}.url`, 'Only absolute http, https, and mailto links are allowed.'); if (!Array.isArray(value.children)) issue('invalid_children', `${path}.children`, 'Link children must be an array.'); else value.children.forEach((child, index) => { if (record(child) && child.type === 'link') issue('invalid_child', `${path}.children[${index}]`, 'Links cannot contain links.'); else visitInline(child, `${path}.children[${index}]`, depth + 1); }); return; }
    issue('unsupported_node', `${path}.type`, 'Unsupported inline node.');
  };
  const paragraph = (value: unknown, path: string, depth: number) => { if (!record(value) || value.type !== 'paragraph') return issue('invalid_child', path, 'Expected a paragraph.'); visitBlock(value, path, depth); };
  const visitBlock = (value: unknown, path: string, depth: number): void => {
    if (!record(value)) return issue('invalid_node', path, 'Block node must be an object.');
    if (++count > 200) return; if (depth > 6) return issue('depth_limit', path, 'Template nesting exceeds 6.');
    if (value.type === 'paragraph' || value.type === 'heading') { allowed(value, value.type === 'heading' ? ['type','level','children'] : ['type','children'], path); if (value.type === 'heading' && ![1,2,3].includes(value.level as number)) issue('invalid_heading', `${path}.level`, 'Heading level must be 1, 2, or 3.'); if (!Array.isArray(value.children)) issue('invalid_children', `${path}.children`, 'Inline children must be an array.'); else value.children.forEach((child,index) => visitInline(child, `${path}.children[${index}]`, depth + 1)); return; }
    if (value.type === 'blockquote') { allowed(value, ['type','children'], path); if (!Array.isArray(value.children)) issue('invalid_children', `${path}.children`, 'Blockquote children must be paragraphs.'); else value.children.forEach((child,index) => paragraph(child, `${path}.children[${index}]`, depth + 1)); return; }
    if (value.type === 'codeBlock') { allowed(value, ['type','code','language'], path); if (typeof value.code !== 'string') issue('invalid_code', `${path}.code`, 'Code must be a string.'); else { meaningful ||= value.code.trim().length > 0; if (invalidUnicode(value.code)) issue('invalid_unicode', `${path}.code`, 'Code contains invalid Unicode.'); } if (value.language !== undefined && (typeof value.language !== 'string' || !/^[a-z0-9_+-]{1,32}$/i.test(value.language))) issue('invalid_language', `${path}.language`, 'Invalid code language.'); return; }
    if (value.type === 'list') { allowed(value, ['type','style','children'], path); if (value.style !== 'ordered' && value.style !== 'unordered') issue('invalid_list_style', `${path}.style`, 'Invalid list style.'); if (!Array.isArray(value.children)) issue('invalid_children', `${path}.children`, 'List children must be list items.'); else { if (value.children.length > 50) issue('list_limit', `${path}.children`, 'List exceeds 50 items.'); value.children.forEach((item,index) => { const itemPath=`${path}.children[${index}]`; if (!record(item) || item.type !== 'listItem') return issue('invalid_child', itemPath, 'Expected a list item.'); count += 1; allowed(item,['type','children'],itemPath); if (!Array.isArray(item.children)) issue('invalid_children', `${itemPath}.children`, 'List item children must be paragraphs.'); else item.children.forEach((child,childIndex) => paragraph(child, `${itemPath}.children[${childIndex}]`, depth + 2)); }); } return; }
    if (value.type === 'divider') { allowed(value, ['type'], path); meaningful = true; return; }
    issue('unsupported_node', `${path}.type`, 'Unsupported block node.');
  };
  if (!record(template)) issue('invalid_document', '$', 'Template must be an object.'); else { allowed(template,['version','document'],'$'); if (template.version !== 1) issue('invalid_version','$.version','Only version 1 is supported.'); if (!record(template.document) || template.document.type !== 'document' || !Array.isArray(template.document.children)) issue('invalid_document','$.document','A document with children is required.'); else { allowed(template.document,['type','children'],'$.document'); if (!template.document.children.length) issue('empty_document','$.document.children','Template must contain a block.'); template.document.children.forEach((child,index) => visitBlock(child, `$.document.children[${index}]`, 1)); if (!meaningful) issue('empty_document','$.document.children','Template must contain meaningful content.'); } }
  if (count > 200) issue('node_limit','$.document','Template exceeds 200 nodes.');
  try { if (JSON.stringify(template).length > 100_000) issue('size_limit','$','Template is too large.'); } catch { issue('invalid_document','$','Template must be serializable.'); }
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
    if (node.type === 'paragraph') return `<p>${para(node)}</p>`;
    if (node.type === 'heading') return `<h${node.level}>${para(node)}</h${node.level}>`;
    if (node.type === 'blockquote') return `<blockquote>${node.children.map((child) => `<p>${para(child)}</p>`).join('\n')}</blockquote>`;
    if (node.type === 'codeBlock') {
      const language = node.language ? ` class="language-${escapeHtml(node.language)}"` : '';
      return `<pre><code${language}>${escapeHtml(node.code)}</code></pre>`;
    }
    if (node.type === 'divider') return '<hr/>';
    const tag = node.style === 'ordered' ? 'ol' : 'ul';
    const items = node.children.map((item) => `<li>${item.children.map((child) => `<p>${para(child)}</p>`).join('')}</li>`).join('');
    return `<${tag}>${items}</${tag}>`;
  }).join('\n');
};

export interface TelegramPreviewPalette {
  background: string;
  surface: string;
  text: string;
  mutedText: string;
  border: string;
  link: string;
  accent: string;
}

export const buildTelegramPreviewDocument = (
  content: string,
  palette: TelegramPreviewPalette
): string => `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="color-scheme" content="light dark">
<style>
  * { box-sizing: border-box; }
  html, body { min-height: 100%; }
  body {
    margin: 0;
    padding: 16px;
    background: ${palette.background};
    color: ${palette.text};
    font: 14px/1.5 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    overflow-wrap: anywhere;
  }
  body > :first-child { margin-top: 0; }
  body > :last-child { margin-bottom: 0; }
  p { margin: 0 0 12px; white-space: pre-wrap; }
  h1, h2, h3 { margin: 0 0 12px; color: ${palette.text}; line-height: 1.3; }
  h1 { font-size: 22px; }
  h2 { font-size: 18px; }
  h3 { font-size: 16px; }
  blockquote {
    margin: 0 0 12px;
    padding: 8px 12px;
    border-inline-start: 3px solid ${palette.accent};
    border-radius: 4px;
    background: ${palette.surface};
    color: ${palette.mutedText};
  }
  blockquote p:last-child, li p:last-child { margin-bottom: 0; }
  ul, ol { margin: 0 0 12px; padding-inline-start: 24px; }
  li { margin-bottom: 4px; }
  pre {
    margin: 0 0 12px;
    padding: 12px;
    border: 1px solid ${palette.border};
    border-radius: 4px;
    background: ${palette.surface};
    white-space: pre-wrap;
    overflow-x: auto;
  }
  code {
    padding: 1px 4px;
    border-radius: 3px;
    background: ${palette.surface};
    color: ${palette.text};
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  }
  pre code { padding: 0; background: transparent; }
  a { color: ${palette.link}; text-decoration: underline; }
  hr { margin: 16px 0; border: 0; border-top: 1px solid ${palette.border}; }
</style>
</head>
<body>${content}</body>
</html>`;
