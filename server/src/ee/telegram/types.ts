/* SPDX-License-Identifier: LicenseRef-FormFlow-EE — Commercial. See LICENSE-EE. Not covered by MIT. */

/** Opaque stable identifier; bot metadata and names are never relationship keys. */
export type TelegramConnectionId = string & { readonly __telegramConnectionId: unique symbol };

export type TelegramCredentialSource =
  | { type: 'stored'; secretReference: string }
  | { type: 'environment'; variableName: string };

/** Token-bearing input is deliberately separate from safe response models. */
export type TelegramCredentialInput =
  | { type: 'stored'; token: string }
  | { type: 'environment'; variableName: string };

export interface TelegramBotMetadata {
  id: string;
  displayName: string;
  username?: string;
}

export interface TelegramConnection {
  id: TelegramConnectionId;
  name: string;
  tokenSource: TelegramCredentialSource;
  credentialConfigured: boolean;
  bot?: TelegramBotMetadata;
  createdAt: string;
  updatedAt: string;
}

export interface TelegramTextNode {
  type: 'text';
  text: string;
  marks?: Array<'bold' | 'italic' | 'underline' | 'strikethrough' | 'code'>;
}

export interface TelegramFormFieldNode {
  type: 'formField';
  fieldId: string;
  fallback: '-';
}

export interface TelegramLinkNode {
  type: 'link';
  url: string;
  children: Array<TelegramTextNode | TelegramFormFieldNode>;
}

export interface TelegramParagraphNode {
  type: 'paragraph';
  children: Array<TelegramTextNode | TelegramFormFieldNode | TelegramLinkNode>;
}

export interface TelegramHeadingNode {
  type: 'heading';
  level: 1 | 2 | 3;
  children: Array<TelegramTextNode | TelegramFormFieldNode | TelegramLinkNode>;
}

export interface TelegramBlockquoteNode {
  type: 'blockquote';
  children: TelegramParagraphNode[];
}

export type TelegramTemplateNode =
  | TelegramParagraphNode
  | TelegramHeadingNode
  | TelegramBlockquoteNode;

export interface TelegramTemplateDocument {
  version: 1;
  document: {
    type: 'document';
    children: TelegramTemplateNode[];
  };
}

export interface TelegramNotificationSettings {
  enabled: boolean;
  connectionId: TelegramConnectionId;
  destination: string;
  template: TelegramTemplateDocument;
}

export type TelegramFailure =
  | 'configuration'
  | 'authentication'
  | 'destination'
  | 'permission'
  | 'template'
  | 'rate_limit'
  | 'telegram_server'
  | 'network'
  | 'timeout'
  | 'unknown';
