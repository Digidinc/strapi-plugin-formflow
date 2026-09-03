import { useCallback } from 'react';
import {
  Box,
  Button,
  Flex,
  Typography,
  Field,
  TextInput,
  Textarea,
  Checkbox,
  SingleSelect,
  SingleSelectOption,
  Divider,
  Grid,
} from '@strapi/design-system';
import { useIntl } from 'react-intl';
import styled from 'styled-components';

import { getTranslation } from '../../utils/getTranslation';
import type {
  FormSettings as FormSettingsType,
  SpamSettings as SpamSettingsType,
  RateLimitConfig,
} from '../../utils/api';
import { SpamSettings } from './SpamSettings';
import { RateLimitSettings } from './RateLimitSettings';
import { useLicense } from '../../ee/hooks/useLicense';
import { premiumMutationPolicy } from '../../ee/license-state';
import { LockedSection } from '../../ee/components/LockedSection';
import { ProBadge } from '../../ee/components/ProBadge';

export interface FormSettingsProps {
  settings: Partial<FormSettingsType>;
  successMessage: string;
  redirectUrl: string;
  showResetButton: boolean;
  /**
   * Top-level `Form.requiresApproval` (NOT a `settings` key) — threaded
   * explicitly so it round-trips through the form save path.
   */
  requiresApproval: boolean;
  onSettingsChange: (settings: Partial<FormSettingsType>) => void;
  onSuccessMessageChange: (value: string) => void;
  onRedirectUrlChange: (value: string) => void;
  onShowResetButtonChange: (value: boolean) => void;
  onRequiresApprovalChange: (value: boolean) => void;
}

/**
 * Default spam protection settings
 */
const getDefaultSpamSettings = (): SpamSettingsType => ({
  honeypot: true,
  honeypotFieldName: '_gotcha',
});

/**
 * Monospace textarea for the Custom CSS editor so authored CSS is legible.
 */
const MonospaceTextarea = styled(Textarea)`
  font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
  min-height: 12rem;
`;

/**
 * A titled settings section rendered inside a native card container. An optional
 * `badge` (e.g. a <ProBadge>) is rendered next to the title.
 */
const SettingsSection = ({
  title,
  badge,
  children,
}: {
  title: string;
  badge?: React.ReactNode;
  children: React.ReactNode;
}) => (
  <Box>
    <Flex marginBottom={4} gap={2} alignItems="center">
      <Typography variant="delta" fontWeight="bold">
        {title}
      </Typography>
      {badge}
    </Flex>
    {children}
  </Box>
);

/**
 * FormSettings component for configuring form-level settings.
 * Includes submission settings, button configuration, form layout,
 * spam protection (honeypot + reCAPTCHA) and rate limiting.
 */
export const FormSettings = ({
  settings,
  successMessage,
  redirectUrl,
  showResetButton,
  requiresApproval,
  onSettingsChange,
  onSuccessMessageChange,
  onRedirectUrlChange,
  onShowResetButtonChange,
  onRequiresApprovalChange,
}: FormSettingsProps) => {
  const { formatMessage } = useIntl();
  const { access } = useLicense();
  const multistepAccess = access('multistep');
  const whiteLabelAccess = access('whiteLabel');
  const approvalAccess = access('approval');
  const multistepPolicy = premiumMutationPolicy(multistepAccess);
  const whiteLabelPolicy = premiumMutationPolicy(whiteLabelAccess);
  const approvalPolicy = premiumMutationPolicy(approvalAccess);
  const currentLayout = settings.layout || 'single';
  const unavailableMessage = formatMessage({
    id: getTranslation('license.unavailable'),
    defaultMessage:
      'FormFlow could not verify the current license. Premium controls are temporarily unavailable. Free features remain available.',
  });

  // Update a single setting property
  const updateSetting = useCallback(
    <K extends keyof FormSettingsType>(key: K, value: FormSettingsType[K]) => {
      onSettingsChange({ ...settings, [key]: value });
    },
    [settings, onSettingsChange]
  );

  const handleRequiresApprovalChange = (checked: boolean | 'indeterminate') => {
    const nextRequiresApproval = checked === true;
    const allowed = nextRequiresApproval ? approvalPolicy.canEdit : approvalPolicy.canRemove;
    if (!allowed) return;
    onRequiresApprovalChange(nextRequiresApproval);
  };

  const handleLayoutChange = (value: string | number) => {
    const nextLayout = value as 'single' | 'multi-step';
    if (nextLayout === 'multi-step' && !multistepPolicy.canEdit) return;
    if (currentLayout === 'multi-step' && nextLayout === 'single' && !multistepPolicy.canRemove) {
      return;
    }
    updateSetting('layout', nextLayout);
  };

  const handleRemoveCustomCss = () => {
    if (!whiteLabelPolicy.canRemove) return;
    updateSetting('customCss', '');
  };

  // Update spam protection settings
  const handleSpamChange = useCallback(
    (spam: SpamSettingsType) => {
      onSettingsChange({ ...settings, spam });
    },
    [settings, onSettingsChange]
  );

  // Update rate-limit settings
  const handleRateLimitChange = useCallback(
    (rateLimit: RateLimitConfig) => {
      onSettingsChange({ ...settings, rateLimit });
    },
    [settings, onSettingsChange]
  );

  const spamSettings = settings.spam || getDefaultSpamSettings();

  return (
    <Box padding={6} background="neutral0" hasRadius shadow="tableShadow" borderColor="neutral150">
      <Flex direction="column" gap={6} alignItems="stretch">
        {/* Submission Settings Section */}
        <SettingsSection
          title={formatMessage({
            id: getTranslation('settings.general.title'),
            defaultMessage: 'Submission Settings',
          })}
        >
          <Flex direction="column" gap={4} alignItems="stretch">
            {/* Success Message */}
            <Field.Root
              name="successMessage"
              hint={formatMessage({
                id: getTranslation('settings.successMessage.hint'),
                defaultMessage: 'Shown to the user after a successful submission',
              })}
            >
              <Field.Label>
                {formatMessage({
                  id: getTranslation('settings.successMessage.label'),
                  defaultMessage: 'Success Message',
                })}
              </Field.Label>
              <Textarea
                placeholder={formatMessage({
                  id: getTranslation('settings.successMessage.placeholder'),
                  defaultMessage: 'Thank you for your submission!',
                })}
                value={successMessage}
                onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) =>
                  onSuccessMessageChange(e.target.value)
                }
              />
              <Field.Hint />
            </Field.Root>

            {/* Redirect URL */}
            <Field.Root
              name="redirectUrl"
              hint={formatMessage({
                id: getTranslation('settings.redirectUrl.hint'),
                defaultMessage: 'Redirect the user to this URL after submission',
              })}
            >
              <Field.Label>
                {formatMessage({
                  id: getTranslation('settings.redirectUrl.label'),
                  defaultMessage: 'Redirect URL (Optional)',
                })}
              </Field.Label>
              <TextInput
                placeholder={formatMessage({
                  id: getTranslation('settings.redirectUrl.placeholder'),
                  defaultMessage: 'https://example.com/thank-you',
                })}
                value={redirectUrl}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                  onRedirectUrlChange(e.target.value)
                }
              />
              <Field.Hint />
            </Field.Root>

            {/* Approval workflow (Business). `requiresApproval` is a top-level
                Form field, not a settings key — toggled via its own handler. */}
            <Field.Root
              name="requiresApproval"
              hint={
                approvalAccess === 'unavailable'
                    ? unavailableMessage
                    : formatMessage({
                        id: getTranslation('settings.requiresApproval.hint'),
                        defaultMessage:
                          'Hold new submissions for manual approval before they count as processed.',
                      })
              }
            >
              <Flex gap={2} alignItems="center">
                <Checkbox
                  checked={requiresApproval}
                  disabled={requiresApproval ? !approvalPolicy.canRemove : !approvalPolicy.canEdit}
                  onCheckedChange={handleRequiresApprovalChange}
                >
                  {formatMessage({
                    id: getTranslation('settings.requiresApproval.label'),
                    defaultMessage: 'Require approval for new submissions',
                  })}
                </Checkbox>
                {approvalAccess === 'unentitled' && <ProBadge tier="business" />}
              </Flex>
              <Field.Hint />
            </Field.Root>
          </Flex>
        </SettingsSection>

        <Divider />

        {/* Button Settings Section */}
        <SettingsSection
          title={formatMessage({
            id: getTranslation('settings.buttons.title'),
            defaultMessage: 'Button Settings',
          })}
        >
          <Flex direction="column" gap={4} alignItems="stretch">
            <Grid.Root gap={6} gridCols={12}>
              {/* Submit Button Text */}
              <Grid.Item col={6} xs={12} direction="column" alignItems="stretch">
                <Field.Root name="submitButtonText">
                  <Field.Label>
                    {formatMessage({
                      id: getTranslation('settings.submitButton.label'),
                      defaultMessage: 'Submit Button Text',
                    })}
                  </Field.Label>
                  <TextInput
                    placeholder={formatMessage({
                      id: getTranslation('settings.submitButton.placeholder'),
                      defaultMessage: 'Submit',
                    })}
                    value={settings.submitButtonText || 'Submit'}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                      updateSetting('submitButtonText', e.target.value)
                    }
                  />
                </Field.Root>
              </Grid.Item>

              {/* Reset Button Text - Only shown when reset button is enabled */}
              {showResetButton && (
                <Grid.Item col={6} xs={12} direction="column" alignItems="stretch">
                  <Field.Root name="resetButtonText">
                    <Field.Label>
                      {formatMessage({
                        id: getTranslation('settings.resetButton.label'),
                        defaultMessage: 'Reset Button Text',
                      })}
                    </Field.Label>
                    <TextInput
                      placeholder={formatMessage({
                        id: getTranslation('settings.resetButton.placeholder'),
                        defaultMessage: 'Reset',
                      })}
                      value={settings.resetButtonText || 'Reset'}
                      onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                        updateSetting('resetButtonText', e.target.value)
                      }
                    />
                  </Field.Root>
                </Grid.Item>
              )}
            </Grid.Root>

            {/* Show Reset Button Checkbox */}
            <Checkbox checked={showResetButton} onCheckedChange={onShowResetButtonChange}>
              {formatMessage({
                id: getTranslation('settings.showResetButton.label'),
                defaultMessage: 'Show reset button alongside submit button',
              })}
            </Checkbox>
          </Flex>
        </SettingsSection>

        <Divider />

        {/* Form Layout Section */}
        <SettingsSection
          title={formatMessage({
            id: getTranslation('settings.layout.title'),
            defaultMessage: 'Form Layout',
          })}
        >
          <Box maxWidth="40rem">
            <Field.Root
              name="layout"
              hint={
                multistepAccess === 'unavailable'
                    ? unavailableMessage
                    : multistepAccess === 'unentitled'
                      ? formatMessage(
                          {
                            id: getTranslation('license.upgradeRequired'),
                            defaultMessage: 'This feature requires a {tier} plan.',
                          },
                          { tier: 'Pro' }
                        )
                      : settings.layout === 'multi-step'
                        ? formatMessage({
                            id: getTranslation('settings.layout.multiStep.hint'),
                            defaultMessage: 'Configure steps in the Form Builder tab',
                          })
                        : formatMessage({
                            id: getTranslation('settings.layout.single.hint'),
                            defaultMessage: 'All fields displayed on a single page',
                          })
              }
            >
              <Field.Label>
                {formatMessage({
                  id: getTranslation('settings.layout.label'),
                  defaultMessage: 'Layout',
                })}
              </Field.Label>
              <SingleSelect
                value={currentLayout}
                disabled={currentLayout === 'multi-step' && !multistepPolicy.canRemove}
                onChange={handleLayoutChange}
              >
                <SingleSelectOption value="single">
                  {formatMessage({
                    id: getTranslation('settings.layout.single'),
                    defaultMessage: 'Single page',
                  })}
                </SingleSelectOption>
                <SingleSelectOption value="multi-step" disabled={multistepAccess !== 'entitled'}>
                  {formatMessage({
                    id: getTranslation('settings.layout.multiStep'),
                    defaultMessage: 'Multi-step',
                  })}
                  {multistepAccess === 'unentitled' && (
                    <>
                      {' '}
                      <ProBadge tier="pro" />
                    </>
                  )}
                </SingleSelectOption>
              </SingleSelect>
              <Field.Hint />
            </Field.Root>
          </Box>
        </SettingsSection>

        <Divider />

        {/* Spam Protection Section */}
        <SettingsSection
          title={formatMessage({
            id: getTranslation('settings.spam.title'),
            defaultMessage: 'Spam Protection',
          })}
        >
          <SpamSettings spam={spamSettings} onChange={handleSpamChange} />
        </SettingsSection>

        <Divider />

        {/* Rate Limiting Section */}
        <SettingsSection
          title={formatMessage({
            id: getTranslation('settings.rateLimit.title'),
            defaultMessage: 'Rate Limiting',
          })}
        >
          <RateLimitSettings rateLimit={settings.rateLimit} onChange={handleRateLimitChange} />
        </SettingsSection>

        <Divider />

        {/* Custom CSS Section */}
        <Box>
          <LockedSection access={whiteLabelAccess} feature="whiteLabel" mode="readonly">
            {({ disabled }) => (
              <SettingsSection
                title={formatMessage({
                  id: getTranslation('settings.customCss.title'),
                  defaultMessage: 'Custom CSS',
                })}
                badge={whiteLabelAccess === 'unentitled' ? <ProBadge tier="pro" /> : undefined}
              >
                {whiteLabelAccess === 'unavailable' && (
                  <Box marginBottom={3} role="status">
                    <Typography variant="pi" textColor="neutral600">
                      {unavailableMessage}
                    </Typography>
                  </Box>
                )}
                <Field.Root
                  name="customCss"
                  hint={formatMessage({
                    id: getTranslation('settings.customCss.hint'),
                    defaultMessage:
                      'Exposed in the public form schema and injected by the consuming frontend when rendering this form. Not applied inside the admin panel.',
                  })}
                >
                  <Field.Label>
                    {formatMessage({
                      id: getTranslation('settings.customCss.label'),
                      defaultMessage: 'Custom CSS',
                    })}
                  </Field.Label>
                  <MonospaceTextarea
                    value={settings.customCss || ''}
                    readOnly={disabled}
                    onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) =>
                      updateSetting('customCss', e.target.value)
                    }
                    placeholder={formatMessage({
                      id: getTranslation('settings.customCss.placeholder'),
                      defaultMessage: '.my-form { /* your styles */ }',
                    })}
                  />
                  <Field.Hint />
                </Field.Root>
              </SettingsSection>
            )}
          </LockedSection>
          {Boolean(settings.customCss) && !whiteLabelPolicy.canEdit && (
            <Flex justifyContent="flex-end" marginTop={3}>
              <Button
                type="button"
                variant="danger-light"
                onClick={handleRemoveCustomCss}
                disabled={!whiteLabelPolicy.canRemove}
              >
                {formatMessage({
                  id: getTranslation('settings.customCss.remove'),
                  defaultMessage: 'Remove custom CSS',
                })}
              </Button>
            </Flex>
          )}
        </Box>
      </Flex>
    </Box>
  );
};

export default FormSettings;
