import * as React from 'react';
import { useMemo, useState } from 'react';
import { Modal, Box, Flex, Grid, Typography, Button, Searchbar } from '@strapi/design-system';
import {
  Pencil,
  Mail,
  Phone,
  Link as LinkIcon,
  Lock,
  ChevronDown,
  Check,
  Calendar,
  Clock,
  File,
  Eye,
  Minus,
  Hashtag,
  ListPlus,
  Paragraph,
} from '@strapi/icons';
import { useIntl } from 'react-intl';
import { useNotification } from '@strapi/strapi/admin';
import styled from 'styled-components';

import { getTranslation } from '../../utils/getTranslation';
import { useLicense } from '../../ee/hooks/useLicense';
import { FieldTypeLockState } from '../../ee/components/FieldTypeLockState';
import { PURCHASE_URL } from '../../ee/components/UpsellCard';
import type { FeatureKey, Tier } from '../../ee/feature-map';
import type { FeatureAccess } from '../../ee/license-state';
import type { FieldType } from '../../utils/api';

export interface FieldTypeSelectorProps {
  isOpen: boolean;
  onClose: () => void;
  onSelect: (type: string) => void;
  fieldTypes: FieldType[];
  isLoading?: boolean;
}

/**
 * Category display order (labels come from i18n)
 */
const CATEGORY_ORDER = ['basic', 'choice', 'datetime', 'advanced', 'layout'] as const;

/**
 * Icon mapping for each field type using available Strapi icons.
 */
const getFieldIcon = (type: string) => {
  const icons: Record<string, React.ReactNode> = {
    text: <Pencil />,
    textarea: <Paragraph />,
    email: <Mail />,
    number: <Hashtag />,
    phone: <Phone />,
    url: <LinkIcon />,
    password: <Lock />,
    select: <ChevronDown />,
    radio: <Check />,
    checkbox: <ListPlus />,
    boolean: <Check />,
    date: <Calendar />,
    time: <Clock />,
    datetime: <Calendar />,
    file: <File />,
    hidden: <Eye />,
    consent: <Check />,
    heading: <Pencil />,
    paragraph: <Paragraph />,
    divider: <Minus />,
  };

  return icons[type] || <Pencil />;
};

/**
 * Interactive field-type tile with real hover / focus styling.
 *
 * Implemented as a styled native <button> wrapping a Box so that hover,
 * focus-visible and active states actually apply (Box/`_hover` from Chakra do
 * not work in design-system v2).
 */
const FieldTypeTile = styled.button`
  display: block;
  width: 100%;
  cursor: pointer;
  text-align: left;
  background: ${({ theme }) => theme.colors.neutral0};
  border: 1px solid ${({ theme }) => theme.colors.neutral200};
  border-radius: ${({ theme }) => theme.borderRadius};
  padding: ${({ theme }) => theme.spaces[4]};
  transition:
    border-color 0.15s ease-in-out,
    background 0.15s ease-in-out,
    box-shadow 0.15s ease-in-out;

  &:hover {
    border-color: ${({ theme }) => theme.colors.primary600};
    background: ${({ theme }) => theme.colors.primary100};
  }

  &:focus-visible {
    outline: none;
    border-color: ${({ theme }) => theme.colors.primary600};
    box-shadow: ${({ theme }) => theme.colors.primary600} 0px 0px 0px 2px;
  }

  &:active {
    background: ${({ theme }) => theme.colors.primary100};
  }

  /* tint the icon with the primary color */
  svg path {
    fill: ${({ theme }) => theme.colors.primary600};
  }
`;

/** Neutral, non-upsell tile shown while premium access is unresolved. */
const UnavailableFieldTypeTile = styled(FieldTypeTile)`
  cursor: not-allowed;
  background: ${({ theme }) => theme.colors.neutral100};

  &:hover,
  &:active {
    border-color: ${({ theme }) => theme.colors.neutral200};
    background: ${({ theme }) => theme.colors.neutral100};
  }

  svg path {
    fill: ${({ theme }) => theme.colors.neutral500};
  }
`;

const featureForFieldType = (fieldType: FieldType): FeatureKey | null => {
  if (!fieldType.tier || fieldType.tier === 'free') return null;
  return fieldType.type === 'consent'
    ? 'compliance.consent'
    : (`fields.${fieldType.type}` as FeatureKey);
};

/**
 * FieldTypeSelector modal component.
 * Displays available field types organized by category, with search, for
 * selection. Tiles use real interactive styling via styled-components.
 */
export const FieldTypeSelector = ({
  isOpen,
  onClose,
  onSelect,
  fieldTypes,
  isLoading = false,
}: FieldTypeSelectorProps) => {
  const { formatMessage } = useIntl();
  const { access } = useLicense();
  const { toggleNotification } = useNotification();
  const [search, setSearch] = useState('');

  // Free types stay interactive even when license verification is unresolved.
  // Premium types preserve all four access states so an unknown result never
  // masquerades as an upgrade prompt.
  const accessForFieldType = (fieldType: FieldType): FeatureAccess => {
    const feature = featureForFieldType(fieldType);
    return feature === null ? 'entitled' : access(feature);
  };

  const categoryLabel = (category: string) =>
    formatMessage({
      id: getTranslation(`fieldType.category.${category}`),
      defaultMessage: category,
    });

  const typeLabel = (fieldType: FieldType) =>
    formatMessage({
      id: getTranslation(`fieldType.${fieldType.type}`),
      defaultMessage: fieldType.label,
    });

  // Filter by search query, then group by category.
  const groupedTypes = useMemo(() => {
    const query = search.trim().toLowerCase();
    const groups: Record<string, FieldType[]> = {};

    for (const fieldType of fieldTypes) {
      const label = typeLabel(fieldType).toLowerCase();
      if (query && !label.includes(query) && !fieldType.type.includes(query)) {
        continue;
      }
      if (!groups[fieldType.category]) {
        groups[fieldType.category] = [];
      }
      groups[fieldType.category].push(fieldType);
    }

    return groups;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fieldTypes, search]);

  const hasResults = Object.keys(groupedTypes).length > 0;

  const handleSelect = (fieldType: FieldType) => {
    const fieldAccess = accessForFieldType(fieldType);
    if (fieldAccess === 'unentitled') {
      const requiredTier = fieldType.tier === 'business' ? 'Business' : 'Pro';
      toggleNotification({
        type: 'info',
        message: `${formatMessage(
          {
            id: getTranslation('fieldType.selector.requiresPlan'),
            defaultMessage: 'This field type requires a {tier} plan.',
          },
          { tier: requiredTier }
        )} ${PURCHASE_URL}`,
      });
      return;
    }
    if (fieldAccess !== 'entitled') return;

    onSelect(fieldType.type);
    setSearch('');
    onClose();
  };

  const handleOpenChange = (open: boolean) => {
    if (!open) {
      setSearch('');
      onClose();
    }
  };

  return (
    <Modal.Root open={isOpen} onOpenChange={handleOpenChange}>
      <Modal.Content>
        <Modal.Header>
          <Modal.Title>
            {formatMessage({
              id: getTranslation('fieldType.selector.title'),
              defaultMessage: 'Select a field type',
            })}
          </Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <Box marginBottom={4}>
            <Searchbar
              name="field-type-search"
              value={search}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setSearch(e.target.value)}
              onClear={() => setSearch('')}
              clearLabel={formatMessage({
                id: getTranslation('common.clear'),
                defaultMessage: 'Clear',
              })}
              placeholder={formatMessage({
                id: getTranslation('fieldType.selector.search'),
                defaultMessage: 'Search field types...',
              })}
            >
              {formatMessage({
                id: getTranslation('fieldType.selector.search'),
                defaultMessage: 'Search field types...',
              })}
            </Searchbar>
          </Box>

          {isLoading ? (
            <Box padding={8} textAlign="center">
              <Typography textColor="neutral600">
                {formatMessage({
                  id: getTranslation('common.loading'),
                  defaultMessage: 'Loading...',
                })}
              </Typography>
            </Box>
          ) : !hasResults ? (
            <Box padding={8} textAlign="center">
              <Typography textColor="neutral600">
                {formatMessage({
                  id: getTranslation('fieldType.selector.empty'),
                  defaultMessage: 'No field types match your search',
                })}
              </Typography>
            </Box>
          ) : (
            <Flex direction="column" gap={6} alignItems="stretch">
              {CATEGORY_ORDER.map((category) => {
                const types = groupedTypes[category];
                if (!types?.length) return null;

                return (
                  <Box key={category}>
                    <Typography
                      variant="sigma"
                      textColor="neutral600"
                      textTransform="uppercase"
                      fontWeight="bold"
                    >
                      {categoryLabel(category)}
                    </Typography>
                    <Box marginTop={3}>
                      <Grid.Root gap={3} gridCols={12}>
                        {types.map((fieldType) => {
                          const fieldAccess = accessForFieldType(fieldType);
                          const label = typeLabel(fieldType);
                          const unavailableLabel =
                            fieldAccess === 'checking'
                              ? formatMessage({
                                  id: getTranslation('license.checking'),
                                  defaultMessage: 'Checking FormFlow license…',
                                })
                              : formatMessage({
                                  id: getTranslation('fieldType.selector.unavailable'),
                                  defaultMessage: 'License verification is unavailable.',
                                });

                          return (
                            <Grid.Item
                              key={fieldType.type}
                              col={4}
                              xs={6}
                              direction="column"
                              alignItems="stretch"
                            >
                              {fieldAccess === 'unentitled' ? (
                                <FieldTypeLockState
                                  label={label}
                                  icon={fieldType.icon}
                                  tier={fieldType.tier as Tier}
                                  onLockedClick={() => handleSelect(fieldType)}
                                />
                              ) : fieldAccess === 'checking' || fieldAccess === 'unavailable' ? (
                                <UnavailableFieldTypeTile
                                  type="button"
                                  disabled
                                  title={`${label}: ${unavailableLabel}`}
                                  aria-label={`${label}: ${unavailableLabel}`}
                                >
                                  <Flex direction="column" alignItems="center" gap={2}>
                                    <Flex>{getFieldIcon(fieldType.type)}</Flex>
                                    <Typography
                                      variant="pi"
                                      fontWeight="bold"
                                      textAlign="center"
                                      textColor="neutral700"
                                    >
                                      {label}
                                    </Typography>
                                    <Typography
                                      variant="pi"
                                      textAlign="center"
                                      textColor="neutral600"
                                    >
                                      {unavailableLabel}
                                    </Typography>
                                  </Flex>
                                </UnavailableFieldTypeTile>
                              ) : (
                                <FieldTypeTile
                                  type="button"
                                  onClick={() => handleSelect(fieldType)}
                                >
                                  <Flex direction="column" alignItems="center" gap={2}>
                                    <Flex>{getFieldIcon(fieldType.type)}</Flex>
                                    <Typography
                                      variant="pi"
                                      fontWeight="bold"
                                      textAlign="center"
                                      textColor="neutral800"
                                    >
                                      {label}
                                    </Typography>
                                  </Flex>
                                </FieldTypeTile>
                              )}
                            </Grid.Item>
                          );
                        })}
                      </Grid.Root>
                    </Box>
                  </Box>
                );
              })}
            </Flex>
          )}
        </Modal.Body>
        <Modal.Footer>
          <Modal.Close>
            <Button variant="tertiary">
              {formatMessage({
                id: getTranslation('common.cancel'),
                defaultMessage: 'Cancel',
              })}
            </Button>
          </Modal.Close>
        </Modal.Footer>
      </Modal.Content>
    </Modal.Root>
  );
};
