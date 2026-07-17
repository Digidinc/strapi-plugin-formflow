/* SPDX-License-Identifier: LicenseRef-FormFlow-EE — Commercial. See LICENSE-EE. Not covered by MIT. */
import { useEffect, useMemo, useRef } from 'react';
import { useIntl } from 'react-intl';
import { $createCodeNode, CodeNode } from '@lexical/code';
import { $createLinkNode, LinkNode, TOGGLE_LINK_COMMAND } from '@lexical/link';
import { INSERT_ORDERED_LIST_COMMAND, INSERT_UNORDERED_LIST_COMMAND, ListItemNode, ListNode } from '@lexical/list';
import { HistoryPlugin } from '@lexical/react/LexicalHistoryPlugin';
import { LexicalComposer } from '@lexical/react/LexicalComposer';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { LinkPlugin } from '@lexical/react/LexicalLinkPlugin';
import { ListPlugin } from '@lexical/react/LexicalListPlugin';
import { OnChangePlugin } from '@lexical/react/LexicalOnChangePlugin';
import { ContentEditable } from '@lexical/react/LexicalContentEditable';
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin';
import {
  $createHeadingNode, $createQuoteNode, HeadingNode, QuoteNode,
} from '@lexical/rich-text';
import {
  $createParagraphNode, $createTextNode, $getRoot, $getSelection, $isElementNode,
  $isRangeSelection, COMMAND_PRIORITY_EDITOR, DecoratorNode, FORMAT_TEXT_COMMAND,
  REDO_COMMAND, UNDO_COMMAND, type EditorConfig, type LexicalEditor, type LexicalNode,
  type NodeKey, type SerializedLexicalNode, type Spread,
} from 'lexical';
import { $insertNodeToNearestRoot } from '@lexical/utils';

import { shouldSyncTelegramEditorValue, type TelegramParagraphNode, type TelegramTemplateDocument, type TelegramTemplateField, type TelegramTemplateNode } from '../telegram/template-document';
import { getTranslation } from '../../utils/getTranslation';

type SerializedVariable = Spread<{ fieldId: string; type: 'telegram-variable'; version: 1 }, SerializedLexicalNode>;
export class TelegramVariableNode extends DecoratorNode<JSX.Element> {
  __fieldId: string;
  __label: string;
  static getType() { return 'telegram-variable'; }
  static clone(node: TelegramVariableNode) { return new TelegramVariableNode(node.__fieldId, node.__label, node.__key); }
  static importJSON(node: SerializedVariable) { return new TelegramVariableNode(node.fieldId, node.fieldId); }
  constructor(fieldId: string, label = fieldId, key?: NodeKey) { super(key); this.__fieldId = fieldId; this.__label = label; }
  exportJSON(): SerializedVariable { return { ...super.exportJSON(), type: 'telegram-variable', version: 1, fieldId: this.__fieldId }; }
  createDOM(config: EditorConfig) { const span = document.createElement('span'); span.className = config.theme.text?.code ?? ''; return span; }
  updateDOM() { return false; }
  isInline() { return true; }
  decorate() { return <span contentEditable={false} aria-label={this.__label} data-field-id={this.__fieldId}>{`{{ ${this.__label} }}`}</span>; }
}
type SerializedDivider = Spread<{ type: 'telegram-divider'; version: 1 }, SerializedLexicalNode>;
export class TelegramDividerNode extends DecoratorNode<JSX.Element> {
  static getType() { return 'telegram-divider'; }
  static clone(node: TelegramDividerNode) { return new TelegramDividerNode(node.__key); }
  static importJSON(_: SerializedDivider) { return new TelegramDividerNode(); }
  exportJSON(): SerializedDivider { return { ...super.exportJSON(), type: 'telegram-divider', version: 1 }; }
  createDOM() { return document.createElement('div'); }
  updateDOM() { return false; }
  isInline() { return false; }
  decorate() { return <hr />; }
}
class TelegramParagraphBreakNode extends DecoratorNode<JSX.Element> {
  static getType() { return 'telegram-paragraph-break'; }
  static clone(node: TelegramParagraphBreakNode) { return new TelegramParagraphBreakNode(node.__key); }
  static importJSON() { return new TelegramParagraphBreakNode(); }
  exportJSON() { return { ...super.exportJSON(), type: 'telegram-paragraph-break', version: 1 }; }
  createDOM() { return document.createElement('span'); }
  updateDOM() { return false; }
  isInline() { return true; }
  decorate() { return <br />; }
}

const appendInline = (parent: ReturnType<typeof $createParagraphNode>, children: any[], labels = new Map<string, string>()) => children.forEach((child) => {
  if (child.type === 'text') { const text = $createTextNode(child.text); for (const mark of child.marks ?? []) text.toggleFormat(mark === 'strikethrough' ? 'strikethrough' : mark); parent.append(text); }
  else if (child.type === 'formField') parent.append(new TelegramVariableNode(child.fieldId, labels.get(child.fieldId)));
  else { const link = $createLinkNode(child.url); appendInline(link as any, child.children, labels); parent.append(link); }
});
export const importTelegramAstIntoLexical = (document: TelegramTemplateDocument, fields: readonly TelegramTemplateField[] = []) => {
  const labels = new Map(fields.map((field) => [field.id, field.label]));
  const root = $getRoot(); root.clear();
  document.document.children.forEach((block) => {
    if (block.type === 'divider') return root.append(new TelegramDividerNode());
    if (block.type === 'codeBlock') { const node = $createCodeNode(block.language); node.append($createTextNode(block.code)); return root.append(node); }
    if (block.type === 'list') {
      const list = new ListNode(block.style === 'ordered' ? 'number' : 'bullet');
      block.children.forEach((item) => { const listItem = new ListItemNode(); item.children.forEach((child, index) => { if (index) listItem.append(new TelegramParagraphBreakNode()); appendInline(listItem as any, child.children, labels); }); list.append(listItem); });
      return root.append(list);
    }
    if (block.type === 'blockquote') { const quote = $createQuoteNode(); block.children.forEach((child, index) => { if (index) quote.append(new TelegramParagraphBreakNode()); appendInline(quote as any, child.children, labels); }); return root.append(quote); }
    const node = block.type === 'heading' ? $createHeadingNode(`h${block.level}` as 'h1' | 'h2' | 'h3') : $createParagraphNode();
    appendInline(node as any, block.children, labels); root.append(node);
  });
};
const marksOf = (node: any) => (['bold', 'italic', 'underline', 'strikethrough', 'code'] as const).filter((mark) => node.hasFormat?.(mark));
const inlineFrom = (element: any): any[] => element.getChildren().flatMap((node: any) => {
  if (node instanceof TelegramVariableNode) return [{ type: 'formField', fieldId: node.__fieldId, fallback: '-' }];
  if (node instanceof LinkNode) return [{ type: 'link', url: node.getURL(), children: inlineFrom(node) }];
  if (node.getType() === 'text') { const marks = marksOf(node); return [{ type: 'text', text: node.getTextContent(), ...(marks.length ? { marks } : {}) }]; }
  return $isElementNode(node) ? inlineFrom(node) : [];
});
const paragraphsFromListItem = (item: ListItemNode): TelegramParagraphNode[] => {
  const paragraphs: TelegramParagraphNode[] = [{ type: 'paragraph', children: [] }];
  item.getChildren().forEach((node: any) => {
    if (node instanceof TelegramParagraphBreakNode) paragraphs.push({ type: 'paragraph', children: [] });
    else paragraphs[paragraphs.length - 1].children.push(...inlineFrom({ getChildren: () => [node] }));
  });
  return paragraphs;
};
const paragraphsFromInlineElement = (element: any): TelegramParagraphNode[] => {
  const paragraphs: TelegramParagraphNode[] = [{ type: 'paragraph', children: [] }];
  element.getChildren().forEach((node: any) => {
    if (node instanceof TelegramParagraphBreakNode) paragraphs.push({ type: 'paragraph', children: [] });
    else if ($isElementNode(node) && !(node instanceof LinkNode)) {
      // Normalize editor states produced by older versions, which nested
      // paragraph elements inside QuoteNode.
      if (paragraphs[paragraphs.length - 1].children.length) paragraphs.push({ type: 'paragraph', children: [] });
      paragraphs[paragraphs.length - 1].children.push(...inlineFrom(node));
    } else paragraphs[paragraphs.length - 1].children.push(...inlineFrom({ getChildren: () => [node] }));
  });
  return paragraphs;
};
export const exportLexicalToTelegramAst = (): TelegramTemplateDocument => ({ version: 1, document: { type: 'document', children: $getRoot().getChildren().flatMap((node: any): TelegramTemplateNode[] => {
  if (node instanceof TelegramDividerNode) return [{ type: 'divider' }];
  if (node instanceof CodeNode) { const language = node.getLanguage(); return [{ type: 'codeBlock', code: node.getTextContent(), ...(language ? { language } : {}) }]; }
  if (node instanceof ListNode) return [{ type: 'list', style: node.getListType() === 'number' ? 'ordered' : 'unordered', children: node.getChildren().map((item: any) => ({ type: 'listItem', children: paragraphsFromListItem(item) })) }];
  if (node instanceof QuoteNode) return [{ type: 'blockquote', children: paragraphsFromInlineElement(node) }];
  if (node instanceof HeadingNode) return [{ type: 'heading', level: Number(node.getTag().slice(1)) as 1 | 2 | 3, children: inlineFrom(node) }];
  return [{ type: 'paragraph', children: inlineFrom(node) }];
}) } });
export const telegramEditorNodes = [HeadingNode, QuoteNode, CodeNode, LinkNode, ListNode, ListItemNode, TelegramVariableNode, TelegramDividerNode, TelegramParagraphBreakNode];

export const replaceSelectedTelegramBlock = (kind: string): void => {
  const selection = $getSelection();
  if (!$isRangeSelection(selection)) return;
  const anchor = selection.anchor.getNode().getTopLevelElementOrThrow();
  const replacement = kind === 'quote' ? $createQuoteNode() : kind === 'codeBlock' ? $createCodeNode() : kind.startsWith('heading') ? $createHeadingNode(kind.replace('heading', 'h') as any) : $createParagraphNode();
  const children = anchor.getChildren();
  // Quotes use Lexical's supported inline-child shape. Defensive flattening
  // prevents a legacy nested paragraph from becoming a paragraph child.
  children.forEach((child: any, index: number) => {
    if ($isElementNode(child) && !(child instanceof LinkNode)) {
      if (index) replacement.append(new TelegramParagraphBreakNode());
      replacement.append(...child.getChildren());
    } else replacement.append(child);
  });
  anchor.replace(replacement);
};

const EditorCommands = ({ fields }: { fields: readonly TelegramTemplateField[] }) => {
  const { formatMessage } = useIntl();
  const t = (key: string, fallback: string) => formatMessage({ id: getTranslation(`notifications.telegram.editor.${key}`), defaultMessage: fallback });
  const [editor] = useLexicalComposerContext();
  const block = (kind: string) => editor.update(() => replaceSelectedTelegramBlock(kind));
  const insertVariable = (fieldId: string) => editor.update(() => { const selection = $getSelection(); if ($isRangeSelection(selection)) selection.insertNodes([new TelegramVariableNode(fieldId, fields.find((item) => item.id === fieldId)?.label)]); });
  return <div role="toolbar" aria-label={t('toolbar', 'Telegram template formatting')}>
    <select aria-label={t('block', 'Block style')} defaultValue="paragraph" onChange={(e) => block(e.target.value)}><option value="paragraph">{t('paragraph', 'Paragraph')}</option><option value="heading1">{t('heading1', 'Heading 1')}</option><option value="heading2">{t('heading2', 'Heading 2')}</option><option value="heading3">{t('heading3', 'Heading 3')}</option><option value="quote">{t('quote', 'Quote')}</option><option value="codeBlock">{t('codeBlock', 'Code block')}</option></select>
    {([['bold','Bold','bold'],['italic','Italic','italic'],['underline','Underline','underline'],['strike','Strike','strikethrough'],['inlineCode','Inline code','code']] as const).map(([key, label, format]) => <button type="button" key={format} aria-label={t(key, label)} onClick={() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, format)}>{t(key, label)}</button>)}
    <button type="button" onClick={() => { const url = window.prompt(t('linkPrompt', 'Link URL')); if (url) editor.dispatchCommand(TOGGLE_LINK_COMMAND, url); }}>{t('link', 'Link')}</button>
    <button type="button" onClick={() => editor.dispatchCommand(INSERT_UNORDERED_LIST_COMMAND, undefined)}>{t('unordered', 'Bulleted list')}</button><button type="button" onClick={() => editor.dispatchCommand(INSERT_ORDERED_LIST_COMMAND, undefined)}>{t('ordered', 'Numbered list')}</button>
    <button type="button" onClick={() => editor.update(() => $insertNodeToNearestRoot(new TelegramDividerNode()))}>{t('divider', 'Divider')}</button>
    <button type="button" onClick={() => editor.dispatchCommand(UNDO_COMMAND, undefined)}>{t('undo', 'Undo')}</button><button type="button" onClick={() => editor.dispatchCommand(REDO_COMMAND, undefined)}>{t('redo', 'Redo')}</button>
    <select aria-label={t('variable', 'Insert form variable')} defaultValue="" onChange={(e) => { if (e.target.value) insertVariable(e.target.value); e.target.value = ''; }}><option value="">{t('variable', 'Insert variable…')}</option>{fields.map((field) => <option key={field.id} value={field.id}>{field.label}{field.type === 'password' || field.type === 'hidden' ? ` — ${t('sensitive', 'sensitive')}` : ''}</option>)}</select>
  </div>;
};

const ValueSyncPlugin = ({ value, fields, current }: { value: TelegramTemplateDocument; fields: readonly TelegramTemplateField[]; current: React.MutableRefObject<string> }) => {
  const [editor] = useLexicalComposerContext();
  const serialized = JSON.stringify(value);
  useEffect(() => {
    if (!shouldSyncTelegramEditorValue(current.current, serialized)) return;
    current.current = serialized;
    editor.update(() => importTelegramAstIntoLexical(value, fields), { tag: 'formflow-external-sync' });
  }, [editor, fields, serialized, value]);
  return null;
};

export const TelegramTemplateEditor = ({ value, fields, onChange }: { value: TelegramTemplateDocument; fields: readonly TelegramTemplateField[]; onChange(value: TelegramTemplateDocument): void }) => {
  const { formatMessage } = useIntl();
  const current = useRef(JSON.stringify(value));
  const config = useMemo(() => ({ namespace: 'FormFlowTelegram', nodes: telegramEditorNodes, onError: (error: Error) => { throw error; }, editorState: () => importTelegramAstIntoLexical(value, fields), theme: {} }), []);
  return <LexicalComposer initialConfig={config}><ValueSyncPlugin value={value} fields={fields} current={current} /><EditorCommands fields={fields} /><RichTextPlugin contentEditable={<ContentEditable aria-label={formatMessage({ id: getTranslation('notifications.telegram.editor.label'), defaultMessage: 'Telegram notification template' })} style={{ minHeight: 180, border: '1px solid #dcdce4', padding: 12 }} />} placeholder={<span>{formatMessage({ id: getTranslation('notifications.telegram.editor.placeholder'), defaultMessage: 'Write a Telegram notification…' })}</span>} ErrorBoundary={({ children }) => children} /><HistoryPlugin /><ListPlugin /><LinkPlugin validateUrl={(url) => { try { return ['http:', 'https:', 'mailto:'].includes(new URL(url).protocol); } catch { return false; } }} /><OnChangePlugin ignoreSelectionChange onChange={(state, editor, tags) => { if (!tags.has('formflow-external-sync')) state.read(() => { const next = exportLexicalToTelegramAst(); current.current = JSON.stringify(next); onChange(next); }); }} /></LexicalComposer>;
};
