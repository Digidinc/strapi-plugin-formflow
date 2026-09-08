import type { Core } from '@strapi/strapi';

/**
 * Fire-and-forget telemetry helpers for request paths.
 *
 * Each call is wrapped so telemetry can never fail, slow, or change the request
 * that triggered it: the service itself only accumulates in memory and ships
 * on the next daily heartbeat, and a missing/disabled service is a no-op.
 *
 * Every `feature` string passed here comes from the plugin's own `FeatureKey`
 * vocabulary, never from user input — see `utils/telemetry-facts.ts`.
 */

const telemetry = (strapi: Core.Strapi): Record<string, (...args: never[]) => void> | null => {
  try {
    return strapi.plugin('formflow').service('telemetry');
  } catch {
    return null;
  }
};

/** A licensed feature was refused for this install. */
export const recordGateHit = (
  strapi: Core.Strapi,
  feature: string,
  requiredTier: 'pro' | 'business' = 'pro'
): void => {
  try {
    (
      telemetry(strapi) as { recordGateHit?: (f: string, t: string) => void } | null
    )?.recordGateHit?.(feature, requiredTier);
  } catch {
    // Never affects the response.
  }
};

/** Submissions were exported in the given format. */
export const recordExport = (strapi: Core.Strapi, format: string): void => {
  try {
    (telemetry(strapi) as { recordExport?: (f: string) => void } | null)?.recordExport?.(format);
  } catch {
    // Never affects the response.
  }
};

/** A form was created (forms are created already published). */
export const recordFormPublished = (
  strapi: Core.Strapi,
  fieldCount: number,
  hasMultistep: boolean,
  hasConditional: boolean
): void => {
  try {
    (
      telemetry(strapi) as {
        recordFormPublished?: (c: number, m: boolean, k: boolean) => void;
      } | null
    )?.recordFormPublished?.(fieldCount, hasMultistep, hasConditional);
  } catch {
    // Never affects the response.
  }
};
