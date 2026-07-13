/* SPDX-License-Identifier: LicenseRef-FormFlow-EE — Commercial. See LICENSE-EE. Not covered by MIT. */
import { useContext } from 'react';

import { LicenseContext } from '../context/LicenseContext';

export { type LicenseContextValue } from '../context/LicenseContext';
export { type FeatureAccess, type LicenseResolution, type LicenseSnapshot } from '../license-state';

/**
 * Read the license context. Outside any `<LicenseProvider>` this returns the
 * unresolved sentinel (see {@link LicenseContext}) and never throws.
 */
export const useLicense = () => useContext(LicenseContext);
