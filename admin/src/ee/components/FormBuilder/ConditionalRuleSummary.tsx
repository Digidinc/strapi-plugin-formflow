/* SPDX-License-Identifier: LicenseRef-FormFlow-EE — Commercial. See LICENSE-EE. Not covered by MIT. */

import { Box, Flex, Typography } from '@strapi/design-system';
import { useIntl } from 'react-intl';

import { getTranslation } from '../../../utils/getTranslation';
import type { ConditionalRule, FormField } from '../../../utils/api';

export interface ConditionalRuleSummaryProps {
  targetField: Pick<FormField, 'label' | 'name'>;
  sourceField?: Pick<FormField, 'label' | 'name'>;
  rule: ConditionalRule;
  dangling: boolean;
  lockCopy?: string;
}

export const ConditionalRuleSummary = ({
  targetField,
  sourceField,
  rule,
  dangling,
  lockCopy,
}: ConditionalRuleSummaryProps) => {
  const { formatMessage } = useIntl();
  const target = targetField.label || targetField.name;
  const source = sourceField?.label || sourceField?.name || rule.field;
  const valueless = rule.operator === 'is_empty' || rule.operator === 'is_not_empty';
  const value =
    typeof rule.value === 'string'
      ? rule.value
      : rule.value === null || rule.value === undefined
        ? ''
        : String(rule.value);

  const summary = valueless
    ? formatMessage(
        {
          id: getTranslation('fieldEditor.conditional.summaryValueless'),
          defaultMessage:
            'Show “{target}” when “{source}” {operator, select, is_empty {is empty} is_not_empty {is not empty} other {matches}}.',
        },
        { target, source, operator: rule.operator }
      )
    : formatMessage(
        {
          id: getTranslation('fieldEditor.conditional.summary'),
          defaultMessage:
            'Show “{target}” when “{source}” {operator, select, equals {equals} not_equals {does not equal} contains {contains} other {matches}} “{value}”.',
        },
        { target, source, operator: rule.operator, value }
      );

  return (
    <Box
      padding={3}
      background="neutral100"
      hasRadius
      borderColor="neutral200"
      borderStyle="solid"
      borderWidth="1px"
    >
      <Flex direction="column" gap={2} alignItems="stretch">
        {dangling ? (
          <Typography variant="pi" textColor="warning700">
            {formatMessage({
              id: getTranslation('fieldEditor.conditional.dangling'),
              defaultMessage: 'This rule references a field that no longer exists.',
            })}
          </Typography>
        ) : null}
        <Typography>{summary}</Typography>
        {lockCopy ? (
          <Typography variant="pi" textColor="neutral600">
            {lockCopy}
          </Typography>
        ) : null}
      </Flex>
    </Box>
  );
};
