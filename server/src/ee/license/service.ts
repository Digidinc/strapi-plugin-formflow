/* SPDX-License-Identifier: LicenseRef-FormFlow-EE — Commercial. See LICENSE-EE. Not covered by MIT. */

import { createHash, randomUUID } from 'node:crypto';

import type { Core } from '@strapi/strapi';

import {
  FEATURE_TIER,
  TIER_RANK,
  limitForTier,
  type EntitlementLimit,
  type FeatureKey,
  type LimitKey,
  type Tier,
} from '../feature-map';
import * as morClient from './mor-client';

const PLUGIN_CONFIG_ID = 'plugin::formflow';
const STORE_PARAMS = { type: 'plugin', name: 'formflow' } as const;
const CACHE_KEY = 'license-cache';
const INSTANCE_ID_KEY = 'license-instance-id';
const INSTANCE_NAME_KEY = 'license-instance-name';
// sha256 of the configured key — lets us detect a key change (Pro→Business or a
// regenerated key) across boots WITHOUT ever persisting the raw key.
const KEY_HASH_KEY = 'license-key-hash';
// Connectivity-failure grace window, in days. Intentionally a FIXED constant and
// NOT customer-configurable: the plugin runs in the customer's own environment, so
// any env var (e.g. a `FORMFLOW_LICENSE_GRACE_DAYS`) would let a customer set an
// arbitrarily large window and then block the license API to run Pro/Business
// indefinitely without a valid key. Changing this value requires editing this
// EE file, which is a license violation and forces a rebuild.
const GRACE_DAYS = 14;
const DAY_MS = 86_400_000;

/** Plugin license configuration block read from `strapi.config`. */
interface LicenseConfig {
  license?: {
    key?: string;
  };
}

/**
 * Persisted validation cache. `graceUntil` is computed at the moment of a
 * *successful* validation (lastValidatedAt + GRACE_DAYS) so that a process
 * restart during an outage does not reset the connectivity grace window.
 */
export interface LicenseCache {
  tier: Tier;
  status: string;
  validUntil: Date | null;
  lastValidatedAt: Date;
  graceUntil: Date;
}

export type LicenseState = 'active' | 'grace' | 'expired' | 'free';
export type LicenseResolution = 'checking' | 'resolved' | 'unavailable';

export interface LicenseSnapshot {
  tier: Tier; // effective (collapsed to 'free' when expired)
  state: LicenseState;
  resolution: LicenseResolution;
  graceUntil: Date | null;
  features: Record<FeatureKey, boolean>;
  limits: Record<LimitKey, EntitlementLimit>;
}

export interface LicenseService {
  init(): Promise<void>;
  destroy(): void;
  refresh(): Promise<void>;
  startFallbackScheduler(onRefreshed: () => Promise<void>): void;
  whenReady(): Promise<void>;
  resolution(): LicenseResolution;
  tier(): Tier;
  state(): LicenseState;
  can(feature: FeatureKey): boolean;
  limit(key: LimitKey): EntitlementLimit;
  snapshot(): LicenseSnapshot;
}

export interface LicenseDependencies {
  activate: typeof morClient.activate;
  validate: typeof morClient.validate;
  now: () => Date;
}

const DEFAULT_DEPENDENCIES: LicenseDependencies = {
  activate: morClient.activate,
  validate: morClient.validate,
  now: () => new Date(),
};

/**
 * EE license validation engine. Holds the in-memory entitlement state, drives
 * the validate→cache→grace state machine against the MoR adapter, and persists
 * the cache so grace survives restarts. Every public method is non-throwing so
 * plugin load and request handling are never blocked by licensing.
 */
export function createLicenseService(
  strapi: Core.Strapi,
  dependencies: LicenseDependencies = DEFAULT_DEPENDENCIES
): LicenseService {
  let _cache: LicenseCache | null = null;
  let _state: LicenseState = 'free';
  let _tier: Tier = 'free';
  let _resolution: LicenseResolution = 'resolved';
  let _refreshInFlight: Promise<void> | null = null;
  let _initialResolution: Promise<void> = Promise.resolve();
  let _refreshTimer: ReturnType<typeof setInterval> | null = null;
  let _instanceId: string | null = null;

  function readConfig(): LicenseConfig {
    return strapi.config.get(PLUGIN_CONFIG_ID, {}) as LicenseConfig;
  }

  function readLicenseKey(): string {
    return readConfig().license?.key ?? '';
  }

  /** sha256 hex of the configured key — persisted instead of the raw key. */
  function hashKey(licenseKey: string): string {
    return createHash('sha256').update(licenseKey).digest('hex');
  }

  function store() {
    return strapi.store(STORE_PARAMS);
  }

  async function persistCache(cache: LicenseCache): Promise<void> {
    await store().set({
      key: CACHE_KEY,
      value: {
        tier: cache.tier,
        status: cache.status,
        validUntil: cache.validUntil ? cache.validUntil.toISOString() : null,
        lastValidatedAt: cache.lastValidatedAt.toISOString(),
        graceUntil: cache.graceUntil.toISOString(),
      },
    });
  }

  function hasUsableCache(now: Date): boolean {
    return _cache !== null && now <= _cache.graceUntil;
  }

  function can(feature: FeatureKey): boolean {
    if (FEATURE_TIER[feature] !== 'free' && !hasUsableCache(dependencies.now())) {
      return false;
    }
    return TIER_RANK[_tier] >= TIER_RANK[FEATURE_TIER[feature]];
  }

  function limit(key: LimitKey): EntitlementLimit {
    return limitForTier(effectiveState().tier, key);
  }

  /**
   * Resolve a STABLE instance name for this installation, persisting it on first
   * use so every boot reuses the same activation binding instead of consuming a
   * fresh activation slot. Never throws — falls back to a transient UUID if the
   * store is unavailable.
   */
  async function resolveInstanceName(): Promise<string> {
    try {
      const existing = (await store().get({ key: INSTANCE_NAME_KEY })) as string | null;
      if (existing) return existing;
      const name = randomUUID();
      await store().set({ key: INSTANCE_NAME_KEY, value: name });
      return name;
    } catch (error) {
      strapi.log.warn('[FormFlow License] Failed to persist instance name:', error);
      return randomUUID();
    }
  }

  /**
   * Activate the license key on first boot. A freshly purchased key is 'inactive'
   * until activated; activation flips it to 'active' so the subsequent validate()
   * resolves the tier. Idempotent: once we hold a persisted instance id we skip
   * activation entirely. Never throws and never blocks — any failure (network,
   * already-activated, activation-limit reached, parse error) falls through to
   * validate(), which may still succeed if the key was activated previously.
   */
  async function ensureActivated(licenseKey: string): Promise<void> {
    if (_instanceId) return;
    try {
      const result = await dependencies.activate({
        licenseKey,
        instanceName: await resolveInstanceName(),
      });
      if (result) {
        _instanceId = result.instanceId;
        await store().set({ key: INSTANCE_ID_KEY, value: result.instanceId });
        // Bind the persisted hash to the key we just activated, so a same-key
        // reboot matches and skips the reset path in init().
        await store().set({ key: KEY_HASH_KEY, value: hashKey(licenseKey) });
        strapi.log.info('[FormFlow License] License key activated.');
      }
    } catch (error) {
      strapi.log.warn(
        '[FormFlow License] Activation attempt failed — proceeding to validate:',
        error
      );
    }
  }

  async function performRefresh(): Promise<void> {
    let reachedTerminalResult = false;

    try {
      const licenseKey = readLicenseKey();
      if (!licenseKey) {
        _tier = 'free';
        _state = 'free';
        _resolution = 'resolved';
        reachedTerminalResult = true;
        return;
      }

      // Ensure the key is activated before validating: an un-activated key reports
      // status 'inactive' and would otherwise map to free.
      await ensureActivated(licenseKey);

      const result = await dependencies.validate({
        licenseKey,
        instanceId: _instanceId ?? undefined,
        // The MoR keys validation on the instance uid as well as the instance id;
        // the adapter owns the encoding, so this stays the canonical UUID.
        instanceName: await resolveInstanceName(),
      });

      // Connectivity / parse failure: fall back to the cached entitlement for the
      // duration of the grace window. Never overwrite the stored cache here so the
      // grace window keeps counting from the last successful validation.
      if (result.status === 'error') {
        const now = dependencies.now();
        if (hasUsableCache(now)) {
          _tier = _cache!.tier;
          _state = 'grace';
          _resolution = 'resolved';
          strapi.log.info(
            '[FormFlow License] Validation unreachable — serving cached entitlement within grace period.'
          );
        } else {
          _tier = 'free';
          _state = _cache === null ? 'free' : 'expired';
          _resolution = 'unavailable';
          if (_cache === null) {
            strapi.log.warn(
              '[FormFlow License] Validation unreachable and no prior cache — running as free tier.'
            );
          } else {
            strapi.log.warn(
              '[FormFlow License] Validation unreachable and grace period elapsed — entitlements expired.'
            );
          }
        }
        reachedTerminalResult = true;
        return;
      }

      // Explicit revocation/expiry (refunded/disabled/expired/inactive): hard-expire
      // immediately, bypassing the connectivity grace window entirely.
      if (!result.valid) {
        _tier = 'free';
        _state = 'expired';
        _resolution = 'resolved';
        reachedTerminalResult = true;
        const now = dependencies.now();
        _cache = {
          tier: 'free',
          status: result.status,
          validUntil: result.validUntil,
          lastValidatedAt: now,
          graceUntil: now,
        };
        await persistCache(_cache);
        strapi.log.warn(
          '[FormFlow License] Key is revoked/expired — hard-expiring immediately, no grace period.'
        );
        return;
      }

      // Successful validation: refresh the cache, compute a fresh grace window, and
      // mark the license active. Entitlement is granted BEFORE the store writes so
      // a transient persistence failure never withholds a validly-licensed tier
      // (the persisted cache only matters for grace across restarts).
      const now = dependencies.now();
      _cache = {
        tier: result.tier,
        status: result.status,
        validUntil: result.validUntil,
        lastValidatedAt: now,
        graceUntil: new Date(now.getTime() + GRACE_DAYS * DAY_MS),
      };
      _tier = result.tier;
      _state = 'active';
      _resolution = 'resolved';
      reachedTerminalResult = true;
      await persistCache(_cache);
      // Persist the key hash on a successful validation too: the key may have been
      // activated on a previous boot (so ensureActivated short-circuited) — this
      // guarantees a same-key reboot matches and avoids a needless reset.
      await store().set({ key: KEY_HASH_KEY, value: hashKey(licenseKey) });
    } catch (error) {
      if (!reachedTerminalResult) {
        const now = dependencies.now();
        if (hasUsableCache(now)) {
          _tier = _cache!.tier;
          _state = 'grace';
          _resolution = 'resolved';
        } else {
          _tier = 'free';
          _state = _cache === null ? 'free' : 'expired';
          _resolution = 'unavailable';
        }
      }
      strapi.log.warn('[FormFlow License] Unexpected error during refresh:', error);
    }
  }

  function refresh(): Promise<void> {
    if (_refreshInFlight) return _refreshInFlight;

    if (readLicenseKey() && !hasUsableCache(dependencies.now())) {
      _resolution = 'checking';
    }

    _refreshInFlight = performRefresh().finally(() => {
      _refreshInFlight = null;
    });

    return _refreshInFlight;
  }

  async function init(): Promise<void> {
    try {
      const licenseKey = readLicenseKey();
      if (!licenseKey) {
        _tier = 'free';
        _state = 'free';
        _resolution = 'resolved';
        _initialResolution = Promise.resolve();
        return;
      }

      // Detect a CHANGED key. The persisted instance-id is bound to whatever key
      // was last activated; if the configured key is now different (Pro→Business
      // upgrade or a regenerated key), validating the NEW key against the OLD
      // instance-id makes the MoR return 404 → the revocation path would wrongly
      // hard-expire a perfectly valid key. So a mismatch is a NEW key, NOT a
      // revocation: drop the stale binding/cache so activate-on-first-boot runs
      // fresh for the new key. A genuine revocation of the SAME key keeps the
      // binding and is hard-expired by refresh() as before.
      let keyChanged = false;
      try {
        const persistedHash = (await store().get({ key: KEY_HASH_KEY })) as string | null;
        const currentHash = hashKey(licenseKey);
        const hasStaleBinding =
          !!(await store().get({ key: INSTANCE_ID_KEY })) ||
          !!(await store().get({ key: CACHE_KEY }));
        // Mismatch, or no hash recorded yet while a stale binding/cache exists
        // (e.g. upgraded from a build that predated key-hash persistence).
        keyChanged = persistedHash ? persistedHash !== currentHash : hasStaleBinding;
      } catch (error) {
        strapi.log.warn('[FormFlow License] Failed to read persisted key hash:', error);
      }

      if (keyChanged) {
        try {
          await store().delete({ key: INSTANCE_ID_KEY });
          await store().delete({ key: INSTANCE_NAME_KEY });
          await store().delete({ key: CACHE_KEY });
        } catch (error) {
          strapi.log.warn('[FormFlow License] Failed to clear stale license binding:', error);
        }
        _instanceId = null;
        _cache = null;
        strapi.log.info(
          '[FormFlow License] Configured license key changed — reset stale binding; re-activating for the new key.'
        );
      } else {
        // Same key: rehydrate the persisted cache so grace state survives a restart.
        try {
          const raw = (await store().get({ key: CACHE_KEY })) as Record<string, any> | null;
          if (raw) {
            _cache = {
              tier: raw.tier,
              status: raw.status,
              validUntil: raw.validUntil ? new Date(raw.validUntil) : null,
              lastValidatedAt: new Date(raw.lastValidatedAt),
              graceUntil: new Date(raw.graceUntil),
            };
          }

          const instanceId = (await store().get({ key: INSTANCE_ID_KEY })) as string | null;
          if (instanceId) {
            _instanceId = instanceId;
          }
        } catch (error) {
          strapi.log.warn('[FormFlow License] Failed to load persisted cache:', error);
        }
      }

      // Apply the last-known entitlement SYNCHRONOUSLY from the rehydrated cache so
      // boot-time gate reads (e.g. bootstrap's retention cron and scheduled-export
      // rehydration, which run after this awaited init) see the real tier without
      // waiting for the async refresh below. Mirrors refresh()'s state machine:
      // within the grace window we serve the cached tier; once it has elapsed we
      // grant nothing. The async refresh() still runs and corrects/hard-expires
      // shortly after — it remains the authority.
      const now = dependencies.now();
      if (_cache !== null) {
        if (hasUsableCache(now)) {
          _tier = _cache.tier;
          // 'active' while the license's own validity still holds; otherwise we are
          // running on connectivity grace. A hard-expired cache has tier 'free' and
          // graceUntil === lastValidatedAt, so it falls into the elapsed branch below.
          _state = _cache.validUntil === null || now <= _cache.validUntil ? 'active' : 'grace';
        } else {
          _tier = 'free';
          _state = 'expired';
        }
      }

      // Fire-and-forget the first validation so plugin load is never blocked.
      _resolution = hasUsableCache(now) ? 'resolved' : 'checking';
      _initialResolution = refresh();
    } catch (error) {
      const now = dependencies.now();
      if (hasUsableCache(now)) {
        _tier = _cache!.tier;
        _state = 'grace';
        _resolution = 'resolved';
      } else {
        _tier = 'free';
        _state = _cache === null ? 'free' : 'expired';
        _resolution = 'unavailable';
      }
      _initialResolution = Promise.resolve();
      strapi.log.warn('[FormFlow License] init failed:', error);
    }
  }

  function startFallbackScheduler(onRefreshed: () => Promise<void>): void {
    if (_refreshTimer !== null || !readLicenseKey()) {
      return;
    }

    _refreshTimer = setInterval(() => {
      refresh()
        .then(onRefreshed)
        .catch((err) => strapi.log.warn('[FormFlow License] Scheduled validation failed:', err));
    }, DAY_MS);
    // Never keep the process alive just for license refresh (one-off CLI runs
    // may load the plugin without ever invoking the destroy hook).
    _refreshTimer.unref?.();
  }

  function destroy(): void {
    if (_refreshTimer !== null) {
      clearInterval(_refreshTimer);
      _refreshTimer = null;
    }
  }

  function effectiveState(): Pick<LicenseSnapshot, 'tier' | 'state' | 'resolution'> {
    const graceElapsed =
      _tier !== 'free' &&
      _cache !== null &&
      _cache.tier !== 'free' &&
      !hasUsableCache(dependencies.now());

    if (!graceElapsed) {
      return { tier: _tier, state: _state, resolution: _resolution };
    }

    return {
      tier: 'free',
      state: 'expired',
      resolution: _resolution === 'checking' ? 'checking' : 'unavailable',
    };
  }

  function snapshot(): LicenseSnapshot {
    const effective = effectiveState();
    return {
      ...effective,
      graceUntil: _cache?.graceUntil ?? null,
      features: Object.fromEntries(
        (Object.keys(FEATURE_TIER) as FeatureKey[]).map((f) => [f, can(f)])
      ) as Record<FeatureKey, boolean>,
      limits: { telegramConnections: limit('telegramConnections') },
    };
  }

  return {
    init,
    destroy,
    refresh,
    startFallbackScheduler,
    whenReady: () => _initialResolution,
    resolution: () => effectiveState().resolution,
    tier: () => effectiveState().tier,
    state: () => effectiveState().state,
    can,
    limit,
    snapshot,
  };
}
