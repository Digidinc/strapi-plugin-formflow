/* SPDX-License-Identifier: LicenseRef-FormFlow-EE — Commercial. See LICENSE-EE. Not covered by MIT. */

import { createTelegramConnectionService, type ConnectionDependencies } from './connection';

export const createTelegramService = (dependencies: ConnectionDependencies) =>
  createTelegramConnectionService(dependencies);

export * from './connection';
export * from './crypto';
