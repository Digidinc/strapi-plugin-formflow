import assert from 'node:assert/strict';

import { partitionFieldsByVisibility, type ConditionalRule } from '../../utils/validation-rules';
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
const warningCalls: unknown[][] = [];

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
    {
      id: 'chain-root-id',
      type: 'text',
      name: 'chain_root',
      label: 'Chain root',
    },
    {
      id: 'chain-gate-id',
      type: 'text',
      name: 'chain_gate',
      label: 'Chain gate',
      conditional: { field: 'chain_root', operator: 'equals', value: 'show' },
    },
    {
      id: 'chain-text-id',
      type: 'email',
      name: 'chain_text',
      label: 'Chain text',
      conditional: { field: 'chain_gate', operator: 'equals', value: 'unlock' },
    },
    {
      id: 'chain-consent-id',
      type: 'consent',
      name: 'chain_consent',
      label: 'Chain consent',
      required: true,
      conditional: { field: 'chain_gate', operator: 'equals', value: 'unlock' },
    },
    {
      id: 'chain-file-id',
      type: 'file',
      name: 'chain_file',
      label: 'Chain file',
      validation: [
        { type: 'maxSize', value: 1, message: 'Chained file is too large' },
        { type: 'allowedTypes', value: 'image/png', message: 'Chained file must be a PNG' },
      ],
      conditional: { field: 'chain_gate', operator: 'equals', value: 'unlock' },
    },
    {
      id: 'file-chain-root-id',
      type: 'text',
      name: 'file_chain_root',
      label: 'File chain root',
    },
    {
      id: 'file-chain-source-id',
      type: 'file',
      name: 'file_chain_source',
      label: 'File chain source',
      conditional: { field: 'file_chain_root', operator: 'equals', value: 'show' },
    },
    {
      id: 'file-chain-note-id',
      type: 'email',
      name: 'file_chain_note',
      label: 'File chain note',
      conditional: { field: 'file_chain_source', operator: 'is_not_empty' },
    },
    {
      id: 'checkbox-source-id',
      type: 'checkbox',
      name: 'topics',
      label: 'Topics',
      options: [
        { label: 'Product', value: 'product' },
        { label: 'Product updates', value: 'product-updates' },
      ],
    },
    {
      id: 'checkbox-dependent-id',
      type: 'text',
      name: 'product_details',
      label: 'Product details',
      required: true,
      conditional: { field: 'topics', operator: 'contains', value: 'product' },
    },
    {
      id: 'required-checkbox-gate-id',
      type: 'text',
      name: 'required_checkbox_gate',
      label: 'Required checkbox gate',
    },
    {
      id: 'required-checkbox-id',
      type: 'checkbox',
      name: 'required_topics',
      label: 'Required topics',
      required: true,
      conditional: { field: 'required_checkbox_gate', operator: 'equals', value: 'show' },
    },
    {
      id: 'empty-checkbox-dependent-id',
      type: 'text',
      name: 'empty_topics_explanation',
      label: 'Empty topics explanation',
      required: true,
      conditional: { field: 'required_topics', operator: 'is_empty' },
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
    warn(...args: unknown[]) {
      warningCalls.push(args);
    },
  },
};

actualValidationService = validationService({ strapi });
const service = submissionService({ strapi });
const metadata: SubmissionMetadata = {
  ipAddress: '127.0.0.1',
  submittedAt: '2026-01-01T00:00:00.000Z',
};

void (async () => {
  const graphFields: Array<{ name: string; type?: string; conditional?: ConditionalRule }> = [
    { name: 'always_first' },
    {
      name: 'missing_target',
      conditional: { field: 'missing_source', operator: 'equals', value: 'yes' },
    },
    { name: 'duplicate_source' },
    { name: 'duplicate_source' },
    {
      name: 'ambiguous_target',
      conditional: { field: 'duplicate_source', operator: 'equals', value: 'yes' },
    },
    {
      name: 'cycle_a',
      conditional: { field: 'cycle_b', operator: 'equals', value: 'on' },
    },
    {
      name: 'cycle_b',
      conditional: { field: 'cycle_a', operator: 'equals', value: 'on' },
    },
    {
      name: 'cycle_descendant',
      conditional: { field: 'cycle_a', operator: 'equals', value: 'on' },
    },
    {
      name: 'empty_source_target',
      conditional: { field: '', operator: 'is_not_empty' },
    },
    { name: 'hidden_graph_root' },
    {
      name: 'hidden_graph_source',
      conditional: { field: 'hidden_graph_root', operator: 'equals', value: 'show' },
    },
    {
      name: 'hidden_empty_descendant',
      conditional: { field: 'hidden_graph_source', operator: 'is_empty' },
    },
    {
      name: 'hidden_not_equals_descendant',
      conditional: { field: 'hidden_graph_source', operator: 'not_equals', value: 'unlock' },
    },
    { name: 'layout_source', type: 'heading' },
    {
      name: 'layout_target',
      conditional: { field: 'layout_source', operator: 'equals', value: 'attacker-value' },
    },
    {
      name: 'self_reference',
      conditional: { field: 'self_reference', operator: 'equals', value: 'yes' },
    },
    {
      name: 'unsupported_operator',
      conditional: {
        field: 'always_first',
        operator: 'unsupported' as ConditionalRule['operator'],
      },
    },
    { name: 'always_last' },
  ];
  const graphData = {
    missing_source: 'yes',
    duplicate_source: 'yes',
    cycle_a: 'on',
    cycle_b: 'on',
    hidden_graph_root: 'hide',
    layout_source: 'attacker-value',
    self_reference: 'yes',
  };
  const graphPartition = partitionFieldsByVisibility(graphFields, graphData);

  assert.deepEqual(
    graphPartition.visible.map((field) => field.name),
    [
      'always_first',
      'duplicate_source',
      'duplicate_source',
      'hidden_graph_root',
      'layout_source',
      'always_last',
    ]
  );
  assert.deepEqual(
    graphPartition.hidden.map((field) => field.name),
    [
      'missing_target',
      'ambiguous_target',
      'cycle_a',
      'cycle_b',
      'cycle_descendant',
      'empty_source_target',
      'hidden_graph_source',
      'hidden_empty_descendant',
      'hidden_not_equals_descendant',
      'layout_target',
      'self_reference',
      'unsupported_operator',
    ]
  );

  const childFirstPartition = partitionFieldsByVisibility(
    [
      {
        name: 'empty_child',
        conditional: { field: 'visible_intermediate', operator: 'is_empty' as const },
      },
      {
        name: 'visible_intermediate',
        conditional: { field: 'visible_root', operator: 'equals' as const, value: 'show' },
      },
      { name: 'visible_root' },
    ],
    { visible_root: 'show' }
  );
  assert.deepEqual(
    childFirstPartition.visible.map((field) => field.name),
    ['empty_child', 'visible_intermediate', 'visible_root']
  );
  assert.deepEqual(childFirstPartition.hidden, []);

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

  const rowsBeforeHiddenFileSource = createdRows.length;
  const uploadsBeforeHiddenFileSource = uploadCalls.length;
  await service.submit(
    form.slug,
    { file_chain_root: 'hide', file_chain_note: 'not-an-email' },
    metadata,
    { file_chain_source: hiddenInvalidFile }
  );

  assert.equal(createdRows.length, rowsBeforeHiddenFileSource + 1);
  const hiddenFileSourceData = createdRows[createdRows.length - 1].data.data as Record<
    string,
    unknown
  >;
  assert.equal(hiddenFileSourceData.file_chain_root, 'hide');
  assert.equal(hiddenFileSourceData.file_chain_source, undefined);
  assert.equal(hiddenFileSourceData.file_chain_note, undefined);
  assert.equal(uploadCalls.length, uploadsBeforeHiddenFileSource);

  const uploadsBeforeVisibleFileSource = uploadCalls.length;
  await service.submit(
    form.slug,
    { file_chain_root: 'show', file_chain_note: 'visible@example.com' },
    metadata,
    { file_chain_source: visibleFile }
  );

  const visibleFileSourceData = createdRows[createdRows.length - 1].data.data as Record<
    string,
    unknown
  >;
  assert.equal(visibleFileSourceData.file_chain_root, 'show');
  assert.equal(visibleFileSourceData.file_chain_note, 'visible@example.com');
  assert.deepEqual(visibleFileSourceData.file_chain_source, {
    id: 1,
    documentId: 'uploaded-file-id',
    url: '/uploads/conditional.png',
    name: 'conditional.png',
    mime: 'image/png',
    size: 256,
  });
  assert.equal(uploadCalls.length, uploadsBeforeVisibleFileSource + 1);

  // A descendant must not become visible from attacker-supplied data when its
  // own source field is hidden higher in the conditional chain.
  const rowsBeforeHiddenChain = createdRows.length;
  const uploadsBeforeHiddenChain = uploadCalls.length;
  const consentUpdatesBeforeHiddenChain = updatedRows.length;
  const warningsBeforeHiddenChain = warningCalls.length;
  await service.submit(
    form.slug,
    {
      chain_root: 'hide',
      chain_gate: 'unlock',
      chain_text: 'not-an-email',
      chain_consent: false,
    },
    metadata,
    { chain_file: hiddenInvalidFile }
  );

  assert.equal(createdRows.length, rowsBeforeHiddenChain + 1);
  const hiddenChainData = createdRows[createdRows.length - 1].data.data as Record<string, unknown>;
  assert.equal(hiddenChainData.chain_root, 'hide');
  assert.equal(hiddenChainData.chain_gate, undefined);
  assert.equal(hiddenChainData.chain_text, undefined);
  assert.equal(hiddenChainData.chain_consent, undefined);
  assert.equal(hiddenChainData.chain_file, undefined);
  assert.equal(uploadCalls.length, uploadsBeforeHiddenChain);
  assert.equal(updatedRows.length, consentUpdatesBeforeHiddenChain);
  assert.equal(warningCalls.length, warningsBeforeHiddenChain + 1);
  const hiddenChainWarning = String(warningCalls[warningCalls.length - 1]?.[0]);
  for (const fieldName of ['chain_gate', 'chain_text', 'chain_consent', 'chain_file']) {
    assert.match(hiddenChainWarning, new RegExp(`\\b${fieldName}\\b`));
  }
  assert.doesNotMatch(
    hiddenChainWarning,
    /unlock|not-an-email|hidden\.exe|application\/x-msdownload|2097152/
  );

  // The same descendants remain available when every source in the chain is
  // legitimately visible and its condition passes.
  const uploadsBeforeVisibleChain = uploadCalls.length;
  const consentUpdatesBeforeVisibleChain = updatedRows.length;
  await service.submit(
    form.slug,
    {
      chain_root: 'show',
      chain_gate: 'unlock',
      chain_text: 'visible@example.com',
      chain_consent: true,
    },
    metadata,
    { chain_file: visibleFile }
  );

  const visibleChainData = createdRows[createdRows.length - 1].data.data as Record<string, unknown>;
  assert.equal(visibleChainData.chain_root, 'show');
  assert.equal(visibleChainData.chain_gate, 'unlock');
  assert.equal(visibleChainData.chain_text, 'visible@example.com');
  assert.equal(visibleChainData.chain_consent, true);
  assert.deepEqual(visibleChainData.chain_file, {
    id: 1,
    documentId: 'uploaded-file-id',
    url: '/uploads/conditional.png',
    name: 'conditional.png',
    mime: 'image/png',
    size: 256,
  });
  assert.equal(uploadCalls.length, uploadsBeforeVisibleChain + 1);
  assert.equal(updatedRows.length, consentUpdatesBeforeVisibleChain + 1);
  const visibleChainConsent = updatedRows[updatedRows.length - 1].data.metadata.consents.find(
    (consent: { field: string }) => consent.field === 'chain_consent'
  );
  assert.deepEqual(
    {
      field: visibleChainConsent.field,
      label: visibleChainConsent.label,
      accepted: visibleChainConsent.accepted,
    },
    {
      field: 'chain_consent',
      label: 'Chain consent',
      accepted: true,
    }
  );

  const originalSettings = form.settings;
  form.settings = {
    layout: 'multi-step',
    steps: [{ id: 'chain-step', fields: ['chain-text-id'] }],
  };

  const hiddenChainStep = await service.validateStep(
    form.slug,
    { chain_root: 'hide', chain_gate: 'unlock', chain_text: 'not-an-email' },
    'chain-step'
  );
  assert.deepEqual(hiddenChainStep, { valid: true, errors: {}, step: 'chain-step' });

  const visibleChainStep = await service.validateStep(
    form.slug,
    { chain_root: 'show', chain_gate: 'unlock', chain_text: 'not-an-email' },
    'chain-step'
  );
  assert.equal(visibleChainStep.valid, false);
  assert.deepEqual(visibleChainStep.errors.chain_text, ['Invalid email address']);

  form.settings = originalSettings;

  // Formidable demotes a one-element multipart checkbox array to a scalar.
  // Visibility must restore checkbox array semantics before evaluating
  // `contains`, otherwise "product-updates" falsely substring-matches
  // "product" and requires a dependent field the client kept hidden.
  const rowsBeforeScalarCheckbox = createdRows.length;
  await service.submit(form.slug, { topics: 'product-updates' }, metadata);

  assert.equal(createdRows.length, rowsBeforeScalarCheckbox + 1);
  const scalarCheckboxData = createdRows[createdRows.length - 1].data.data as Record<
    string,
    unknown
  >;
  assert.deepEqual(scalarCheckboxData.topics, ['product-updates']);
  assert.equal(scalarCheckboxData.product_details, undefined);

  // An empty multipart checkbox scalar represents no selections. It must stay
  // empty for both required validation and descendants using `is_empty`.
  const rowsBeforeEmptyScalarCheckbox = createdRows.length;
  await assert.rejects(
    service.submit(form.slug, { required_checkbox_gate: 'show', required_topics: '' }, metadata),
    (error: any) => {
      assert.equal(error.name, 'ValidationError');
      assert.deepEqual(error.details.required_topics, ['Required topics is required']);
      assert.deepEqual(error.details.empty_topics_explanation, [
        'Empty topics explanation is required',
      ]);
      return true;
    }
  );
  assert.equal(createdRows.length, rowsBeforeEmptyScalarCheckbox);

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
