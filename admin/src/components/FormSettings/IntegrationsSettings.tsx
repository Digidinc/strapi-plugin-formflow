import {
  Box,
  Flex,
  Typography,
  Button,
  Field,
  TextInput,
  Toggle,
  SingleSelect,
  SingleSelectOption,
  IconButton,
} from '@strapi/design-system';
import { Plus, Trash } from '@strapi/icons';
import { useIntl } from 'react-intl';

import { getTranslation } from '../../utils/getTranslation';
import { IntegrationConfig } from '../../utils/api';
import { useLicense } from '../../ee/hooks/useLicense';
import { premiumMutationPolicy } from '../../ee/license-state';
import { LicenseStatusNotice } from '../../ee/components/LicenseStatusNotice';
import { UpsellCard } from '../../ee/components/UpsellCard';

export interface IntegrationsSettingsProps {
  integrations: IntegrationConfig[];
  onChange: (integrations: IntegrationConfig[]) => void;
}

/**
 * The seven supported integration types, in the order they appear in the type
 * selector. Each carries the i18n key for its human label.
 */
const INTEGRATION_TYPES: Array<{
  value: IntegrationConfig['type'];
  labelKey: string;
  defaultLabel: string;
}> = [
  { value: 'slack', labelKey: 'integrations.type.slack', defaultLabel: 'Slack' },
  {
    value: 'google_sheets',
    labelKey: 'integrations.type.google_sheets',
    defaultLabel: 'Google Sheets',
  },
  { value: 'mailchimp', labelKey: 'integrations.type.mailchimp', defaultLabel: 'Mailchimp' },
  { value: 'hubspot', labelKey: 'integrations.type.hubspot', defaultLabel: 'HubSpot' },
  { value: 'notion', labelKey: 'integrations.type.notion', defaultLabel: 'Notion' },
  { value: 'zapier', labelKey: 'integrations.type.zapier', defaultLabel: 'Zapier' },
  { value: 'make', labelKey: 'integrations.type.make', defaultLabel: 'Make (Integromat)' },
];

/**
 * Build a fresh config of the given type with empty required fields. Switching
 * a configured integration to a new type resets its fields (the shapes are
 * disjoint), so we always start from a clean default for that type.
 */
const createDefaultConfig = (type: IntegrationConfig['type']): IntegrationConfig => {
  switch (type) {
    case 'slack':
      return { type: 'slack', enabled: true, webhookUrl: '' };
    case 'google_sheets':
      return { type: 'google_sheets', enabled: true, deploymentId: '' };
    case 'mailchimp':
      return {
        type: 'mailchimp',
        enabled: true,
        apiKey: '',
        serverPrefix: '',
        listId: '',
        emailField: '',
      };
    case 'hubspot':
      return { type: 'hubspot', enabled: true, portalId: '', formGuid: '' };
    case 'notion':
      return { type: 'notion', enabled: true, integrationToken: '', databaseId: '' };
    case 'zapier':
      return { type: 'zapier', enabled: true, webhookUrl: '' };
    case 'make':
      return { type: 'make', enabled: true, webhookUrl: '' };
    default:
      return { type: 'slack', enabled: true, webhookUrl: '' };
  }
};

/**
 * IntegrationsSettings — configure pre-built integrations (Pro).
 *
 * Config-only: no OAuth, no test-send, no client-side HTTP. The actual dispatch
 * happens server-side on `submission.created`. Resolved unentitled access
 * replaces the editor with an UpsellCard, while unknown access shows neutral
 * license status. The `integrations` array is never stripped from the parent
 * settings (the server EXEC gate is the authoritative enforcement point).
 */
export const IntegrationsSettings = ({ integrations, onChange }: IntegrationsSettingsProps) => {
  const { formatMessage } = useIntl();
  const { access } = useLicense();
  const integrationsAccess = access('integrations');
  const integrationsPolicy = premiumMutationPolicy(integrationsAccess);

  const updateIntegration = (index: number, next: IntegrationConfig) => {
    const updated = [...integrations];
    updated[index] = next;
    onChange(updated);
  };

  /**
   * Patch one field on the integration at `index`. Each `renderFields` branch
   * has already narrowed the config to a concrete union member, so the caller
   * passes a key that is valid for that member; the patch is merged onto the
   * existing config. (`keyof IntegrationConfig` alone would only expose the
   * shared `type`/`enabled` keys, so the patch is typed as a loose record.)
   */
  const updateField = (index: number, key: string, value: unknown) => {
    updateIntegration(index, { ...integrations[index], [key]: value } as IntegrationConfig);
  };

  const changeType = (index: number, type: IntegrationConfig['type']) => {
    if (type === integrations[index].type) return;
    updateIntegration(index, createDefaultConfig(type));
  };

  const addIntegration = () => {
    onChange([...integrations, createDefaultConfig('slack')]);
  };

  const removeIntegration = (index: number) => {
    if (!integrationsPolicy.canRemove) return;
    const updated = [...integrations];
    updated.splice(index, 1);
    onChange(updated);
  };

  /**
   * Render the type-specific config fields for a single integration.
   */
  const renderFields = (config: IntegrationConfig, index: number, disabled = false) => {
    const textField = (
      key: string,
      labelKey: string,
      defaultLabel: string,
      value: string,
      onValueChange: (value: string) => void
    ) => (
      <Field.Root name={`integration-${index}-${key}`}>
        <Field.Label>
          {formatMessage({ id: getTranslation(labelKey), defaultMessage: defaultLabel })}
        </Field.Label>
        <TextInput
          value={value}
          readOnly={disabled}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => onValueChange(e.target.value)}
        />
      </Field.Root>
    );

    switch (config.type) {
      case 'slack':
        return (
          <Flex direction="column" gap={4} alignItems="stretch">
            {textField(
              'webhookUrl',
              'integrations.field.webhookUrl',
              'Webhook URL',
              config.webhookUrl,
              (v) => updateField(index, 'webhookUrl', v)
            )}
            <Field.Root name={`integration-${index}-includeData`}>
              <Field.Label>
                {formatMessage({
                  id: getTranslation('integrations.field.includeData'),
                  defaultMessage: 'Include submission data',
                })}
              </Field.Label>
              <Toggle
                onLabel="On"
                offLabel="Off"
                checked={config.includeData ?? false}
                disabled={disabled}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                  updateField(index, 'includeData', e.target.checked)
                }
              />
            </Field.Root>
          </Flex>
        );
      case 'google_sheets':
        return (
          <Flex direction="column" gap={4} alignItems="stretch">
            {textField(
              'deploymentId',
              'integrations.field.deploymentId',
              'Apps Script Deployment ID',
              config.deploymentId,
              (v) => updateField(index, 'deploymentId', v)
            )}
            {textField(
              'sheetId',
              'integrations.field.sheetId',
              'Sheet ID (optional)',
              config.sheetId ?? '',
              (v) => updateField(index, 'sheetId', v || undefined)
            )}
          </Flex>
        );
      case 'mailchimp':
        return (
          <Flex direction="column" gap={4} alignItems="stretch">
            {textField('apiKey', 'integrations.field.apiKey', 'API Key', config.apiKey, (v) =>
              updateField(index, 'apiKey', v)
            )}
            {textField(
              'serverPrefix',
              'integrations.field.serverPrefix',
              'Server Prefix (e.g. us1)',
              config.serverPrefix,
              (v) => updateField(index, 'serverPrefix', v)
            )}
            {textField(
              'listId',
              'integrations.field.listId',
              'Audience/List ID',
              config.listId,
              (v) => updateField(index, 'listId', v)
            )}
            {textField(
              'emailField',
              'integrations.field.emailField',
              'Email field name',
              config.emailField,
              (v) => updateField(index, 'emailField', v)
            )}
          </Flex>
        );
      case 'hubspot':
        return (
          <Flex direction="column" gap={4} alignItems="stretch">
            {textField(
              'portalId',
              'integrations.field.portalId',
              'Portal ID',
              config.portalId,
              (v) => updateField(index, 'portalId', v)
            )}
            {textField(
              'formGuid',
              'integrations.field.formGuid',
              'Form GUID',
              config.formGuid,
              (v) => updateField(index, 'formGuid', v)
            )}
          </Flex>
        );
      case 'notion':
        return (
          <Flex direction="column" gap={4} alignItems="stretch">
            {textField(
              'integrationToken',
              'integrations.field.integrationToken',
              'Integration Token',
              config.integrationToken,
              (v) => updateField(index, 'integrationToken', v)
            )}
            {textField(
              'databaseId',
              'integrations.field.databaseId',
              'Database ID',
              config.databaseId,
              (v) => updateField(index, 'databaseId', v)
            )}
          </Flex>
        );
      case 'zapier':
      case 'make':
        return (
          <Flex direction="column" gap={4} alignItems="stretch">
            {textField(
              'webhookUrl',
              'integrations.field.webhookUrl',
              'Webhook URL',
              config.webhookUrl,
              (v) => updateField(index, 'webhookUrl', v)
            )}
          </Flex>
        );
      default:
        return null;
    }
  };

  // --- Header (shown in every access state) -----------------------------
  const renderHeader = (showAdd: boolean) => (
    <Flex justifyContent="space-between" alignItems="center">
      <Box>
        <Typography variant="delta" fontWeight="bold">
          {formatMessage({
            id: getTranslation('integrations.title'),
            defaultMessage: 'Integrations',
          })}
        </Typography>
        <Box>
          <Typography variant="pi" textColor="neutral600">
            {formatMessage({
              id: getTranslation('integrations.subtitle'),
              defaultMessage: 'Connect form submissions to external services',
            })}
          </Typography>
        </Box>
      </Box>
      {showAdd && (
        <Button size="S" startIcon={<Plus />} onClick={addIntegration}>
          {formatMessage({
            id: getTranslation('integrations.add'),
            defaultMessage: 'Add Integration',
          })}
        </Button>
      )}
    </Flex>
  );

  const renderIntegrationList = (disabled: boolean, canRemove: boolean) =>
    integrations.length === 0 ? (
      <Box padding={6} background="neutral100" hasRadius>
        <Flex justifyContent="center">
          <Typography textColor="neutral600">
            {formatMessage({
              id: getTranslation('integrations.empty'),
              defaultMessage: 'No integrations configured',
            })}
          </Typography>
        </Flex>
      </Box>
    ) : (
      <Flex direction="column" gap={4} alignItems="stretch">
        {integrations.map((config, index) => (
          <Box
            key={`${config.type}-${index}`}
            padding={4}
            background="neutral0"
            hasRadius
            shadow="tableShadow"
            borderColor="neutral200"
            borderStyle="solid"
            borderWidth="1px"
          >
            <Flex justifyContent="space-between" alignItems="flex-start" marginBottom={4} gap={4}>
              <Box flex="1">
                <Field.Root name={`integration-${index}-type`}>
                  <Field.Label>
                    {formatMessage({
                      id: getTranslation('integrations.type.label'),
                      defaultMessage: 'Integration type',
                    })}
                  </Field.Label>
                  <SingleSelect
                    value={config.type}
                    disabled={disabled}
                    onChange={(value: string | number) =>
                      changeType(index, value as IntegrationConfig['type'])
                    }
                  >
                    {INTEGRATION_TYPES.map((type) => (
                      <SingleSelectOption key={type.value} value={type.value}>
                        {formatMessage({
                          id: getTranslation(type.labelKey),
                          defaultMessage: type.defaultLabel,
                        })}
                      </SingleSelectOption>
                    ))}
                  </SingleSelect>
                </Field.Root>
              </Box>
              <Box width="10rem">
                <Field.Root name={`integration-${index}-enabled`}>
                  <Field.Label>
                    {formatMessage({
                      id: getTranslation('integrations.field.enabled'),
                      defaultMessage: 'Enabled',
                    })}
                  </Field.Label>
                  <Toggle
                    onLabel="On"
                    offLabel="Off"
                    checked={config.enabled}
                    disabled={disabled}
                    onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
                      updateField(index, 'enabled', event.target.checked)
                    }
                  />
                </Field.Root>
              </Box>
              <IconButton
                label={formatMessage({
                  id: getTranslation('integrations.remove'),
                  defaultMessage: 'Remove',
                })}
                onClick={() => removeIntegration(index)}
                disabled={!canRemove}
                variant="ghost"
                withTooltip={false}
              >
                <Trash />
              </IconButton>
            </Flex>

            {renderFields(config, index, disabled)}
          </Box>
        ))}
      </Flex>
    );

  switch (integrationsAccess) {
    case 'checking':
      return (
        <Flex direction="column" gap={4} alignItems="stretch">
          {renderHeader(false)}
          <LicenseStatusNotice compact />
          {integrations.length > 0 ? renderIntegrationList(true, false) : null}
        </Flex>
      );
    case 'unavailable':
      return (
        <Flex direction="column" gap={4} alignItems="stretch">
          {renderHeader(false)}
          <LicenseStatusNotice compact />
          {integrations.length > 0 ? renderIntegrationList(true, false) : null}
        </Flex>
      );
    case 'unentitled':
      return (
        <Flex direction="column" gap={4} alignItems="stretch">
          {renderHeader(false)}
          <UpsellCard
            access={integrationsAccess}
            feature="integrations"
            description={formatMessage({
              id: getTranslation('integrations.upsell.description'),
              defaultMessage:
                'Connect submissions to Slack, Google Sheets, Mailchimp, HubSpot, Notion, Zapier, and Make with a Pro license.',
            })}
          />
          {integrations.length > 0
            ? renderIntegrationList(true, integrationsPolicy.canRemove)
            : null}
        </Flex>
      );
    case 'entitled':
      break;
  }

  // --- Entitled: editable list ------------------------------------------
  return (
    <Flex direction="column" gap={4} alignItems="stretch">
      {renderHeader(true)}
      {renderIntegrationList(false, integrationsPolicy.canRemove)}
    </Flex>
  );
};

export default IntegrationsSettings;
