import type { Core } from '@strapi/strapi';

/**
 * License state machine value. `free` covers both "no key configured" and a
 * stripped fork where the EE implementation is absent.
 */
export type LicenseState = 'active' | 'grace' | 'expired' | 'free';
export type LicenseResolution = 'checking' | 'resolved' | 'unavailable';

/** Effective entitlement tier (collapsed to `free` when expired). */
export type LicenseTier = 'free' | 'pro' | 'business';

/**
 * JSON-safe license snapshot for the admin `/license` route. Distinct from the
 * EE `LicenseSnapshot` whose `graceUntil` is a `Date` — the wrapper serializes
 * it to an ISO string before returning.
 */
export interface LicenseSnapshot {
  tier: LicenseTier;
  state: LicenseState;
  resolution: LicenseResolution;
  graceUntil: string | null;
  features: Record<string, boolean>;
}

export interface LicenseService {
  init(): Promise<void>;
  destroy(): void;
  refresh(): Promise<void>;
  whenReady(): Promise<void>;
  resolution(): LicenseResolution;
  can(feature: string): boolean;
  tier(): LicenseTier;
  state(): LicenseState;
  snapshot(): LicenseSnapshot;
}

/**
 * The slice of the EE license service the wrapper delegates to. Kept loose so
 * the wrapper never statically imports EE types (which would defeat the
 * stripped-fork fallback).
 */
interface EeLicenseInstance {
  init(): Promise<void>;
  destroy(): void;
  refresh(): Promise<void>;
  whenReady(): Promise<void>;
  resolution(): LicenseResolution;
  can(feature: string): boolean;
  tier(): LicenseTier;
  state(): LicenseState;
  snapshot(): {
    tier: LicenseTier;
    state: LicenseState;
    resolution: LicenseResolution;
    graceUntil: Date | null;
    features: Record<string, boolean>;
  };
}

const FREE_SNAPSHOT: LicenseSnapshot = {
  tier: 'free',
  state: 'free',
  resolution: 'resolved',
  graceUntil: null,
  features: {},
};

/**
 * Thin MIT wrapper around the premium (`ee/`) license engine. It lazily imports
 * the EE implementation the first time the service initializes: if the EE
 * module is present it delegates every call to it; if it is absent (stripped
 * MIT fork) the import is caught and the wrapper degrades to a free-only stub.
 * No method ever throws — licensing must not block plugin load or requests.
 */
const licenseService = ({ strapi }: { strapi: Core.Strapi }): LicenseService => {
  let eeImpl: EeLicenseInstance | null = null;
  let loaded = false;

  // Dynamic, never top-level: a missing `ee/license/service` (stripped fork)
  // throws MODULE_NOT_FOUND here, which we swallow to fall back to the stub.
  async function loadEE(): Promise<void> {
    if (loaded) return;
    loaded = true;
    try {
      const mod = await import('../ee/license/service');
      eeImpl = mod.createLicenseService(strapi) as EeLicenseInstance;
    } catch {
      eeImpl = null;
    }
  }

  return {
    async init(): Promise<void> {
      await loadEE();
      if (eeImpl) await eeImpl.init();
    },

    destroy(): void {
      if (eeImpl) eeImpl.destroy();
    },

    async refresh(): Promise<void> {
      if (eeImpl) await eeImpl.refresh();
    },

    whenReady(): Promise<void> {
      return eeImpl ? eeImpl.whenReady() : Promise.resolve();
    },

    resolution(): LicenseResolution {
      return eeImpl ? eeImpl.resolution() : 'resolved';
    },

    can(feature: string): boolean {
      return eeImpl ? eeImpl.can(feature) : false;
    },

    tier(): LicenseTier {
      return eeImpl ? eeImpl.tier() : 'free';
    },

    state(): LicenseState {
      return eeImpl ? eeImpl.state() : 'free';
    },

    snapshot(): LicenseSnapshot {
      if (!eeImpl) return { ...FREE_SNAPSHOT };
      const snap = eeImpl.snapshot();
      return {
        tier: snap.tier,
        state: snap.state,
        resolution: snap.resolution,
        graceUntil:
          snap.graceUntil instanceof Date ? snap.graceUntil.toISOString() : snap.graceUntil,
        features: snap.features,
      };
    },
  };
};

export default licenseService;
