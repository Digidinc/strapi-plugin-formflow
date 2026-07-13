import * as React from 'react';
import { useState, useCallback, useMemo } from 'react';
import {
  Box,
  Flex,
  Grid,
  Typography,
  Button,
  IconButton,
  Badge,
  Divider,
  Field,
  SingleSelect,
  SingleSelectOption,
  Dialog,
} from '@strapi/design-system';
import { ConfirmDialog, useNotification } from '@strapi/strapi/admin';
import { Plus, Trash, Pencil, Drag, Duplicate, WarningCircle } from '@strapi/icons';
import { useIntl } from 'react-intl';
import { v4 as uuidv4 } from 'uuid';
import styled from 'styled-components';

import { getTranslation } from '../../utils/getTranslation';
import { useFieldTypes } from '../../hooks';
import { FieldTypeSelector } from './FieldTypeSelector';
import { FieldEditor } from './FieldEditor';
import { FieldPreview } from './FieldPreview';
import { StepsManager } from '../../ee/components/FormBuilder/StepsManager';
import { useLicense } from '../../ee/hooks/useLicense';
import { accessPresentation } from '../../ee/license-state';
import type { FormField, FormSettings, FormStep } from '../../utils/api';
import {
  conditionalDependents,
  deleteFieldAndConditions,
  renameFieldAndCascade,
} from './conditional-relations';

export interface FormBuilderProps {
  fields: FormField[];
  onChange: (fields: FormField[]) => void;
  /** Form settings (used for the multi-step steps manager). */
  settings: Partial<FormSettings>;
  /** Update the form settings (used to read/write `settings.steps`). */
  onSettingsChange: (settings: Partial<FormSettings>) => void;
}

/**
 * Creates a new field with default values based on the field type
 */
const createNewField = (type: string, order: number): FormField => {
  const baseField: FormField = {
    id: uuidv4(),
    type,
    name: `field_${Date.now()}`,
    label: getDefaultLabel(type),
    placeholder: '',
    description: '',
    required: false,
    validation: [],
    order,
    width: 'full',
  };

  if (['select', 'radio', 'checkbox'].includes(type)) {
    baseField.options = [
      { label: 'Option 1', value: 'option_1' },
      { label: 'Option 2', value: 'option_2' },
    ];
  }

  if (type === 'heading') {
    baseField.attributes = { level: 'h2' };
  }

  return baseField;
};

/**
 * Get default label for a field type
 */
const getDefaultLabel = (type: string): string => {
  const labels: Record<string, string> = {
    text: 'Text Field',
    textarea: 'Text Area',
    email: 'Email Address',
    number: 'Number',
    phone: 'Phone Number',
    url: 'Website URL',
    password: 'Password',
    select: 'Select',
    radio: 'Radio Buttons',
    checkbox: 'Checkboxes',
    boolean: 'Yes/No',
    date: 'Date',
    time: 'Time',
    datetime: 'Date & Time',
    file: 'File Upload',
    hidden: 'Hidden Field',
    heading: 'Heading',
    paragraph: 'Paragraph',
    divider: 'Divider',
  };

  return labels[type] || 'New Field';
};

/**
 * Ensures `name` is unique among `existingNames`. If it collides, appends an
 * incrementing numeric suffix (`name_2`, `name_3`, ...) until unique. The field
 * `name` is the submission-data key, so duplicates would silently overwrite
 * each other's submitted values.
 */
const makeUniqueName = (name: string, existingNames: string[]): string => {
  if (!existingNames.includes(name)) return name;
  let suffix = 2;
  let candidate = `${name}_${suffix}`;
  while (existingNames.includes(candidate)) {
    suffix += 1;
    candidate = `${name}_${suffix}`;
  }
  return candidate;
};

/**
 * Draggable field card with a visible drop indicator. Uses styled-components so
 * the drag affordance / drop-target highlight actually render (design-system
 * Box cannot express `:hover`/cursor for these states).
 */
const FieldCard = styled(Box)<{ $dragging: boolean; $dropTarget: boolean }>`
  cursor: default;
  opacity: ${({ $dragging }) => ($dragging ? 0.4 : 1)};
  border: 1px solid
    ${({ theme, $dropTarget }) => ($dropTarget ? theme.colors.primary600 : theme.colors.neutral200)};
  box-shadow: ${({ theme, $dropTarget }) =>
    $dropTarget ? `${theme.colors.primary600} 0px 0px 0px 1px` : 'none'};
  transition:
    border-color 0.12s ease-in-out,
    box-shadow 0.12s ease-in-out,
    opacity 0.12s ease-in-out;
`;

const DragHandle = styled(Flex)`
  cursor: grab;
  color: ${({ theme }) => theme.colors.neutral500};

  &:active {
    cursor: grabbing;
  }

  svg path {
    fill: ${({ theme }) => theme.colors.neutral500};
  }
`;

/**
 * FormBuilder component - core form building interface.
 * Renders fields in a 12-column responsive grid respecting their width,
 * supports drag-to-reorder (commit on drop) with a visible drop indicator, and
 * provides a multi-step steps manager when the form layout is multi-step.
 */
export const FormBuilder = ({ fields, onChange, settings, onSettingsChange }: FormBuilderProps) => {
  const { formatMessage } = useIntl();
  const { can, access } = useLicense();
  const { toggleNotification } = useNotification();
  const { fieldTypes, isLoading: isLoadingFieldTypes } = useFieldTypes();
  const [isSelectorOpen, setIsSelectorOpen] = useState(false);
  const [selectedFieldId, setSelectedFieldId] = useState<string | null>(null);
  const [isEditorOpen, setIsEditorOpen] = useState(false);
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  // Field id queued for deletion; non-null while the confirm dialog is open.
  const [fieldPendingDeletion, setFieldPendingDeletion] = useState<string | null>(null);

  const conditionalAccess = access('conditionalLogic');
  const conditionalRequiresProMessage = formatMessage({
    id: getTranslation('fieldEditor.conditional.requiresPro'),
    defaultMessage: 'Conditional Logic requires a Pro plan.',
  });
  const licenseVerificationUnavailableMessage = formatMessage({
    id: getTranslation('license.unavailable'),
    defaultMessage:
      'FormFlow could not verify the current license. Premium controls are temporarily unavailable. Free features remain available.',
  });

  const isMultiStep = settings.layout === 'multi-step';
  const steps = useMemo<FormStep[]>(() => settings.steps || [], [settings.steps]);

  const sortedFields = useMemo(() => {
    return [...fields].sort((a, b) => a.order - b.order);
  }, [fields]);

  const selectedField = useMemo(() => {
    return fields.find((f) => f.id === selectedFieldId) || null;
  }, [fields, selectedFieldId]);

  // ----- Field CRUD -----
  const handleAddFieldClick = useCallback(() => setIsSelectorOpen(true), []);
  const handleSelectorClose = useCallback(() => setIsSelectorOpen(false), []);

  const handleFieldTypeSelect = useCallback(
    (type: string) => {
      const newField = createNewField(type, fields.length);
      newField.name = makeUniqueName(
        newField.name,
        fields.map((f) => f.name)
      );
      onChange([...fields, newField]);
      setSelectedFieldId(newField.id);
      setIsEditorOpen(true);
    },
    [fields, onChange]
  );

  const handleFieldEdit = useCallback((fieldId: string) => {
    setSelectedFieldId(fieldId);
    setIsEditorOpen(true);
  }, []);

  const handleFieldUpdate = useCallback(
    (updates: Partial<FormField>) => {
      if (!selectedFieldId) return;
      const selected = fields.find((field) => field.id === selectedFieldId);
      if (!selected) return;

      // The field `name` is the submission-data key and must stay unique. If a
      // rename collides with another field's name, append a numeric suffix.
      const finalName =
        updates.name === undefined
          ? selected.name
          : makeUniqueName(
              updates.name,
              fields.filter((field) => field.id !== selectedFieldId).map((field) => field.name)
            );
      const cascadedFields =
        finalName === selected.name
          ? fields
          : renameFieldAndCascade(fields, selectedFieldId, finalName);
      const nextUpdates = updates.name === undefined ? updates : { ...updates, name: finalName };

      onChange(
        cascadedFields.map((field) =>
          field.id === selectedFieldId ? { ...field, ...nextUpdates } : field
        )
      );
    },
    [fields, onChange, selectedFieldId]
  );

  const handleFieldDuplicate = useCallback(
    (fieldId: string) => {
      const original = fields.find((f) => f.id === fieldId);
      if (!original) return;
      if (original.conditional && conditionalAccess !== 'entitled') {
        const presentation = accessPresentation(conditionalAccess);
        toggleNotification({
          type: 'info',
          message: presentation.showUpgrade
            ? conditionalRequiresProMessage
            : licenseVerificationUnavailableMessage,
        });
        return;
      }

      const copy: FormField = {
        ...original,
        id: uuidv4(),
        name: makeUniqueName(
          `${original.name}_copy`,
          fields.map((f) => f.name)
        ),
        label: `${original.label} (copy)`,
        order: fields.length,
        conditional: original.conditional ? { ...original.conditional } : undefined,
      };
      onChange([...fields, copy]);
    },
    [
      conditionalAccess,
      conditionalRequiresProMessage,
      fields,
      licenseVerificationUnavailableMessage,
      onChange,
      toggleNotification,
    ]
  );

  // Queue a field for deletion (opens the confirm dialog). Deleting a fully
  // configured field is destructive and irreversible, so we confirm first.
  const handleFieldDeleteRequest = useCallback((fieldId: string) => {
    setFieldPendingDeletion(fieldId);
  }, []);

  const handleFieldDeleteCancel = useCallback(() => {
    setFieldPendingDeletion(null);
  }, []);

  const handleFieldDeleteConfirm = useCallback(() => {
    const fieldId = fieldPendingDeletion;
    if (!fieldId) return;
    const target = fields.find((f) => f.id === fieldId);
    const deletion = deleteFieldAndConditions(fields, fieldId);
    onChange(deletion.fields.map((field, index) => ({ ...field, order: index })));
    // Also unassign the field from any multi-step step. Step membership is
    // keyed by the stable field id (not the mutable name).
    if (target && steps.length > 0) {
      onSettingsChange({
        ...settings,
        steps: steps.map((s) => ({
          ...s,
          fields: s.fields.filter((id) => id !== target.id),
        })),
      });
    }
    if (selectedFieldId === fieldId) {
      setSelectedFieldId(null);
      setIsEditorOpen(false);
    }
    setFieldPendingDeletion(null);
  }, [fieldPendingDeletion, fields, onChange, selectedFieldId, steps, settings, onSettingsChange]);

  const fieldToDelete = useMemo(
    () => fields.find((f) => f.id === fieldPendingDeletion) || null,
    [fields, fieldPendingDeletion]
  );

  const conditionalDependentsToDelete = useMemo(
    () =>
      fieldToDelete
        ? conditionalDependents(fields, fieldToDelete.name).filter(
            (field) => field.id !== fieldToDelete.id
          )
        : [],
    [fieldToDelete, fields]
  );

  const handleEditorClose = useCallback(() => {
    setIsEditorOpen(false);
    setSelectedFieldId(null);
  }, []);

  // ----- Drag & drop (commit on drop, not on every dragOver) -----
  const handleDragStart = useCallback((e: React.DragEvent<HTMLDivElement>, index: number) => {
    setDraggedIndex(index);
    e.dataTransfer.effectAllowed = 'move';
  }, []);

  const handleDragOver = useCallback(
    (e: React.DragEvent<HTMLDivElement>, index: number) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      if (draggedIndex !== null && index !== dropIndex) {
        setDropIndex(index);
      }
    },
    [draggedIndex, dropIndex]
  );

  const handleDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>, index: number) => {
      e.preventDefault();
      if (draggedIndex === null || draggedIndex === index) {
        setDraggedIndex(null);
        setDropIndex(null);
        return;
      }
      const newFields = [...sortedFields];
      const [moved] = newFields.splice(draggedIndex, 1);
      newFields.splice(index, 0, moved);
      onChange(newFields.map((f, i) => ({ ...f, order: i })));
      setDraggedIndex(null);
      setDropIndex(null);
    },
    [draggedIndex, sortedFields, onChange]
  );

  const handleDragEnd = useCallback(() => {
    setDraggedIndex(null);
    setDropIndex(null);
  }, []);

  // ----- Multi-step per-field assignment (the steps list itself is managed by
  // the EE StepsManager component). -----
  const handleAssignFieldToStep = useCallback(
    (fieldId: string, stepId: string | null) => {
      const nextSteps = steps.map((s) => ({
        ...s,
        // remove the field from every step first (keyed by stable field id)
        fields: s.fields.filter((id) => id !== fieldId),
      }));
      if (stepId) {
        const target = nextSteps.find((s) => s.id === stepId);
        if (target) target.fields = [...target.fields, fieldId];
      }
      onSettingsChange({ ...settings, steps: nextSteps });
    },
    [steps, settings, onSettingsChange]
  );

  const stepIdForField = useCallback(
    (fieldId: string): string => {
      const step = steps.find((s) => s.fields.includes(fieldId));
      return step ? step.id : '';
    },
    [steps]
  );

  return (
    <>
      {/* Multi-step manager */}
      {isMultiStep && (
        <StepsManager
          steps={steps}
          settings={settings}
          onSettingsChange={onSettingsChange}
          canEdit={can('multistep')}
        />
      )}

      {/* Fields builder */}
      <Box background="neutral0" hasRadius shadow="tableShadow" padding={5}>
        <Flex justifyContent="space-between" alignItems="center" marginBottom={4}>
          <Box>
            <Typography variant="delta" fontWeight="bold">
              {formatMessage({
                id: getTranslation('builder.title'),
                defaultMessage: 'Form Fields',
              })}
            </Typography>
            <Typography variant="pi" textColor="neutral600">
              {formatMessage({
                id: getTranslation('builder.subtitle'),
                defaultMessage: 'Add and configure the fields for your form',
              })}
            </Typography>
          </Box>
          <Button size="S" startIcon={<Plus />} onClick={handleAddFieldClick}>
            {formatMessage({
              id: getTranslation('builder.addField'),
              defaultMessage: 'Add Field',
            })}
          </Button>
        </Flex>

        {sortedFields.length === 0 ? (
          <Box padding={8} textAlign="center" background="neutral100" hasRadius>
            <Flex direction="column" gap={2} alignItems="center">
              <Typography textColor="neutral600" fontWeight="bold">
                {formatMessage({
                  id: getTranslation('builder.empty.title'),
                  defaultMessage: 'No fields yet',
                })}
              </Typography>
              <Typography textColor="neutral500" variant="pi">
                {formatMessage({
                  id: getTranslation('builder.empty.description'),
                  defaultMessage: 'Add your first field to start building the form',
                })}
              </Typography>
            </Flex>
          </Box>
        ) : (
          <>
            <Grid.Root gap={3} gridCols={12}>
              {sortedFields.map((field, index) => (
                <Grid.Item
                  key={field.id}
                  col={field.width === 'half' ? 6 : 12}
                  xs={12}
                  direction="column"
                  alignItems="stretch"
                >
                  <FieldCard
                    draggable
                    onDragStart={(e: React.DragEvent<HTMLDivElement>) => handleDragStart(e, index)}
                    onDragOver={(e: React.DragEvent<HTMLDivElement>) => handleDragOver(e, index)}
                    onDrop={(e: React.DragEvent<HTMLDivElement>) => handleDrop(e, index)}
                    onDragEnd={handleDragEnd}
                    padding={4}
                    background="neutral0"
                    hasRadius
                    $dragging={draggedIndex === index}
                    $dropTarget={dropIndex === index && draggedIndex !== index}
                  >
                    <Flex justifyContent="space-between" alignItems="flex-start" gap={3}>
                      <Flex gap={3} alignItems="flex-start" flex={1} overflow="hidden">
                        <DragHandle
                          alignItems="center"
                          paddingTop={1}
                          aria-label={formatMessage({
                            id: getTranslation('builder.field.move'),
                            defaultMessage: 'Drag to reorder',
                          })}
                        >
                          <Drag />
                        </DragHandle>
                        <Box flex={1} overflow="hidden">
                          <Flex gap={2} marginBottom={2} wrap="wrap">
                            <Badge>{field.type}</Badge>
                            {field.required && (
                              <Badge backgroundColor="danger100" textColor="danger700">
                                {formatMessage({
                                  id: getTranslation('builder.field.required'),
                                  defaultMessage: 'Required',
                                })}
                              </Badge>
                            )}
                            <Badge backgroundColor="neutral150" textColor="neutral700">
                              {field.width === 'half' ? '50%' : '100%'}
                            </Badge>
                            {field.conditional && (
                              <Badge backgroundColor="secondary100" textColor="secondary700">
                                {formatMessage({
                                  id: getTranslation('builder.field.conditional'),
                                  defaultMessage: 'Conditional',
                                })}
                              </Badge>
                            )}
                          </Flex>
                          {/* Realistic field preview */}
                          <FieldPreview field={field} />
                        </Box>
                      </Flex>
                      <Flex gap={1} shrink={0}>
                        <IconButton
                          label={formatMessage({
                            id: getTranslation('builder.field.edit'),
                            defaultMessage: 'Edit field',
                          })}
                          variant="ghost"
                          withTooltip={false}
                          onClick={(e: React.MouseEvent) => {
                            e.stopPropagation();
                            handleFieldEdit(field.id);
                          }}
                        >
                          <Pencil />
                        </IconButton>
                        <IconButton
                          label={formatMessage({
                            id: getTranslation('builder.field.duplicate'),
                            defaultMessage: 'Duplicate field',
                          })}
                          variant="ghost"
                          withTooltip={false}
                          onClick={(e: React.MouseEvent) => {
                            e.stopPropagation();
                            handleFieldDuplicate(field.id);
                          }}
                        >
                          <Duplicate />
                        </IconButton>
                        <IconButton
                          label={formatMessage({
                            id: getTranslation('builder.field.delete'),
                            defaultMessage: 'Delete field',
                          })}
                          variant="ghost"
                          withTooltip={false}
                          onClick={(e: React.MouseEvent) => {
                            e.stopPropagation();
                            handleFieldDeleteRequest(field.id);
                          }}
                        >
                          <Trash />
                        </IconButton>
                      </Flex>
                    </Flex>

                    {/* Per-field step assignment (multi-step only) */}
                    {isMultiStep && steps.length > 0 && (
                      <>
                        <Box marginTop={3} marginBottom={3}>
                          <Divider />
                        </Box>
                        <Field.Root name={`field-step-${field.id}`}>
                          <Field.Label>
                            {formatMessage({
                              id: getTranslation('builder.steps.assign'),
                              defaultMessage: 'Step',
                            })}
                          </Field.Label>
                          <SingleSelect
                            value={stepIdForField(field.id)}
                            onChange={(value: string | number) =>
                              handleAssignFieldToStep(field.id, value ? String(value) : null)
                            }
                            disabled={!can('multistep')}
                          >
                            <SingleSelectOption value="">
                              {formatMessage({
                                id: getTranslation('builder.steps.unassigned'),
                                defaultMessage: 'Unassigned',
                              })}
                            </SingleSelectOption>
                            {steps.map((s) => (
                              <SingleSelectOption key={s.id} value={s.id}>
                                {s.title}
                              </SingleSelectOption>
                            ))}
                          </SingleSelect>
                        </Field.Root>
                      </>
                    )}
                  </FieldCard>
                </Grid.Item>
              ))}
            </Grid.Root>

            <Box marginTop={4} textAlign="center">
              <Typography textColor="neutral600" variant="pi">
                {formatMessage(
                  {
                    id: getTranslation('builder.fieldCount'),
                    defaultMessage:
                      '{count} {count, plural, one {field} other {fields}} configured',
                  },
                  { count: sortedFields.length }
                )}
              </Typography>
            </Box>
          </>
        )}
      </Box>

      {/* Field Type Selector Modal */}
      <FieldTypeSelector
        isOpen={isSelectorOpen}
        onClose={handleSelectorClose}
        onSelect={handleFieldTypeSelect}
        fieldTypes={fieldTypes}
        isLoading={isLoadingFieldTypes}
      />

      {/* Field Editor Modal */}
      <FieldEditor
        field={selectedField}
        allFields={fields}
        isOpen={isEditorOpen}
        onChange={handleFieldUpdate}
        onClose={handleEditorClose}
      />

      {/* Delete-field confirmation */}
      <Dialog.Root
        open={fieldPendingDeletion !== null}
        onOpenChange={(open: boolean) => {
          if (!open) {
            handleFieldDeleteCancel();
          }
        }}
      >
        <ConfirmDialog
          variant="danger-light"
          icon={<WarningCircle />}
          title={formatMessage({
            id: getTranslation('builder.field.delete.confirm.title'),
            defaultMessage: 'Delete field',
          })}
          onConfirm={handleFieldDeleteConfirm}
          onCancel={handleFieldDeleteCancel}
        >
          <Flex direction="column" gap={2} alignItems="stretch">
            <Typography>
              {formatMessage(
                {
                  id: getTranslation('builder.field.delete.confirm.body'),
                  defaultMessage:
                    'Are you sure you want to delete the field "{label}"? This will remove its configuration and cannot be undone.',
                },
                { label: fieldToDelete?.label || fieldToDelete?.name || '' }
              )}
            </Typography>
            {conditionalDependentsToDelete.length > 0 ? (
              <Typography>
                {formatMessage(
                  {
                    id: getTranslation('builder.field.delete.confirm.dependents'),
                    defaultMessage:
                      'The conditional rules for these fields will also be removed: {labels}.',
                  },
                  {
                    labels: conditionalDependentsToDelete
                      .map((field) => field.label || field.name)
                      .join(', '),
                  }
                )}
              </Typography>
            ) : null}
          </Flex>
        </ConfirmDialog>
      </Dialog.Root>
    </>
  );
};
