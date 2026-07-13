/* SPDX-License-Identifier: LicenseRef-FormFlow-EE — Commercial. See LICENSE-EE. Not covered by MIT. */

import type { FeatureAccess } from '../../license-state';
import type { ConditionalRule, FormField } from '../../../utils/api';

export type ConditionalLogicBody =
  | 'checking'
  | 'unavailable'
  | 'readonly-rule'
  | 'dangling-readonly'
  | 'repair-rule'
  | 'prerequisite'
  | 'prerequisite-upsell'
  | 'upsell'
  | 'editor';

export interface ConditionalLogicViewInput {
  access: FeatureAccess;
  conditional: ConditionalRule | undefined;
  conditionSourceFields: ReadonlyArray<Pick<FormField, 'name'>>;
}

export function resolveConditionalLogicBody({
  access,
  conditional,
  conditionSourceFields,
}: ConditionalLogicViewInput): ConditionalLogicBody {
  if (access === 'checking') return 'checking';
  if (access === 'unavailable') return 'unavailable';

  const hasSources = conditionSourceFields.length > 0;
  const dangling = Boolean(
    conditional && !conditionSourceFields.some((field) => field.name === conditional.field)
  );

  if (conditional && access === 'unentitled') return 'readonly-rule';
  if (dangling) return hasSources ? 'repair-rule' : 'dangling-readonly';

  if (!hasSources) {
    return access === 'unentitled' ? 'prerequisite-upsell' : 'prerequisite';
  }

  return access === 'unentitled' ? 'upsell' : 'editor';
}
