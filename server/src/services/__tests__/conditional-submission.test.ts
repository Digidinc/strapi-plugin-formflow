import assert from 'node:assert/strict';

import submissionService, { type SubmissionMetadata, type SubmittableForm } from '../submission';
import validationService from '../validation';

interface CreateCall {
  data: Record<string, any>;
}

const createdRows: CreateCall[] = [];
const uploadCalls: unknown[] = [];

const form: SubmittableForm = {
  documentId: 'conditional-form-id',
  slug: 'conditional-form',
  title: 'Conditional form',
  isActive: true,
  updatedAt: '2026-01-01T00:00:00.000Z',
  fields: [
    {
      id: 'source-id',
      type: 'text',
      name: 'show_details',
      label: 'Show details',
    },
    {
      id: 'hidden-text-id',
      type: 'text',
      name: 'hidden_text',
      label: 'Conditional text',
      conditional: { field: 'show_details', operator: 'equals', value: 'yes' },
    },
    {
      id: 'hidden-file-id',
      type: 'file',
      name: 'hidden_file',
      label: 'Conditional file',
      required: true,
      validation: [
        { type: 'maxSize', value: 1, message: 'File is too large' },
        { type: 'allowedTypes', value: 'image/png', message: 'File must be a PNG' },
      ],
      conditional: { field: 'show_details', operator: 'equals', value: 'yes' },
    },
  ],
  settings: {},
};

let actualValidationService!: ReturnType<typeof validationService>;

const strapi: any = {
  plugin(name: string) {
    if (name === 'formflow') {
      return {
        service(serviceName: string) {
          if (serviceName === 'form') {
            return {
              async findBySlug() {
                return form;
              },
              async incrementSubmissionCount() {},
            };
          }
          if (serviceName === 'validation') return actualValidationService;
          if (serviceName === 'license') {
            return {
              can(feature: string) {
                return feature === 'saveResume';
              },
            };
          }
          if (serviceName === 'analytics') {
            return { recordEvent() {} };
          }
          throw new Error(`Unknown formflow service: ${serviceName}`);
        },
      };
    }

    if (name === 'upload') {
      return {
        service(serviceName: string) {
          if (serviceName !== 'upload') throw new Error(`Unknown upload service: ${serviceName}`);
          return {
            async upload(args: unknown) {
              uploadCalls.push(args);
              return [
                {
                  id: 1,
                  documentId: 'uploaded-file-id',
                  url: '/uploads/conditional.png',
                  name: 'conditional.png',
                  mime: 'image/png',
                  sizeInBytes: 256,
                },
              ];
            },
          };
        },
      };
    }

    throw new Error(`Unknown plugin: ${name}`);
  },
  documents(uid: string) {
    if (uid !== 'plugin::formflow.form-submission') {
      throw new Error(`Unknown content type UID: ${uid}`);
    }

    return {
      async create(args: CreateCall) {
        createdRows.push(args);
        return {
          documentId: `submission-${createdRows.length}`,
          ...args.data,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        };
      },
    };
  },
  config: {
    get(_key: string, defaultValue: unknown) {
      return defaultValue ?? {};
    },
  },
  log: {
    error() {},
    warn() {},
  },
};

actualValidationService = validationService({ strapi });
const service = submissionService({ strapi });
const metadata: SubmissionMetadata = {
  ipAddress: '127.0.0.1',
  submittedAt: '2026-01-01T00:00:00.000Z',
};

void (async () => {
  const hiddenInvalidFile = {
    originalFilename: 'hidden.exe',
    mimetype: 'application/x-msdownload',
    size: 2 * 1024 * 1024,
  };

  await service.submit(
    form.slug,
    { show_details: 'no', hidden_text: 'must not persist' },
    metadata,
    { hidden_file: hiddenInvalidFile }
  );

  const hiddenStoredData = createdRows[0].data.data as Record<string, unknown>;
  assert.equal(hiddenStoredData.hidden_text, undefined);
  assert.equal(uploadCalls.length, 0);
  assert.equal(hiddenStoredData.hidden_file, undefined);

  const visibleFile = {
    originalFilename: 'visible.png',
    mimetype: 'image/png',
    size: 256,
  };
  await service.submit(form.slug, { show_details: 'yes', hidden_text: 'visible value' }, metadata, {
    hidden_file: visibleFile,
  });

  const visibleStoredData = createdRows[1].data.data as Record<string, unknown>;
  assert.equal(visibleStoredData.hidden_text, 'visible value');
  assert.equal(uploadCalls.length, 1);
  assert.deepEqual(visibleStoredData.hidden_file, {
    id: 1,
    documentId: 'uploaded-file-id',
    url: '/uploads/conditional.png',
    name: 'conditional.png',
    mime: 'image/png',
    size: 256,
  });

  const rowsBeforeInvalidFile = createdRows.length;
  const uploadsBeforeInvalidFile = uploadCalls.length;
  await assert.rejects(
    service.submit(form.slug, { show_details: 'yes', hidden_text: 'visible value' }, metadata, {
      hidden_file: hiddenInvalidFile,
    }),
    (error: any) => {
      assert.equal(error.name, 'ValidationError');
      assert.deepEqual(error.details.hidden_file, ['File is too large', 'File must be a PNG']);
      return true;
    }
  );
  assert.equal(uploadCalls.length, uploadsBeforeInvalidFile);
  assert.equal(createdRows.length, rowsBeforeInvalidFile);

  await service.savePartial(
    form.slug,
    { show_details: 'no', hidden_text: 'retain in draft' },
    metadata
  );

  const draft = createdRows[createdRows.length - 1].data;
  assert.equal(draft.status, 'draft');
  assert.equal((draft.data as Record<string, unknown>).hidden_text, 'retain in draft');

  console.log('All assertions passed: conditional final submission visibility is immutable.');
})();
