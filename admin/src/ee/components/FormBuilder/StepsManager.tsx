/* SPDX-License-Identifier: LicenseRef-FormFlow-EE — Commercial. See LICENSE-EE. Not covered by MIT. */
import * as React from 'react';
import { useCallback } from 'react';
import { Box, Flex, Typography, IconButton, Field, TextInput } from '@strapi/design-system';
import { Plus, Trash } from '@strapi/icons';
import { useIntl } from 'react-intl';
import { v4 as uuidv4 } from 'uuid';

import { getTranslation } from '../../../utils/getTranslation';
import { GatedButton } from '../GatedButton';
import { LicenseStatusNotice } from '../LicenseStatusNotice';
import { ProBadge } from '../ProBadge';
import type { FeatureAccess } from '../../license-state';
import type { FormStep, FormSettings } from '../../../utils/api';

export interface StepsManagerProps {
  steps: FormStep[];
  settings: Partial<FormSettings>;
  onSettingsChange: (settings: Partial<FormSettings>) => void;
  /** State-aware multi-step access; every mutation control is disabled unless entitled. */
  access: FeatureAccess;
}

/**
 * Multi-step (wizard) steps manager. Owns add/rename/remove of `settings.steps`;
 * the per-field step-assignment dropdown lives in FormBuilder. Existing steps
 * stay visible while access is unresolved or locked, but all mutations receive
 * real disabled state. A confirmed lock explains itself in the header; an
 * unresolved check says nothing, since it settles on its own.
 */
export const StepsManager = ({ steps, settings, onSettingsChange, access }: StepsManagerProps) => {
  const { formatMessage } = useIntl();
  const disabled = access !== 'entitled';

  const handleAddStep = useCallback(() => {
    const newStep: FormStep = {
      id: uuidv4(),
      title: `Step ${steps.length + 1}`,
      fields: [],
    };
    onSettingsChange({ ...settings, steps: [...steps, newStep] });
  }, [steps, settings, onSettingsChange]);

  const handleRenameStep = useCallback(
    (stepId: string, title: string) => {
      onSettingsChange({
        ...settings,
        steps: steps.map((s) => (s.id === stepId ? { ...s, title } : s)),
      });
    },
    [steps, settings, onSettingsChange]
  );

  const handleRemoveStep = useCallback(
    (stepId: string) => {
      onSettingsChange({ ...settings, steps: steps.filter((s) => s.id !== stepId) });
    },
    [steps, settings, onSettingsChange]
  );

  return (
    <Box background="neutral0" hasRadius shadow="tableShadow" padding={5} marginBottom={5}>
      <Flex justifyContent="space-between" alignItems="center" marginBottom={4}>
        <Flex gap={2} alignItems="center">
          <Typography variant="delta" fontWeight="bold">
            {formatMessage({
              id: getTranslation('builder.steps.title'),
              defaultMessage: 'Steps',
            })}
          </Typography>
          {access === 'unentitled' ? <ProBadge feature="multistep" /> : null}
        </Flex>
        <GatedButton
          access={access}
          feature="multistep"
          size="S"
          variant="secondary"
          startIcon={<Plus />}
          onClick={handleAddStep}
        >
          {formatMessage({
            id: getTranslation('builder.steps.add'),
            defaultMessage: 'Add Step',
          })}
        </GatedButton>
      </Flex>

      {/* `checking` stays silent — the controls above are already disabled and
          the check settles on its own, so narrating it only adds noise. */}
      {access === 'unavailable' ? (
        <Box marginBottom={4}>
          <LicenseStatusNotice compact />
        </Box>
      ) : access === 'unentitled' ? (
        <Box marginBottom={4}>
          <Typography variant="pi" textColor="neutral600">
            {formatMessage({
              id: getTranslation('builder.steps.requiresPro'),
              defaultMessage:
                'Multi-step editing requires a Pro plan. Existing steps remain read-only.',
            })}
          </Typography>
        </Box>
      ) : null}

      {steps.length === 0 ? (
        <Box padding={4} background="neutral100" hasRadius textAlign="center">
          <Typography variant="pi" textColor="neutral600">
            {formatMessage({
              id: getTranslation('builder.steps.empty'),
              defaultMessage: 'No steps yet. Add a step to group your fields.',
            })}
          </Typography>
        </Box>
      ) : (
        <Flex direction="column" gap={3} alignItems="stretch">
          {steps.map((step, index) => (
            <Flex key={step.id} gap={2} alignItems="flex-end">
              <Box flex="1">
                <Field.Root name={`step-${step.id}`}>
                  <Field.Label>
                    {formatMessage(
                      {
                        id: getTranslation('builder.steps.stepLabel'),
                        defaultMessage: 'Step {number}',
                      },
                      { number: index + 1 }
                    )}
                  </Field.Label>
                  <TextInput
                    value={step.title}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                      handleRenameStep(step.id, e.target.value)
                    }
                    placeholder="Step title"
                    disabled={disabled}
                  />
                </Field.Root>
              </Box>
              <Box>
                <IconButton
                  label={formatMessage({
                    id: getTranslation('builder.steps.remove'),
                    defaultMessage: 'Remove step',
                  })}
                  variant="ghost"
                  onClick={() => handleRemoveStep(step.id)}
                  disabled={disabled}
                  withTooltip={false}
                >
                  <Trash />
                </IconButton>
              </Box>
            </Flex>
          ))}
        </Flex>
      )}
    </Box>
  );
};
