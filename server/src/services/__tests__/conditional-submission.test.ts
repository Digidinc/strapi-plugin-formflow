import assert from 'node:assert/strict';

import submissionService, { type SubmissionMetadata, type SubmittableForm } from '../submission';
import validationService from '../validation';

interface CreateCall {
  data: Record<string, any>;
}

interface UpdateCall {
  documentId: string;
  data: Record<string, any>;
}

const createdRows: CreateCall[] = [];
const updatedRows: UpdateCall[] = [];
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
    {
      id: 'conditional-consent-id',
      type: 'consent',
      name: 'conditional_consent',
      label: 'Conditional consent',
      conditional: { field: 'show_details', operator: 'equals', value: 'yes' },
    },
    {
      id: 'file-source-id',
      type: 'file',
      name: 'supporting_document',
      label: 'Supporting document',
    },
    {
      id: 'empty-file-source-text-id',
      type: 'text',
      name: 'no_document_note',
      label: 'No-document note',
      conditional: { field: 'supporting_document', operator: 'is_empty' },
    },
    {
      id: 'empty-file-source-file-id',
      type: 'file',
      name: 'no_document_attachment',
      label: 'No-document attachment',
      conditional: { field: 'supporting_document', operator: 'is_empty' },
    },
    {
      id: 'present-file-source-text-id',
      type: 'text',
      name: 'with_document_note',
      label: 'With-document note',
      conditional: { field: 'supporting_document', operator: 'is_not_empty' },
    },
    {
      id: 'present-file-source-file-id',
      type: 'file',
      name: 'with_document_attachment',
      label: 'With-document attachment',
      conditional: { field: 'supporting_document', operator: 'is_not_empty' },
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
                return feature === 'saveResume' || feature === 'compliance.consent';
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
      async update(args: UpdateCall) {
        updatedRows.push(args);
        return args;
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
    {
      show_details: 'no',
      hidden_text: 'must not persist',
      conditional_consent: true,
    },
    metadata,
    { hidden_file: hiddenInvalidFile }
  );

  const hiddenStoredData = createdRows[0].data.data as Record<string, unknown>;
  assert.equal(hiddenStoredData.hidden_text, undefined);
  assert.equal(uploadCalls.length, 0);
  assert.equal(hiddenStoredData.hidden_file, undefined);
  assert.equal(hiddenStoredData.conditional_consent, undefined);
  assert.equal(updatedRows.length, 0);

  const visibleFile = {
    originalFilename: 'visible.png',
    mimetype: 'image/png',
    size: 256,
  };
  await service.submit(
    form.slug,
    {
      show_details: 'yes',
      hidden_text: 'visible value',
      conditional_consent: true,
    },
    metadata,
    { hidden_file: visibleFile }
  );

  const visibleStoredData = createdRows[1].data.data as Record<string, unknown>;
  assert.equal(visibleStoredData.hidden_text, 'visible value');
  assert.equal(visibleStoredData.conditional_consent, true);
  assert.equal(uploadCalls.length, 1);
  assert.deepEqual(visibleStoredData.hidden_file, {
    id: 1,
    documentId: 'uploaded-file-id',
    url: '/uploads/conditional.png',
    name: 'conditional.png',
    mime: 'image/png',
    size: 256,
  });
  assert.equal(updatedRows.length, 1);
  const visibleConsent = updatedRows[0].data.metadata.consents[0];
  assert.deepEqual(
    {
      field: visibleConsent.field,
      label: visibleConsent.label,
      accepted: visibleConsent.accepted,
    },
    {
      field: 'conditional_consent',
      label: 'Conditional consent',
      accepted: true,
    }
  );
  assert.equal(typeof visibleConsent.capturedAt, 'string');

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

  const visibleEmptySourceFile = {
    originalFilename: 'no-document.png',
    mimetype: 'image/png',
    size: 256,
  };
  const uploadsBeforeEmptySource = uploadCalls.length;
  await service.submit(
    form.slug,
    {
      show_details: 'no',
      no_document_note: 'visible without a source file',
      with_document_note: 'must not persist without a source file',
    },
    metadata,
    {
      no_document_attachment: visibleEmptySourceFile,
      with_document_attachment: hiddenInvalidFile,
    }
  );

  const emptySourceStoredData = createdRows[createdRows.length - 1].data.data as Record<
    string,
    unknown
  >;
  assert.equal(emptySourceStoredData.supporting_document, undefined);
  assert.equal(emptySourceStoredData.no_document_note, 'visible without a source file');
  assert.equal(emptySourceStoredData.with_document_note, undefined);
  assert.equal(emptySourceStoredData.with_document_attachment, undefined);
  assert.deepEqual(emptySourceStoredData.no_document_attachment, {
    id: 1,
    documentId: 'uploaded-file-id',
    url: '/uploads/conditional.png',
    name: 'conditional.png',
    mime: 'image/png',
    size: 256,
  });
  assert.equal(uploadCalls.length, uploadsBeforeEmptySource + 1);
  assert.deepEqual(
    uploadCalls.slice(uploadsBeforeEmptySource).map((call: any) => call.files[0].originalFilename),
    ['no-document.png']
  );

  const sourceFile = {
    originalFilename: 'source.png',
    mimetype: 'image/png',
    size: 256,
  };
  const visiblePresentSourceFile = {
    originalFilename: 'with-document.png',
    mimetype: 'image/png',
    size: 256,
  };
  const uploadsBeforePresentSource = uploadCalls.length;
  await service.submit(
    form.slug,
    {
      show_details: 'no',
      no_document_note: 'must not persist with a source file',
      with_document_note: 'visible with a source file',
    },
    metadata,
    {
      supporting_document: sourceFile,
      no_document_attachment: hiddenInvalidFile,
      with_document_attachment: visiblePresentSourceFile,
    }
  );

  const presentSourceStoredData = createdRows[createdRows.length - 1].data.data as Record<
    string,
    unknown
  >;
  assert.equal(presentSourceStoredData.no_document_note, undefined);
  assert.equal(presentSourceStoredData.no_document_attachment, undefined);
  assert.equal(presentSourceStoredData.with_document_note, 'visible with a source file');
  assert.deepEqual(presentSourceStoredData.supporting_document, {
    id: 1,
    documentId: 'uploaded-file-id',
    url: '/uploads/conditional.png',
    name: 'conditional.png',
    mime: 'image/png',
    size: 256,
  });
  assert.deepEqual(presentSourceStoredData.with_document_attachment, {
    id: 1,
    documentId: 'uploaded-file-id',
    url: '/uploads/conditional.png',
    name: 'conditional.png',
    mime: 'image/png',
    size: 256,
  });
  assert.equal(uploadCalls.length, uploadsBeforePresentSource + 2);
  assert.deepEqual(
    uploadCalls
      .slice(uploadsBeforePresentSource)
      .map((call: any) => call.files[0].originalFilename),
    ['source.png', 'with-document.png']
  );

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
