import type { Core } from '@strapi/strapi';

import type { FormField } from '../services/form';
import type { LicenseResolution } from '../services/license';
import {
  hasDuplicateProvidedFieldIds,
  newConditionalConfigIssues,
  validateConditionalConfig,
  type ConditionalConfigIssue,
} from '../utils/conditional-config';
import {
  findFormEntitlementBlock,
  type FormEntitlementTier,
  type NewFormData,
  type OldForm,
} from '../utils/form-entitlements';

export type { NewFormData, OldForm };

/**
 * Koa context interface for controller methods
 */
export interface Context {
  params: { id?: string };
  query: Record<string, unknown>;
  request: {
    body: Record<string, unknown>;
  };
  status: number;
  notFound: (message?: string) => void;
  throw: (status: number, error: unknown) => never;
}

const UPGRADE_URL = 'https://hrahimi270.github.io/formflow/#pricing';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const hasFields = (data: Record<string, unknown>): boolean =>
  Object.prototype.hasOwnProperty.call(data, 'fields');

const isFieldsPayload = (value: unknown): value is FormField[] =>
  Array.isArray(value) &&
  value.every(
    (field) => isRecord(field) && (field.id === undefined || typeof field.id === 'string')
  );

const licenseCan =
  (strapi: Core.Strapi) =>
  (feature: string): boolean =>
    strapi.plugin('formflow').service('license').can(feature);

const conditionalValidationResponse = (
  ctx: Context,
  conditionalIssues: ConditionalConfigIssue[]
) => {
  ctx.status = 400;
  return {
    error: {
      status: 400,
      name: 'ValidationError',
      message: 'Conditional configuration is invalid.',
      details: { conditionalIssues },
    },
  };
};

const fieldsValidationResponse = (ctx: Context) => {
  ctx.status = 400;
  return {
    error: {
      status: 400,
      name: 'ValidationError',
      message: 'Fields must be an array of objects.',
      details: {},
    },
  };
};

const formPayloadValidationError = (data: Record<string, unknown>): string | null => {
  if (
    Object.prototype.hasOwnProperty.call(data, 'requiresApproval') &&
    typeof data.requiresApproval !== 'boolean'
  ) {
    return 'requiresApproval must be a boolean.';
  }

  if (
    isRecord(data.settings) &&
    Object.prototype.hasOwnProperty.call(data.settings, 'customCss') &&
    typeof data.settings.customCss !== 'string'
  ) {
    return 'settings.customCss must be a string.';
  }

  if (Object.prototype.hasOwnProperty.call(data, 'locales') && !isRecord(data.locales)) {
    return 'locales must be an object.';
  }

  return null;
};

const formPayloadValidationResponse = (ctx: Context, message: string) => {
  ctx.status = 400;
  return {
    error: {
      status: 400,
      name: 'ValidationError',
      message,
      details: {},
    },
  };
};

const duplicateFieldIdsResponse = (ctx: Context) => {
  ctx.status = 400;
  return {
    error: {
      status: 400,
      name: 'ValidationError',
      message: 'Provided field IDs must be unique.',
      details: {},
    },
  };
};

export interface FormPaymentRequiredMetadata {
  message: string;
  requiredTier?: FormEntitlementTier;
}

export const formPaymentRequiredMetadata = (
  feature: string,
  requiredTier?: FormEntitlementTier
): FormPaymentRequiredMetadata => {
  if (requiredTier !== 'pro' && requiredTier !== 'business') {
    return { message: `This feature is not available on the current plan: ${feature}` };
  }

  return {
    message: `Upgrade to ${requiredTier === 'business' ? 'Business' : 'Pro'} to use feature: ${feature}`,
    requiredTier,
  };
};

const paymentRequiredResponse = (
  ctx: Context,
  feature: string,
  requiredTier: FormEntitlementTier,
  resolution: LicenseResolution
) => {
  const metadata = formPaymentRequiredMetadata(feature, requiredTier);
  const canOfferUpgrade = resolution === 'resolved' && metadata.requiredTier !== undefined;
  const message =
    resolution === 'resolved'
      ? metadata.message
      : 'FormFlow could not verify premium access. Check the license status, then retry saving.';
  ctx.status = 402;
  return {
    error: {
      status: 402,
      name: 'PaymentRequired',
      message,
      details: {
        feature,
        resolution,
        ...(metadata.requiredTier ? { requiredTier: metadata.requiredTier } : {}),
        ...(canOfferUpgrade ? { upgradeUrl: UPGRADE_URL } : {}),
      },
    },
  };
};

const formController = ({ strapi }: { strapi: Core.Strapi }) => ({
  /**
   * GET /formflow/forms
   * List all forms with pagination, sorting, and optional search.
   *
   * Query params:
   * - page: Page number (default: 1)
   * - pageSize: Items per page (default: 100)
   * - sort: Sort string "field:direction" (default: createdAt:desc)
   * - _q: Optional search term matched against title/slug ($containsi)
   *
   * Returns a paginated envelope:
   * { data: Form[], meta: { pagination: { page, pageSize, pageCount, total } } }
   */
  async find(ctx: Context) {
    try {
      const query = ctx.query as Record<string, unknown>;

      const page = Math.max(1, parseInt(String(query.page ?? '1'), 10) || 1);
      const pageSize = Math.min(
        500,
        Math.max(1, parseInt(String(query.pageSize ?? '100'), 10) || 100)
      );

      // Parse sort "field:direction" -> { field: direction }
      const sortParam = typeof query.sort === 'string' ? query.sort : 'createdAt:desc';
      const [sortField, sortDir] = sortParam.split(':');
      const sort: Record<string, 'asc' | 'desc'> = {
        [sortField || 'createdAt']: sortDir === 'asc' ? 'asc' : 'desc',
      };

      // Optional search across title and slug
      const search = typeof query._q === 'string' ? query._q.trim() : '';
      const filters: Record<string, unknown> = search
        ? {
            $or: [{ title: { $containsi: search } }, { slug: { $containsi: search } }],
          }
        : {};

      const formService = strapi.plugin('formflow').service('form');

      const [forms, total] = await Promise.all([
        formService.find({
          filters,
          sort,
          start: (page - 1) * pageSize,
          limit: pageSize,
        }),
        formService.count(filters),
      ]);

      return {
        data: forms,
        meta: {
          pagination: {
            page,
            pageSize,
            pageCount: Math.ceil(total / pageSize),
            total,
          },
        },
      };
    } catch (error) {
      strapi.log.error('Error fetching forms:', error);
      ctx.throw(500, error);
    }
  },

  /**
   * GET /formflow/forms/:id
   * Get a single form by documentId
   */
  async findOne(ctx: Context) {
    const { id } = ctx.params;

    if (!id) {
      return ctx.throw(400, new Error('Form ID is required'));
    }

    try {
      const form = await strapi.plugin('formflow').service('form').findOne(id);

      if (!form) {
        return ctx.notFound('Form not found');
      }

      return { data: form };
    } catch (error) {
      strapi.log.error(`Error fetching form ${id}:`, error);
      ctx.throw(500, error);
    }
  },

  /**
   * POST /formflow/forms
   * Create a new form
   */
  async create(ctx: Context) {
    const data = ctx.request.body;

    if (!data || typeof data !== 'object') {
      return ctx.throw(400, new Error('Request body is required'));
    }

    if (!data.title) {
      return ctx.throw(400, new Error('Form title is required'));
    }

    const payloadValidationError = formPayloadValidationError(data);
    if (payloadValidationError) {
      return formPayloadValidationResponse(ctx, payloadValidationError);
    }

    if (hasFields(data) && !isFieldsPayload(data.fields)) {
      return fieldsValidationResponse(ctx);
    }
    if (hasFields(data) && hasDuplicateProvidedFieldIds(data.fields as FormField[])) {
      return duplicateFieldIdsResponse(ctx);
    }

    const newData = data as NewFormData;
    const conditionalIssues = hasFields(data)
      ? validateConditionalConfig(newData.fields as FormField[])
      : [];
    if (conditionalIssues.length > 0) {
      return conditionalValidationResponse(ctx, conditionalIssues);
    }

    const entitlementBlock = findFormEntitlementBlock(null, newData, licenseCan(strapi));
    if (entitlementBlock) {
      return paymentRequiredResponse(
        ctx,
        entitlementBlock.feature,
        entitlementBlock.requiredTier,
        strapi.plugin('formflow').service('license').resolution()
      );
    }

    try {
      const form = await strapi.plugin('formflow').service('form').create(data);

      ctx.status = 201;
      return { data: form };
    } catch (error) {
      strapi.log.error('Error creating form:', error);
      ctx.throw(500, error);
    }
  },

  /**
   * PUT /formflow/forms/:id
   * Update an existing form
   */
  async update(ctx: Context) {
    const { id } = ctx.params;
    const data = ctx.request.body;

    if (!id) {
      return ctx.throw(400, new Error('Form ID is required'));
    }

    if (!data || typeof data !== 'object') {
      return ctx.throw(400, new Error('Request body is required'));
    }

    const payloadValidationError = formPayloadValidationError(data);
    if (payloadValidationError) {
      return formPayloadValidationResponse(ctx, payloadValidationError);
    }

    try {
      // First check if form exists
      const existing = await strapi.plugin('formflow').service('form').findOne(id);

      if (!existing) {
        return ctx.notFound('Form not found');
      }

      if (hasFields(data) && !isFieldsPayload(data.fields)) {
        return fieldsValidationResponse(ctx);
      }
      if (hasFields(data) && hasDuplicateProvidedFieldIds(data.fields as FormField[])) {
        return duplicateFieldIdsResponse(ctx);
      }

      const oldForm = existing as OldForm;
      const newData = data as NewFormData;
      const conditionalIssues = hasFields(data)
        ? newConditionalConfigIssues(
            (oldForm.fields ?? []) as FormField[],
            newData.fields as FormField[]
          )
        : [];
      if (conditionalIssues.length > 0) {
        return conditionalValidationResponse(ctx, conditionalIssues);
      }

      const entitlementBlock = findFormEntitlementBlock(oldForm, newData, licenseCan(strapi));
      if (entitlementBlock) {
        return paymentRequiredResponse(
          ctx,
          entitlementBlock.feature,
          entitlementBlock.requiredTier,
          strapi.plugin('formflow').service('license').resolution()
        );
      }

      const form = await strapi.plugin('formflow').service('form').update(id, data);

      return { data: form };
    } catch (error) {
      strapi.log.error(`Error updating form ${id}:`, error);
      ctx.throw(500, error);
    }
  },

  /**
   * DELETE /formflow/forms/:id
   * Delete a form and all its submissions
   */
  async delete(ctx: Context) {
    const { id } = ctx.params;

    if (!id) {
      return ctx.throw(400, new Error('Form ID is required'));
    }

    try {
      // First check if form exists
      const existing = await strapi.plugin('formflow').service('form').findOne(id);

      if (!existing) {
        return ctx.notFound('Form not found');
      }

      await strapi.plugin('formflow').service('form').delete(id);

      return { data: { success: true } };
    } catch (error) {
      strapi.log.error(`Error deleting form ${id}:`, error);
      ctx.throw(500, error);
    }
  },

  /**
   * POST /formflow/forms/:id/duplicate
   * Duplicate an existing form
   */
  async duplicate(ctx: Context) {
    const { id } = ctx.params;

    if (!id) {
      return ctx.throw(400, new Error('Form ID is required'));
    }

    try {
      const formService = strapi.plugin('formflow').service('form');
      const proposedDuplicate = await formService.prepareDuplicate(id);
      if (!isRecord(proposedDuplicate)) {
        return fieldsValidationResponse(ctx);
      }
      const payloadValidationError = formPayloadValidationError(proposedDuplicate);
      if (payloadValidationError) {
        return formPayloadValidationResponse(ctx, payloadValidationError);
      }
      if (hasFields(proposedDuplicate) && !isFieldsPayload(proposedDuplicate.fields)) {
        return fieldsValidationResponse(ctx);
      }
      if (
        hasFields(proposedDuplicate) &&
        hasDuplicateProvidedFieldIds(proposedDuplicate.fields as FormField[])
      ) {
        return duplicateFieldIdsResponse(ctx);
      }
      const newData = proposedDuplicate as NewFormData;
      const conditionalIssues = hasFields(proposedDuplicate)
        ? validateConditionalConfig(newData.fields as FormField[])
        : [];
      if (conditionalIssues.length > 0) {
        return conditionalValidationResponse(ctx, conditionalIssues);
      }

      const entitlementBlock = findFormEntitlementBlock(null, newData, licenseCan(strapi));
      if (entitlementBlock) {
        return paymentRequiredResponse(
          ctx,
          entitlementBlock.feature,
          entitlementBlock.requiredTier,
          strapi.plugin('formflow').service('license').resolution()
        );
      }

      const form = await formService.create(proposedDuplicate);

      ctx.status = 201;
      return { data: form };
    } catch (error) {
      if (error instanceof Error && error.message === 'Form not found') {
        return ctx.notFound('Form not found');
      }
      strapi.log.error(`Error duplicating form ${id}:`, error);
      ctx.throw(500, error);
    }
  },

  /**
   * GET /formflow/field-types
   * Get all available field types for the form builder
   */
  async getFieldTypes() {
    const fieldTypes = strapi.plugin('formflow').service('form').getFieldTypes();

    return { data: fieldTypes };
  },

  /**
   * GET /formflow/forms/count
   * Count total forms with optional filtering
   */
  async count(ctx: Context) {
    try {
      const count = await strapi
        .plugin('formflow')
        .service('form')
        .count(ctx.query.filters as Record<string, unknown>);

      return { data: { count } };
    } catch (error) {
      strapi.log.error('Error counting forms:', error);
      ctx.throw(500, error);
    }
  },
});

export default formController;
