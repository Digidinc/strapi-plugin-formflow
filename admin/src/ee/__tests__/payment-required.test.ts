/* SPDX-License-Identifier: LicenseRef-FormFlow-EE — Commercial. See LICENSE-EE. Not covered by MIT. */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { refreshLicenseOnPaymentRequired } from '../payment-required';

const paymentRequiredErrors: unknown[] = [
  { status: 402 },
  { response: { status: 402 } },
  { response: { data: { error: { status: 402 } } } },
];

const run = async () => {
  for (const error of paymentRequiredErrors) {
    let refreshCalls = 0;

    const handled = await refreshLicenseOnPaymentRequired(error, async () => {
      refreshCalls += 1;
    });

    assert.equal(handled, true);
    assert.equal(refreshCalls, 1);
  }

  let releaseRefresh: (() => void) | undefined;
  let refreshCalls = 0;
  let settled = false;

  const handled = refreshLicenseOnPaymentRequired(
    { response: { data: { error: { status: 402 } } } },
    () =>
      new Promise<void>((resolve) => {
        refreshCalls += 1;
        releaseRefresh = resolve;
      })
  ).finally(() => {
    settled = true;
  });

  await Promise.resolve();
  assert.equal(refreshCalls, 1);
  assert.equal(settled, false);

  releaseRefresh?.();
  assert.equal(await handled, true);
  assert.equal(settled, true);

  const nonPaymentRequiredErrors: unknown[] = [
    null,
    new Error('request failed'),
    { status: 500 },
    { response: { status: 401, data: { error: { status: 500 } } } },
  ];

  for (const error of nonPaymentRequiredErrors) {
    refreshCalls = 0;

    const wasHandled = await refreshLicenseOnPaymentRequired(error, async () => {
      refreshCalls += 1;
    });

    assert.equal(wasHandled, false);
    assert.equal(refreshCalls, 0);
  }

  const expectedRefreshBranches = new Map<string, number>([
    ['admin/src/ee/hooks/useAnalytics.ts', 1],
    ['admin/src/ee/components/ApprovalWorkflow.tsx', 1],
    ['admin/src/ee/pages/CompliancePage.tsx', 3],
  ]);

  for (const [file, expectedCount] of expectedRefreshBranches) {
    const source = readFileSync(path.join(process.cwd(), file), 'utf8');
    const refreshBranches = source.match(
      /if\s*\(\s*await\s+refreshLicenseOnPaymentRequired\s*\(\s*\w+\s*,\s*refresh\s*\)\s*\)/g
    );

    assert.equal(
      refreshBranches?.length ?? 0,
      expectedCount,
      `${file} must refresh license state and skip its normal error UI for every caught 402`
    );
  }

  const analyticsSource = readFileSync(
    path.join(process.cwd(), 'admin/src/ee/hooks/useAnalytics.ts'),
    'utf8'
  );
  assert.doesNotMatch(analyticsSource, /can\(['"]analytics['"]\)/);

  console.log('All assertions passed: payment-required license refresh handling.');
};

void run();
