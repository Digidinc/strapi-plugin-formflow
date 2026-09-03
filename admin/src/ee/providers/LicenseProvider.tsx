/* SPDX-License-Identifier: LicenseRef-FormFlow-EE — Commercial. See LICENSE-EE. Not covered by MIT. */
import { useCallback, useEffect, useRef, useState } from 'react';

import { useFetchClient } from '@strapi/strapi/admin';

import { PLUGIN_ID } from '../../pluginId';
import { LicenseContext, type LicenseContextValue } from '../context/LicenseContext';
import {
  featureAccess,
  parseLicenseSnapshot,
  refreshFailureResolution,
  refreshStartResolution,
  retryDelay,
  type LicenseResolution,
  type LicenseSnapshot,
} from '../license-state';

const VERIFICATION_TIMEOUT_MS = 10_000;

/**
 * Last snapshot the server settled on during this browser session.
 *
 * Each menu link is a sibling route mount, so moving between FormFlow pages
 * unmounts and remounts this provider. Seeding from here keeps already-resolved
 * access stable instead of regressing to `checking` on every navigation, which
 * would flash the status notice and briefly disable premium controls.
 *
 * This is the cross-mount form of the guarantee `refreshStartResolution` already
 * makes within a single mount. It is memory-only — never persisted, and dropped
 * on reload.
 *
 * Its optimism is bounded by the mount's own request: a seeded mount whose first
 * fetch fails falls back to `unavailable` rather than presenting entitlement it
 * never confirmed. The server gates every premium action independently in any
 * case, so the seed is a display decision, not an authorisation one.
 */
let lastSettledSnapshot: LicenseSnapshot | null = null;

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
  const { get, post } = useFetchClient();
  const [snapshot, setSnapshot] = useState<LicenseSnapshot | null>(lastSettledSnapshot);
  const [resolution, setResolution] = useState<LicenseResolution>(
    lastSettledSnapshot?.resolution ?? 'checking'
  );
  const [isLoading, setIsLoading] = useState(lastSettledSnapshot === null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const mountedRef = useRef(false);
  const hasLoadedRef = useRef(false);
  /** Whether a request in *this* mount has come back, as opposed to the seed. */
  const confirmedRef = useRef(false);
  const requestRef = useRef<Promise<void> | null>(null);

  const runRequest = useCallback(
    (mode: 'snapshot' | 'remote'): Promise<void> => {
      if (requestRef.current) return requestRef.current;

      if (mountedRef.current) {
        setResolution((current) => refreshStartResolution(current));
        if (hasLoadedRef.current) setIsRefreshing(true);
      }

      const fetchSnapshot = async (): Promise<LicenseSnapshot> => {
        const { data } = await get<unknown>(`/${PLUGIN_ID}/license`);
        return parseLicenseSnapshot(data);
      };

      const fetchUntilSettled = async (
        firstSnapshot: LicenseSnapshot
      ): Promise<LicenseSnapshot> => {
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
          let next = firstSnapshot;
          while (!timedOut) {
            if (next.resolution !== 'checking') return next;

            await new Promise<void>((resolve) => setTimeout(resolve, retryDelay(attempt++)));
            next = await fetchSnapshot();
            if (timedOut) throw verificationTimeout();
          }

          throw verificationTimeout();
        };

        try {
          return await Promise.race([poll(), timeout]);
        } finally {
          if (timeoutId !== undefined) clearTimeout(timeoutId);
        }
      };

      const request = (async () => {
        const firstSnapshot =
          mode === 'remote'
            ? parseLicenseSnapshot((await post<unknown>(`/${PLUGIN_ID}/license/refresh`)).data)
            : await fetchSnapshot();

        return firstSnapshot.resolution === 'checking'
          ? fetchUntilSettled(firstSnapshot)
          : firstSnapshot;
      })()
        .then((next) => {
          lastSettledSnapshot = next;
          confirmedRef.current = true;
          if (!mountedRef.current) return;
          setSnapshot(next);
          setResolution(next.resolution);
          setError(null);
        })
        .catch((cause: unknown) => {
          if (!mountedRef.current) return;
          setError(normalizeError(cause));
          // Retaining last-known access applies to a *replacement* that failed.
          // A seeded mount that has confirmed nothing of its own has no such
          // access to retain, so it degrades and raises the warning instead of
          // silently presenting a stale entitlement.
          setResolution((current) =>
            confirmedRef.current ? refreshFailureResolution(current) : 'unavailable'
          );
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
    },
    [get, post]
  );

  const refresh = useCallback(() => runRequest('remote'), [runRequest]);

  useEffect(() => {
    mountedRef.current = true;
    void runRequest('snapshot');
    return () => {
      mountedRef.current = false;
    };
  }, [runRequest]);

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
            limits: { telegramConnections: 0 },
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
