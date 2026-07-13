/* SPDX-License-Identifier: LicenseRef-FormFlow-EE — Commercial. See LICENSE-EE. Not covered by MIT. */
import * as React from 'react';
import {
  Alert,
  Box,
  Checkbox,
  Field,
  Flex,
  Grid,
  LinkButton,
  SingleSelect,
  SingleSelectOption,
  TextInput,
  Typography,
} from '@strapi/design-system';
import { useIntl } from 'react-intl';

import { getTranslation } from '../../../utils/getTranslation';
import type { ConditionalRule, FormField } from '../../../utils/api';
import { type FeatureAccess } from '../../license-state';
import { LicenseStatusNotice } from '../LicenseStatusNotice';
import { ProBadge } from '../ProBadge';
import { PURCHASE_URL } from '../UpsellCard';
import { ConditionalRuleSummary } from './ConditionalRuleSummary';
import { resolveConditionalLogicBody } from './conditional-logic-view';

export interface ConditionalLogicBuilderProps {
  conditional: ConditionalRule | undefined;
  conditionSourceFields: FormField[];
  targetField: FormField;
  onChange: (conditional: ConditionalRule | undefined) => void;
  access: FeatureAccess;
}

const VALUELESS_OPERATORS: ConditionalRule['operator'][] = ['is_empty', 'is_not_empty'];

const CONDITIONAL_OPERATORS: ConditionalRule['operator'][] = [
  'equals',
  'not_equals',
  'contains',
  'is_empty',
  'is_not_empty',
];

export const ConditionalLogicBuilder = ({
  conditional,
  conditionSourceFields,
  targetField,
  onChange,
  access,
}: ConditionalLogicBuilderProps) => {
  const { formatMessage } = useIntl();
  const bodyState = resolveConditionalLogicBody({ access, conditional, conditionSourceFields });
  const sourceField = conditional
    ? conditionSourceFields.find((field) => field.name === conditional.field)
    : undefined;
  const dangling = Boolean(conditional && !sourceField);
  const needsValue = Boolean(conditional && !VALUELESS_OPERATORS.includes(conditional.operator));

  const conditionalTitle = formatMessage({
    id: getTranslation('fieldEditor.conditional.title'),
    defaultMessage: 'Conditional Logic',
  });
  const enableCopy = formatMessage({
    id: getTranslation('fieldEditor.conditional.enable'),
    defaultMessage: 'Show this field conditionally',
  });
  const noFieldsCopy = formatMessage({
    id: getTranslation('fieldEditor.conditional.noFields'),
    defaultMessage: 'Add another input field before configuring a condition.',
  });
  const requiresProCopy = formatMessage({
    id: getTranslation('fieldEditor.conditional.requiresPro'),
    defaultMessage: 'Conditional Logic requires a Pro plan.',
  });
  const readOnlyCopy = formatMessage({
    id: getTranslation('fieldEditor.conditional.readOnly'),
    defaultMessage:
      'This existing rule remains active but is read-only without Conditional Logic entitlement.',
  });
  const danglingCopy = formatMessage({
    id: getTranslation('fieldEditor.conditional.dangling'),
    defaultMessage: 'This rule references a field that no longer exists.',
  });

  const operatorLabel = (operator: ConditionalRule['operator']) =>
    formatMessage({
      id: getTranslation(`fieldEditor.conditional.operator.${operator}`),
      defaultMessage: operator,
    });

  const handleToggle = (enabled: boolean) => {
    if (!enabled) {
      onChange(undefined);
      return;
    }

    const firstField = conditionSourceFields[0];
    if (!firstField) return;

    onChange({
      field: firstField.name,
      operator: 'equals',
      value: '',
    });
  };

  const handleUpdate = (updates: Partial<ConditionalRule>) => {
    if (!conditional) return;
    onChange({ ...conditional, ...updates });
  };

  const disabledToggle = (
    <Checkbox checked={false} disabled>
      {enableCopy}
    </Checkbox>
  );

  const viewPlansLink = (
    <LinkButton
      size="S"
      variant="secondary"
      href={PURCHASE_URL}
      target="_blank"
      rel="noopener noreferrer"
    >
      {formatMessage({
        id: getTranslation('license.viewPlans'),
        defaultMessage: 'View plans',
      })}
    </LinkButton>
  );

  const editor = (
    <Flex direction="column" gap={3} alignItems="stretch">
      <Checkbox
        checked={Boolean(conditional)}
        onCheckedChange={(checked: boolean) => handleToggle(checked)}
      >
        {enableCopy}
      </Checkbox>

      {conditional ? (
        <Box
          padding={3}
          background="neutral100"
          hasRadius
          borderColor="neutral200"
          borderStyle="solid"
          borderWidth="1px"
        >
          <Grid.Root gap={3} gridCols={12}>
            <Grid.Item col={4} xs={12} direction="column" alignItems="stretch">
              <Field.Root name="conditional-field">
                <Field.Label>
                  {formatMessage({
                    id: getTranslation('fieldEditor.conditional.field'),
                    defaultMessage: 'When field',
                  })}
                </Field.Label>
                <SingleSelect
                  value={sourceField ? conditional.field : undefined}
                  onChange={(value: string | number) => handleUpdate({ field: String(value) })}
                >
                  {conditionSourceFields.map((field) => (
                    <SingleSelectOption key={field.id} value={field.name}>
                      {field.label || field.name}
                    </SingleSelectOption>
                  ))}
                </SingleSelect>
              </Field.Root>
            </Grid.Item>

            <Grid.Item col={4} xs={12} direction="column" alignItems="stretch">
              <Field.Root name="conditional-operator">
                <Field.Label>
                  {formatMessage({
                    id: getTranslation('fieldEditor.conditional.operator'),
                    defaultMessage: 'Operator',
                  })}
                </Field.Label>
                <SingleSelect
                  value={conditional.operator}
                  onChange={(value: string | number) => {
                    const operator = value as ConditionalRule['operator'];
                    handleUpdate({
                      operator,
                      ...(VALUELESS_OPERATORS.includes(operator) ? { value: undefined } : {}),
                    });
                  }}
                >
                  {CONDITIONAL_OPERATORS.map((operator) => (
                    <SingleSelectOption key={operator} value={operator}>
                      {operatorLabel(operator)}
                    </SingleSelectOption>
                  ))}
                </SingleSelect>
              </Field.Root>
            </Grid.Item>

            <Grid.Item col={4} xs={12} direction="column" alignItems="stretch">
              <Field.Root name="conditional-value">
                <Field.Label>
                  {formatMessage({
                    id: getTranslation('fieldEditor.conditional.value'),
                    defaultMessage: 'Value',
                  })}
                </Field.Label>
                <TextInput
                  value={
                    typeof conditional.value === 'string'
                      ? conditional.value
                      : String(conditional.value ?? '')
                  }
                  onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
                    handleUpdate({ value: event.target.value })
                  }
                  disabled={!needsValue}
                  placeholder={needsValue ? 'Value' : 'N/A'}
                />
              </Field.Root>
            </Grid.Item>
          </Grid.Root>
        </Box>
      ) : null}
    </Flex>
  );

  const summary = conditional ? (
    <ConditionalRuleSummary
      targetField={targetField}
      sourceField={sourceField}
      rule={conditional}
      dangling={dangling}
    />
  ) : null;

  let body: React.ReactNode;
  switch (bodyState) {
    case 'checking':
      body = (
        <Box padding={3} background="neutral100" hasRadius role="status">
          <Typography variant="pi" textColor="neutral600">
            {formatMessage({
              id: getTranslation('license.checking'),
              defaultMessage: 'Checking FormFlow license…',
            })}
          </Typography>
        </Box>
      );
      break;
    case 'unavailable':
      body = <LicenseStatusNotice compact />;
      break;
    case 'readonly-rule':
      body = (
        <Flex direction="column" gap={3} alignItems="flex-start">
          {conditional ? (
            <ConditionalRuleSummary
              targetField={targetField}
              sourceField={sourceField}
              rule={conditional}
              dangling={dangling}
              lockCopy={readOnlyCopy}
            />
          ) : null}
          {viewPlansLink}
        </Flex>
      );
      break;
    case 'dangling-readonly':
      body = summary;
      break;
    case 'repair-rule':
      body = (
        <Flex direction="column" gap={3} alignItems="stretch">
          <Alert
            closeLabel={formatMessage({
              id: getTranslation('common.close'),
              defaultMessage: 'Close',
            })}
            variant="warning"
          >
            {danglingCopy}
          </Alert>
          {editor}
        </Flex>
      );
      break;
    case 'prerequisite':
      body = (
        <Box padding={3} background="neutral100" hasRadius>
          <Typography variant="pi" textColor="neutral600">
            {noFieldsCopy}
          </Typography>
        </Box>
      );
      break;
    case 'prerequisite-upsell':
      body = (
        <Box padding={3} background="neutral100" hasRadius>
          <Flex direction="column" gap={3} alignItems="flex-start">
            {disabledToggle}
            <Typography variant="pi" textColor="neutral600">
              {noFieldsCopy}
            </Typography>
            <Typography variant="pi">{requiresProCopy}</Typography>
            {viewPlansLink}
          </Flex>
        </Box>
      );
      break;
    case 'upsell':
      body = (
        <Box padding={3} background="neutral100" hasRadius>
          <Flex direction="column" gap={3} alignItems="flex-start">
            {disabledToggle}
            <Typography variant="pi">{requiresProCopy}</Typography>
            {viewPlansLink}
          </Flex>
        </Box>
      );
      break;
    case 'editor':
      body = editor;
      break;
  }

  return (
    <Box>
      <Box marginBottom={3}>
        <Flex gap={2} alignItems="center">
          <Typography variant="sigma" textColor="neutral600" textTransform="uppercase">
            {conditionalTitle}
          </Typography>
          {access !== 'entitled' ? <ProBadge feature="conditionalLogic" /> : null}
        </Flex>
        <Box marginTop={1}>
          <Typography variant="pi" textColor="neutral600">
            {formatMessage({
              id: getTranslation('fieldEditor.conditional.description'),
              defaultMessage: 'Show this field based on another field’s submitted value.',
            })}
          </Typography>
        </Box>
      </Box>

      {body}

      <Box marginTop={3}>
        <Typography variant="pi" textColor="neutral600">
          {formatMessage({
            id: getTranslation('fieldEditor.conditional.previewNotice'),
            defaultMessage:
              'The admin preview shows field appearance only. Conditional visibility runs in the frontend renderer and is enforced again during submission validation.',
          })}
        </Typography>
      </Box>
    </Box>
  );
};
