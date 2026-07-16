import type { Core } from '@strapi/strapi';

import { STEP_INDICATOR_FIELD, type UploadedFilesMap } from '../services/submission';

/**
 * Koa context interface for public controller methods
 */
export interface PublicContext {
  params: { slug?: string; resumeToken?: string };
  query: Record<string, unknown>;
  request: {
    body: Record<string, unknown>;
    ip: string;
    headers: Record<string, string | string[] | undefined>;
    /**
     * Files parsed from a multipart/form-data submission, keyed by the
     * multipart field name. Populated by the core `strapi::body` middleware
     * (koa-body, patchKoa). Absent for JSON submissions.
     */
    files?: UploadedFilesMap;
  };
  status: number;
  notFound: (message?: string) => void;
  throw: (status: number, message: string) => never;
}

/**
 * Metadata collected from the submission request
 */
interface SubmissionMetadata {
  ipAddress: string;
  userAgent: string | undefined;
  referrer: string | undefined;
  submittedAt: string;
}

/**
 * Custom validation error with details
 */
interface ValidationError extends Error {
  name: 'ValidationError';
  details: Record<string, string[]>;
}

/**
 * Type guard to check if error is a ValidationError
 */
const isValidationError = (error: unknown): error is ValidationError => {
  return error instanceof Error && error.name === 'ValidationError';
};

/**
 * Entitlement error thrown by gated services (e.g. save & resume) when the
 * license is not entitled. Shaped as a plain object with an HTTP 402 status so
 * the controller can map it straight to a Payment Required response.
 */
interface PaymentRequiredError {
  status: 402;
  name: 'PaymentRequiredError';
  message: string;
}

/**
 * Type guard for the 402 entitlement error thrown from gated service methods.
 */
const isPaymentRequiredError = (error: unknown): error is PaymentRequiredError => {
  return (
    typeof error === 'object' && error !== null && (error as { status?: unknown }).status === 402
  );
};

/**
 * Public controller for form schema and submission endpoints
 * These endpoints are exposed via content-api routes (public access)
 */
const publicController = ({ strapi }: { strapi: Core.Strapi }) => ({
  /**
   * Get form schema for frontend rendering
   * GET /api/formflow/forms/:slug
   *
   * Returns the public-safe portions of a form configuration
   * for frontend applications to dynamically render forms.
   *
   * @param ctx - Koa context
   * @returns Form schema or 404 if not found/inactive
   */
  async getFormSchema(ctx: PublicContext) {
    const { slug } = ctx.params;

    if (!slug || typeof slug !== 'string') {
      ctx.status = 400;
      return {
        error: {
          status: 400,
          name: 'BadRequestError',
          message: 'Form slug is required',
        },
      };
    }

    // Optional locale query param selects a configured per-locale content
    // override (Business multi-language). Serving a locale is never gated.
    const locale = typeof ctx.query.locale === 'string' ? ctx.query.locale : undefined;

    try {
      const schema = await strapi
        .plugin('formflow')
        .service('form')
        .getPublicSchema(slug, { locale });

      if (!schema) {
        return ctx.notFound('Form not found or not available');
      }

      return { data: schema };
    } catch (error) {
      strapi.log.error('Error fetching form schema:', error);
      ctx.throw(500, 'Internal server error');
    }
  },

  /**
   * Record that a visitor started interacting with a rendered form.
   * POST /api/formflow/forms/:slug/analytics/start
   *
   * Capture is intentionally public and license-independent, matching schema
   * views and successful-submission completions. The SDK calls this endpoint at
   * most once per store session and treats analytics as best-effort.
   */
  async trackFormStart(ctx: PublicContext) {
    const { slug } = ctx.params;

    if (!slug || typeof slug !== 'string') {
      ctx.status = 400;
      return;
    }

    const form = await strapi.plugin('formflow').service('form').findBySlug(slug);

    if (!form || !form.isActive) {
      return ctx.notFound('Form not found or not available');
    }

    strapi.plugin('formflow').service('analytics').recordEvent(form.documentId, 'start');
    ctx.status = 204;
  },

  /**
   * Submit form data
   * POST /api/formflow/forms/:slug/submit
   *
   * Validates and processes form submissions, storing them in the database.
   * Handles spam detection, validation errors, and returns appropriate responses.
   *
   * STEP-AWARE VALIDATION (multi-step forms): an OPTIONAL `_step` control field
   * in the request body switches this endpoint into a VALIDATE-ONLY mode. Its
   * value is a step id or a zero-based step index. When present (and the form is
   * multi-step with defined steps), ONLY the fields belonging to that step are
   * validated and the response is `{ data: { valid, errors, step } }` — NO
   * submission is created. When `_step` is ABSENT the endpoint behaves exactly
   * as before: it validates ALL fields and persists the submission. Thus a
   * normal full submission is completely unchanged by this feature.
   *
   * @param ctx - Koa context with form data in request body
   * @returns Success response with message/redirect, per-step validation result,
   *   or validation errors
   */
  async submitForm(ctx: PublicContext) {
    const { slug } = ctx.params;

    // For multipart/form-data submissions koa-body splits the request into text
    // fields (ctx.request.body) and uploaded files (ctx.request.files, keyed by
    // field name). For JSON submissions only the body is set and files is empty.
    // Both content types are supported transparently.
    const submissionData = (ctx.request.body || {}) as Record<string, unknown>;
    const files = (ctx.request.files || {}) as UploadedFilesMap;
    const hasFiles = Object.keys(files).length > 0;

    if (!slug || typeof slug !== 'string') {
      ctx.status = 400;
      return {
        error: {
          status: 400,
          name: 'BadRequestError',
          message: 'Form slug is required',
        },
      };
    }

    // A submission must carry either body fields or uploaded files. A
    // file-only multipart submission has an empty body but non-empty files.
    if ((!submissionData || typeof submissionData !== 'object') && !hasFiles) {
      ctx.status = 400;
      return {
        error: {
          status: 400,
          name: 'BadRequestError',
          message: 'Request body is required',
        },
      };
    }

    // Step-aware (validate-only) branch. When the body carries the `_step`
    // control field, validate ONLY that step and return without persisting.
    // Absent `_step` -> fall through to the normal full-submission flow below.
    const stepIndicator = submissionData[STEP_INDICATOR_FIELD];
    if (stepIndicator !== undefined && stepIndicator !== null && stepIndicator !== '') {
      try {
        const stepResult = await strapi
          .plugin('formflow')
          .service('submission')
          .validateStep(slug, submissionData, stepIndicator as string | number);

        // Mirror the full-submit contract: a step with field errors returns 400
        // with the same ValidationError/details.errors.<field> shape, so the
        // frontend can reuse one error-handling path. A valid step returns 200.
        if (!stepResult.valid) {
          ctx.status = 400;
          return {
            error: {
              status: 400,
              name: 'ValidationError',
              message: 'Validation failed',
              details: {
                errors: stepResult.errors,
                step: stepResult.step,
              },
            },
          };
        }

        return {
          data: {
            valid: true,
            step: stepResult.step,
            errors: {},
          },
        };
      } catch (error) {
        if (error instanceof Error) {
          if (error.message === 'Form not found') {
            return ctx.notFound('Form not found');
          }

          if (error.message === 'Form is not accepting submissions') {
            ctx.status = 403;
            return {
              error: {
                status: 403,
                name: 'ForbiddenError',
                message: 'Form is not accepting submissions',
              },
            };
          }

          // The form is not multi-step or the indicated step does not exist:
          // a client-side mistake, surfaced as a 400 rather than a 500.
          if (error.message === 'Form is not multi-step' || error.message === 'Step not found') {
            ctx.status = 400;
            return {
              error: {
                status: 400,
                name: 'BadRequestError',
                message: error.message,
              },
            };
          }
        }

        strapi.log.error('Error validating form step:', error);
        ctx.throw(500, 'Internal server error');
      }
    }

    // Collect client metadata for submission record
    const userAgentHeader = ctx.request.headers['user-agent'];
    const refererHeader = ctx.request.headers['referer'] || ctx.request.headers['referrer'];

    const metadata: SubmissionMetadata = {
      ipAddress: ctx.request.ip,
      userAgent: Array.isArray(userAgentHeader) ? userAgentHeader[0] : userAgentHeader,
      referrer: Array.isArray(refererHeader) ? refererHeader[0] : refererHeader,
      submittedAt: new Date().toISOString(),
    };

    try {
      const result = await strapi
        .plugin('formflow')
        .service('submission')
        .submit(slug, submissionData, metadata, files);

      return {
        data: {
          success: true,
          message: result.successMessage,
          // Normalized to null when absent so the honeypot fake-success body
          // (spam-check middleware) is byte-identical and not fingerprintable.
          redirectUrl: result.redirectUrl ?? null,
        },
      };
    } catch (error) {
      // Handle validation errors with detailed field-level messages
      if (isValidationError(error)) {
        ctx.status = 400;
        return {
          error: {
            status: 400,
            name: 'ValidationError',
            message: 'Validation failed',
            details: {
              errors: error.details,
            },
          },
        };
      }

      // Handle known error messages with appropriate status codes
      if (error instanceof Error) {
        if (error.message === 'Form not found') {
          return ctx.notFound('Form not found');
        }

        if (error.message === 'Form is not accepting submissions') {
          ctx.status = 403;
          return {
            error: {
              status: 403,
              name: 'ForbiddenError',
              message: 'Form is not accepting submissions',
            },
          };
        }
      }

      // Log and throw generic error for unexpected issues
      strapi.log.error('Error submitting form:', error);
      ctx.throw(500, 'Internal server error');
    }
  },

  /**
   * Save a partial submission (save & resume)
   * POST /api/formflow/forms/:slug/partial
   *
   * Persists incomplete form data under a `draft` status and returns a resume
   * token the frontend stores and replays (via the `_resumeToken` body field) to
   * update the same draft. Save & resume is a Pro feature; when unentitled the
   * service throws a 402 which this handler maps to HTTP 402.
   *
   * @param ctx - Koa context with partial data (and optional `_resumeToken`)
   * @returns The resume token + expiry, or an appropriate error response
   */
  async savePartialForm(ctx: PublicContext) {
    const { slug } = ctx.params;

    if (!slug || typeof slug !== 'string') {
      ctx.status = 400;
      return {
        error: {
          status: 400,
          name: 'BadRequestError',
          message: 'Form slug is required',
        },
      };
    }

    const body = (ctx.request.body || {}) as Record<string, unknown>;

    // `_resumeToken` is a control field (replays an existing draft), never form
    // data — pull it out and strip it before forwarding the rest to the service.
    const resumeToken = typeof body._resumeToken === 'string' ? body._resumeToken : undefined;
    const partialData = { ...body };
    delete partialData._resumeToken;

    const userAgentHeader = ctx.request.headers['user-agent'];
    const refererHeader = ctx.request.headers['referer'] || ctx.request.headers['referrer'];

    const metadata: SubmissionMetadata = {
      ipAddress: ctx.request.ip,
      userAgent: Array.isArray(userAgentHeader) ? userAgentHeader[0] : userAgentHeader,
      referrer: Array.isArray(refererHeader) ? refererHeader[0] : refererHeader,
      submittedAt: new Date().toISOString(),
    };

    try {
      const result = await strapi
        .plugin('formflow')
        .service('submission')
        .savePartial(slug, partialData, metadata, resumeToken);

      return { data: result };
    } catch (error) {
      if (isPaymentRequiredError(error)) {
        ctx.status = 402;
        return {
          error: {
            status: 402,
            name: 'PaymentRequiredError',
            message: error.message,
          },
        };
      }

      if (error instanceof Error) {
        if (error.message === 'Form not found') {
          return ctx.notFound('Form not found');
        }

        if (error.message === 'Form is not accepting submissions') {
          ctx.status = 403;
          return {
            error: {
              status: 403,
              name: 'ForbiddenError',
              message: 'Form is not accepting submissions',
            },
          };
        }
      }

      strapi.log.error('Error saving partial submission:', error);
      ctx.throw(500, 'Internal server error');
    }
  },

  /**
   * Resume a saved partial submission
   * GET /api/formflow/forms/:slug/partial/:resumeToken
   *
   * Returns the previously-saved partial data + metadata for a resume token.
   * Save & resume is a Pro feature; when unentitled the service throws a 402
   * which this handler maps to HTTP 402. An unknown token returns 404.
   *
   * @param ctx - Koa context with `slug` and `resumeToken` route params
   * @returns The saved partial data, or an appropriate error response
   */
  async getPartialForm(ctx: PublicContext) {
    const { slug, resumeToken } = ctx.params;

    if (!slug || typeof slug !== 'string') {
      ctx.status = 400;
      return {
        error: {
          status: 400,
          name: 'BadRequestError',
          message: 'Form slug is required',
        },
      };
    }

    if (!resumeToken || typeof resumeToken !== 'string') {
      ctx.status = 400;
      return {
        error: {
          status: 400,
          name: 'BadRequestError',
          message: 'Resume token is required',
        },
      };
    }

    try {
      const result = await strapi
        .plugin('formflow')
        .service('submission')
        .getPartial(slug, resumeToken);

      if (result === null) {
        return ctx.notFound('No saved progress found for this token');
      }

      return { data: result };
    } catch (error) {
      if (isPaymentRequiredError(error)) {
        ctx.status = 402;
        return {
          error: {
            status: 402,
            name: 'PaymentRequiredError',
            message: error.message,
          },
        };
      }

      if (error instanceof Error && error.message === 'Form not found') {
        return ctx.notFound('Form not found');
      }

      strapi.log.error('Error resuming partial submission:', error);
      ctx.throw(500, 'Internal server error');
    }
  },

  /**
   * Health check endpoint for form API
   * GET /api/formflow
   *
   * Returns a simple status response to verify the API is running.
   */
  async index(_ctx: PublicContext) {
    return {
      data: {
        status: 'ok',
        message: 'FormFlow API is running',
      },
    };
  },
});

export default publicController;
