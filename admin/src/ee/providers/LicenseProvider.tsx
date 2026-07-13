/* SPDX-License-Identifier: LicenseRef-FormFlow-EE — Commercial. See LICENSE-EE. Not covered by MIT. */
import { useCallback, useEffect, useRef, useState } from 'react';

import { useFetchClient } from '@strapi/strapi/admin';

import { PLUGIN_ID } from '../../pluginId';
import { LicenseContext, type LicenseContextValue } from '../context/LicenseContext';
import {
  featureAccess,
  parseLicenseSnapshot,
  retryDelay,
  type LicenseResolution,
  type LicenseSnapshot,
} from '../license-state';

const VERIFICATION_TIMEOUT_MS = 10_000;

function normalizeError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

function verificationTimeout(): Error {
  return new Error('License verification timed out after 10 seconds');
}

/**
 * Fetches and strictly parses the license snapshot. Checking responses are
 * polled for a bounded interval; manual refreshes share the same in-flight
 * request and preserve the last valid snapshot if a later request fails.
 */
const LicenseProvider = ({ children }: { children: React.ReactNode }) => {
  const { get } = useFetchClient();
  const [snapshot, setSnapshot] = useState<LicenseSnapshot | null>(null);
  const [resolution, setResolution] = useState<LicenseResolution>('checking');
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const mountedRef = useRef(false);
  const hasLoadedRef = useRef(false);
  const requestRef = useRef<Promise<void> | null>(null);

  const refresh = useCallback((): Promise<void> => {
    if (requestRef.current) return requestRef.current;

    if (mountedRef.current) {
      setResolution('checking');
      if (hasLoadedRef.current) setIsRefreshing(true);
    }

    const fetchUntilSettled = async (): Promise<LicenseSnapshot> => {
      let attempt = 0;
      let timedOut = false;
      let timeoutId: ReturnType<typeof setTimeout> | undefined;

      const timeout = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          timedOut = true;
          reject(verificationTimeout());
        }, VERIFICATION_TIMEOUT_MS);
      });

      const poll = async (): Promise<LicenseSnapshot> => {
        while (!timedOut) {
          const { data } = await get<unknown>(`/${PLUGIN_ID}/license`);
          if (timedOut) throw verificationTimeout();

          const next = parseLicenseSnapshot(data);
          if (next.resolution !== 'checking') return next;

          await new Promise<void>((resolve) => setTimeout(resolve, retryDelay(attempt++)));
        }

        throw verificationTimeout();
      };

      try {
        return await Promise.race([poll(), timeout]);
      } finally {
        if (timeoutId !== undefined) clearTimeout(timeoutId);
      }
    };

    const request = fetchUntilSettled()
      .then((next) => {
        if (!mountedRef.current) return;
        setSnapshot(next);
        setResolution(next.resolution);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (!mountedRef.current) return;
        setError(normalizeError(cause));
        setResolution('unavailable');
      })
      .finally(() => {
        requestRef.current = null;
        if (!mountedRef.current) return;
        hasLoadedRef.current = true;
        setIsLoading(false);
        setIsRefreshing(false);
      });

    requestRef.current = request;
    return request;
  }, [get]);

  useEffect(() => {
    mountedRef.current = true;
    void refresh();
    return () => {
      mountedRef.current = false;
    };
  }, [refresh]);

  const accessSnapshot: LicenseSnapshot | null =
    snapshot !== null
      ? { ...snapshot, resolution }
      : resolution === 'unavailable'
        ? {
            tier: 'free',
            state: 'free',
            resolution,
            graceUntil: null,
            features: {},
          }
        : null;
  const access: LicenseContextValue['access'] = (feature) => featureAccess(accessSnapshot, feature);

  const value: LicenseContextValue = {
    access,
    can: (feature) => access(feature) === 'entitled',
    tier: () => snapshot?.tier ?? 'free',
    state: () => snapshot?.state ?? 'free',
    resolution,
    graceUntil: () => snapshot?.graceUntil ?? null,
    isLoading,
    isRefreshing,
    error,
    refresh,
  };

  return <LicenseContext.Provider value={value}>{children}</LicenseContext.Provider>;
};

export { LicenseProvider };
