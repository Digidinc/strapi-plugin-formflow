/* SPDX-License-Identifier: LicenseRef-FormFlow-EE — Commercial. See LICENSE-EE. Not covered by MIT. */

type StrapiFetchError = {
  status?: number;
  response?: {
    status?: number;
    data?: {
      error?: {
        status?: number;
      };
    };
  };
};

/** Refresh the license snapshot after an authoritative server-side 402. */
export const refreshLicenseOnPaymentRequired = async (
  error: unknown,
  refresh: () => Promise<void>
): Promise<boolean> => {
  const fetchError = error as StrapiFetchError | null;
  const status =
    fetchError?.response?.data?.error?.status ?? fetchError?.response?.status ?? fetchError?.status;

  if (status !== 402) {
    return false;
  }

  await refresh();
  return true;
};
