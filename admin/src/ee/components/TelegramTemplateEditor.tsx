/* SPDX-License-Identifier: LicenseRef-FormFlow-EE — Commercial. See LICENSE-EE. Not covered by MIT. */
import { useEffect, useMemo, useRef, type PointerEvent } from 'react';
import { useIntl } from 'react-intl';
import {
  Box,
  Flex,
  IconButton,
  IconButtonGroup,
  SingleSelect,
  SingleSelectOption,
} from '@strapi/design-system';
import {
  ArrowClockwise,
  ArrowsCounterClockwise,
  Bold,
  BulletList,
  Code,
  Link as LinkIcon,
  Italic,
  Minus,
  NumberList,
  StrikeThrough,
  Underline,
} from '@strapi/icons';
import { styled } from 'styled-components';
import { $createCodeNode, CodeNode } from '@lexical/code-core';
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
  $createLineBreakNode, $createParagraphNode, $createTextNode, $getRoot, $getSelection, $isElementNode,
  $isLineBreakNode,
  $isRangeSelection, COMMAND_PRIORITY_EDITOR, DecoratorNode, FORMAT_TEXT_COMMAND,
  REDO_COMMAND, UNDO_COMMAND, type EditorConfig, type LexicalEditor, type LexicalNode,
  type EditorThemeClasses, type NodeKey, type SerializedLexicalNode, type Spread,
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
  createDOM(_config: EditorConfig) { const span = document.createElement('span'); span.className = 'formflow-telegram-variable'; return span; }
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
  if (child.type === 'text') child.text.split('\n').forEach((value: string, index: number, lines: string[]) => {
    if (value) {
      const text = $createTextNode(value);
      for (const mark of child.marks ?? []) text.toggleFormat(mark === 'strikethrough' ? 'strikethrough' : mark);
      parent.append(text);
    }
    if (index < lines.length - 1) parent.append($createLineBreakNode());
  });
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
  if ($isLineBreakNode(node)) return [{ type: 'text', text: '\n' }];
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

export const telegramEditorTheme: EditorThemeClasses = {
  root: 'formflow-telegram-root',
  paragraph: 'formflow-telegram-paragraph',
  heading: {
    h1: 'formflow-telegram-heading-one',
    h2: 'formflow-telegram-heading-two',
    h3: 'formflow-telegram-heading-three',
  },
  quote: 'formflow-telegram-quote',
  code: 'formflow-telegram-code-block',
  link: 'formflow-telegram-link',
  list: {
    ul: 'formflow-telegram-list',
    ol: 'formflow-telegram-list',
    listitem: 'formflow-telegram-list-item',
  },
  text: {
    bold: 'formflow-telegram-bold',
    italic: 'formflow-telegram-italic',
    underline: 'formflow-telegram-underline',
    strikethrough: 'formflow-telegram-strikethrough',
    code: 'formflow-telegram-inline-code',
  },
};

export const replaceSelectedTelegramBlock = (kind: string): void => {
  const selection = $getSelection();
  if (!$isRangeSelection(selection)) return;
  const anchor = selection.anchor.getNode().getTopLevelElementOrThrow();
  const replacement = kind === 'quote' ? $createQuoteNode() : kind === 'codeBlock' ? $createCodeNode() : kind.startsWith('heading') ? $createHeadingNode(kind.replace('heading', 'h') as any) : $createParagraphNode();
  const children = anchor.getChildren();
  // Quotes use Lexical's supported inline-child shape. Defensive flattening
  // prevents a legacy nested paragraph from becoming a paragraph child. Other
  // block kinds cannot retain structural paragraph breaks, so serialize those
  // boundaries as visible newline text rather than silently dropping them.
  const appendBoundary = () => replacement.append(
    replacement instanceof QuoteNode ? new TelegramParagraphBreakNode() : $createTextNode('\n')
  );
  let hasContent = false;
  const appendFlattened = (child: any, structuralBoundary = false): void => {
    if (child instanceof TelegramParagraphBreakNode) {
      appendBoundary();
      hasContent = true;
      return;
    }
    if ($isElementNode(child) && !(child instanceof LinkNode)) {
      if (structuralBoundary && hasContent) appendBoundary();
      child.getChildren().forEach((nested: any, index: number) =>
        appendFlattened(nested, index > 0 && $isElementNode(nested) && !(nested instanceof LinkNode))
      );
      return;
    }
    replacement.append(child);
    hasContent = true;
  };
  children.forEach((child: any, index: number) => appendFlattened(child, index > 0 && $isElementNode(child) && !(child instanceof LinkNode)));
  anchor.replace(replacement);
};

const EditorShell = styled(Box)`
  overflow: hidden;
  border: 1px solid ${({ theme }) => theme.colors.neutral200};
  border-radius: ${({ theme }) => theme.borderRadius};
  background: ${({ theme }) => theme.colors.neutral0};
  transition:
    border-color 0.2s,
    box-shadow 0.2s;

  &:focus-within {
    border-color: ${({ theme }) => theme.colors.primary600};
    box-shadow: ${({ theme }) => theme.colors.primary600} 0 0 0 2px;
  }
`;

const EditorToolbar = styled(Flex)`
  border-bottom: 1px solid ${({ theme }) => theme.colors.neutral200};
  background: ${({ theme }) => theme.colors.neutral100};
`;

const ToolbarSelectBox = styled(Box)`
  min-width: 15rem;
  flex: 1 1 15rem;
`;

const EditorSurface = styled(Box)`
  position: relative;
  min-height: 24rem;
  background: ${({ theme }) => theme.colors.neutral0};
`;

const StyledContentEditable = styled(ContentEditable)`
  min-height: 24rem;
  padding: ${({ theme }) => theme.spaces[4]};
  outline: none;
  color: ${({ theme }) => theme.colors.neutral800};
  font-size: ${({ theme }) => theme.fontSizes[2]};
  line-height: ${({ theme }) => theme.lineHeights[5]};
  overflow-wrap: anywhere;

  .formflow-telegram-paragraph {
    margin: 0 0 ${({ theme }) => theme.spaces[3]};
  }

  .formflow-telegram-heading-one,
  .formflow-telegram-heading-two,
  .formflow-telegram-heading-three {
    margin: 0 0 ${({ theme }) => theme.spaces[3]};
    color: ${({ theme }) => theme.colors.neutral800};
    line-height: ${({ theme }) => theme.lineHeights[3]};
    font-weight: ${({ theme }) => theme.fontWeights.bold};
  }

  .formflow-telegram-heading-one {
    font-size: ${({ theme }) => theme.fontSizes[5]};
  }

  .formflow-telegram-heading-two {
    font-size: ${({ theme }) => theme.fontSizes[4]};
  }

  .formflow-telegram-heading-three {
    font-size: ${({ theme }) => theme.fontSizes[3]};
  }

  .formflow-telegram-quote {
    margin: 0 0 ${({ theme }) => theme.spaces[3]};
    padding: ${({ theme }) => `${theme.spaces[2]} ${theme.spaces[3]}`};
    border-inline-start: 3px solid ${({ theme }) => theme.colors.secondary500};
    border-radius: ${({ theme }) => theme.borderRadius};
    background: ${({ theme }) => theme.colors.neutral100};
    color: ${({ theme }) => theme.colors.neutral700};
  }

  .formflow-telegram-list {
    margin: 0 0 ${({ theme }) => theme.spaces[3]};
    padding-inline-start: ${({ theme }) => theme.spaces[6]};
  }

  ul.formflow-telegram-list {
    list-style-type: disc;
  }

  ol.formflow-telegram-list {
    list-style-type: decimal;
  }

  .formflow-telegram-list-item {
    margin-bottom: ${({ theme }) => theme.spaces[1]};
  }

  .formflow-telegram-link {
    color: ${({ theme }) => theme.colors.primary600};
    text-decoration: underline;
  }

  .formflow-telegram-code-block {
    display: block;
    margin: 0 0 ${({ theme }) => theme.spaces[3]};
    padding: ${({ theme }) => theme.spaces[3]};
    border: 1px solid ${({ theme }) => theme.colors.neutral200};
    border-radius: ${({ theme }) => theme.borderRadius};
    background: ${({ theme }) => theme.colors.neutral100};
    color: ${({ theme }) => theme.colors.neutral800};
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    white-space: pre-wrap;
    overflow-x: auto;
  }

  .formflow-telegram-inline-code {
    padding: 1px ${({ theme }) => theme.spaces[1]};
    border-radius: 3px;
    background: ${({ theme }) => theme.colors.neutral100};
    color: ${({ theme }) => theme.colors.neutral800};
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  }

  .formflow-telegram-variable [data-field-id] {
    display: inline-flex;
    align-items: center;
    padding: 1px ${({ theme }) => theme.spaces[2]};
    border: 1px solid ${({ theme }) => theme.colors.secondary200};
    border-radius: ${({ theme }) => theme.borderRadius};
    background: ${({ theme }) => theme.colors.secondary100};
    color: ${({ theme }) => theme.colors.secondary700};
    font-weight: ${({ theme }) => theme.fontWeights.semiBold};
    white-space: nowrap;
  }

  hr {
    margin: ${({ theme }) => `${theme.spaces[4]} 0`};
    border: 0;
    border-top: 1px solid ${({ theme }) => theme.colors.neutral200};
  }
`;

const EditorPlaceholder = styled.span`
  position: absolute;
  top: ${({ theme }) => theme.spaces[4]};
  left: ${({ theme }) => theme.spaces[4]};
  color: ${({ theme }) => theme.colors.neutral500};
  font-size: ${({ theme }) => theme.fontSizes[2]};
  pointer-events: none;
`;

const EditorCommands = ({ fields }: { fields: readonly TelegramTemplateField[] }) => {
  const { formatMessage } = useIntl();
  const t = (key: string, fallback: string) => formatMessage({ id: getTranslation(`notifications.telegram.editor.${key}`), defaultMessage: fallback });
  const [editor] = useLexicalComposerContext();
  const block = (kind: string) => {
    editor.update(() => replaceSelectedTelegramBlock(kind));
    editor.focus();
  };
  const insertVariable = (fieldId: string) => {
    editor.update(() => {
      const selection = $getSelection();
      if ($isRangeSelection(selection)) selection.insertNodes([new TelegramVariableNode(fieldId, fields.find((item) => item.id === fieldId)?.label)]);
    });
    editor.focus();
  };
  const preserveSelection = (action: () => void) => (event: PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    action();
    editor.focus();
  };
  const formatButtons = [
    { key: 'bold', fallback: 'Bold', format: 'bold' as const, icon: <Bold /> },
    { key: 'italic', fallback: 'Italic', format: 'italic' as const, icon: <Italic /> },
    { key: 'underline', fallback: 'Underline', format: 'underline' as const, icon: <Underline /> },
    { key: 'strike', fallback: 'Strike', format: 'strikethrough' as const, icon: <StrikeThrough /> },
    { key: 'inlineCode', fallback: 'Inline code', format: 'code' as const, icon: <Code /> },
  ];
  return <EditorToolbar role="toolbar" aria-label={t('toolbar', 'Telegram template formatting')} padding={2} gap={2} wrap="wrap" alignItems="center">
    <ToolbarSelectBox>
      <SingleSelect
        size="S"
        aria-label={t('block', 'Block style')}
        value="paragraph"
        onChange={(value: string | number) => block(String(value))}
        onCloseAutoFocus={(event: Event) => { event.preventDefault(); editor.focus(); }}
      >
        <SingleSelectOption value="paragraph">{t('paragraph', 'Paragraph')}</SingleSelectOption>
        <SingleSelectOption value="heading1">{t('heading1', 'Heading 1')}</SingleSelectOption>
        <SingleSelectOption value="heading2">{t('heading2', 'Heading 2')}</SingleSelectOption>
        <SingleSelectOption value="heading3">{t('heading3', 'Heading 3')}</SingleSelectOption>
        <SingleSelectOption value="quote">{t('quote', 'Quote')}</SingleSelectOption>
        <SingleSelectOption value="codeBlock">{t('codeBlock', 'Code block')}</SingleSelectOption>
      </SingleSelect>
    </ToolbarSelectBox>
    <IconButtonGroup>
      {formatButtons.map(({ key, fallback, format, icon }) => (
        <IconButton key={format} type="button" size="S" variant="ghost" label={t(key, fallback)} onPointerDown={preserveSelection(() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, format))}>
          {icon}
        </IconButton>
      ))}
    </IconButtonGroup>
    <IconButtonGroup>
      <IconButton type="button" size="S" variant="ghost" label={t('link', 'Link')} onPointerDown={preserveSelection(() => {
        const url = window.prompt(t('linkPrompt', 'Link URL'));
        if (url) editor.dispatchCommand(TOGGLE_LINK_COMMAND, url);
      })}><LinkIcon /></IconButton>
      <IconButton type="button" size="S" variant="ghost" label={t('unordered', 'Bulleted list')} onPointerDown={preserveSelection(() => editor.dispatchCommand(INSERT_UNORDERED_LIST_COMMAND, undefined))}><BulletList /></IconButton>
      <IconButton type="button" size="S" variant="ghost" label={t('ordered', 'Numbered list')} onPointerDown={preserveSelection(() => editor.dispatchCommand(INSERT_ORDERED_LIST_COMMAND, undefined))}><NumberList /></IconButton>
      <IconButton type="button" size="S" variant="ghost" label={t('divider', 'Divider')} onPointerDown={preserveSelection(() => editor.update(() => $insertNodeToNearestRoot(new TelegramDividerNode())))}><Minus /></IconButton>
    </IconButtonGroup>
    <IconButtonGroup>
      <IconButton type="button" size="S" variant="ghost" label={t('undo', 'Undo')} onPointerDown={preserveSelection(() => editor.dispatchCommand(UNDO_COMMAND, undefined))}><ArrowsCounterClockwise /></IconButton>
      <IconButton type="button" size="S" variant="ghost" label={t('redo', 'Redo')} onPointerDown={preserveSelection(() => editor.dispatchCommand(REDO_COMMAND, undefined))}><ArrowClockwise /></IconButton>
    </IconButtonGroup>
    <ToolbarSelectBox>
      <SingleSelect
        size="S"
        aria-label={t('variable', 'Insert form variable')}
        value={null}
        placeholder={t('variable', 'Insert variable…')}
        onChange={(value: string | number) => insertVariable(String(value))}
        onCloseAutoFocus={(event: Event) => { event.preventDefault(); editor.focus(); }}
      >
        {fields.map((field) => <SingleSelectOption key={field.id} value={field.id}>{field.label}{field.type === 'password' || field.type === 'hidden' ? ` — ${t('sensitive', 'sensitive')}` : ''}</SingleSelectOption>)}
      </SingleSelect>
    </ToolbarSelectBox>
  </EditorToolbar>;
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
  const config = useMemo(() => ({ namespace: 'FormFlowTelegram', nodes: telegramEditorNodes, onError: (error: Error) => { throw error; }, editorState: () => importTelegramAstIntoLexical(value, fields), theme: telegramEditorTheme }), []);
  return <LexicalComposer initialConfig={config}>
    <EditorShell>
      <ValueSyncPlugin value={value} fields={fields} current={current} />
      <EditorCommands fields={fields} />
      <EditorSurface>
        <RichTextPlugin
          contentEditable={<StyledContentEditable aria-label={formatMessage({ id: getTranslation('notifications.telegram.editor.label'), defaultMessage: 'Telegram notification template' })} />}
          placeholder={<EditorPlaceholder>{formatMessage({ id: getTranslation('notifications.telegram.editor.placeholder'), defaultMessage: 'Write a Telegram notification…' })}</EditorPlaceholder>}
          ErrorBoundary={({ children }) => children}
        />
      </EditorSurface>
      <HistoryPlugin />
      <ListPlugin />
      <LinkPlugin validateUrl={(url) => { try { return ['http:', 'https:', 'mailto:'].includes(new URL(url).protocol); } catch { return false; } }} />
      <OnChangePlugin ignoreSelectionChange onChange={(state, editor, tags) => { if (!tags.has('formflow-external-sync')) state.read(() => { const next = exportLexicalToTelegramAst(); current.current = JSON.stringify(next); onChange(next); }); }} />
    </EditorShell>
  </LexicalComposer>;
};
