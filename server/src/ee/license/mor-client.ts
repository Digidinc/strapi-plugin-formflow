/* SPDX-License-Identifier: LicenseRef-FormFlow-EE — Commercial. See LICENSE-EE. Not covered by MIT. */

import type { Tier } from '../feature-map';

/**
 * Lemon Squeezy License API adapter. This file is the SOLE place where the HTTP
 * details for license activate/validate/deactivate live — the license service is
 * transport-agnostic and only ever sees the typed results below.
 */

/** Abort ordinary License API requests if Lemon Squeezy does not respond in time. */
const MOR_TIMEOUT_MS = 5000;

/** Activation is a cold-boot write and needs more time for DNS/TLS + processing. */
const ACTIVATE_TIMEOUT_MS = 15_000;

/** Lemon Squeezy License API base. */
const ENDPOINT = 'https://api.lemonsqueezy.com/v1/licenses';

export interface MorActivateParams {
  licenseKey: string;
  instanceName: string;
}

export interface MorActivateResult {
  instanceId: string;
  tier: Tier;
  validUntil: Date | null;
}

export interface MorValidateParams {
  licenseKey: string;
  instanceId?: string;
}

export interface MorValidateResult {
  valid: boolean;
  tier: Tier;
  validUntil: Date | null;
  status: string;
}

export interface MorDeactivateParams {
  licenseKey: string;
  instanceId: string;
}

/**
 * Public Freemius identifiers. These are plain identifiers that appear in every
 * checkout URL — NOT credentials, and safe to ship in the published package.
 */
export const FREEMIUS_PRODUCT_ID = 'PLACEHOLDER_PRODUCT_ID';
export const FREEMIUS_PRO_PLAN_ID = 'PLACEHOLDER_PRO_PLAN_ID';
export const FREEMIUS_BUSINESS_PLAN_ID = 'PLACEHOLDER_BUSINESS_PLAN_ID';

/** Freemius API base. */
export const ENDPOINT_BASE = 'https://api.freemius.com/v1';

/**
 * Freemius requires the client `uid` to be exactly 32 characters, and it must be
 * identical across activate/validate/deactivate for the same install. Our persisted
 * instance name is a 36-char hyphenated UUIDv4, so stripping the hyphens yields
 * exactly 32 hex chars. The service never learns about this encoding — it keeps
 * persisting and comparing the canonical UUID.
 */
export function toUid(instanceName?: string): string {
  return (instanceName ?? '').replace(/-/g, '');
}

const PLAN_TIER: Record<string, Tier> = {
  [FREEMIUS_PRO_PLAN_ID]: 'pro',
  [FREEMIUS_BUSINESS_PLAN_ID]: 'business',
};

/**
 * Map a Freemius numeric plan id to a plugin tier — used by validate(), where the
 * License object carries `plan_id`. Fails closed to 'free' for any unknown plan, so
 * an unrecognized id can never grant a paid tier.
 */
export function mapTier(planId: string | number | null | undefined): Tier {
  return PLAN_TIER[String(planId ?? '')] ?? 'free';
}

/**
 * Map a plan NAME to a plugin tier — used by activate(), whose response carries
 * `license_plan_name` but no `plan_id`. Never trust a client-supplied tier: the name
 * comes from the server response. `business` wins over `pro` when both appear.
 */
export function mapTierFromName(name: string | null | undefined): Tier {
  const v = (name ?? '').toLowerCase();
  if (v.includes('business')) return 'business';
  if (v.includes('pro')) return 'pro';
  return 'free';
}

/**
 * Freemius reports `expiration` as `Y-m-d H:i:s` in UTC. A naive `new Date(...)` on
 * that shape is interpreted in the HOST's timezone, which would mistime expiry by the
 * host offset — so the space is replaced with 'T' and an explicit 'Z' appended.
 * Strings that already carry a 'T'/'Z' are passed through untouched (appending would
 * produce an Invalid Date).
 */
export function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const d = /[TZ]/.test(value) ? new Date(value) : new Date(value.replace(' ', 'T') + 'Z');
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Outcome of a single License-API HTTP call. Distinguishes the three cases the
 * license grace logic depends on:
 *   - `ok`: a successful response with a parsed JSON body.
 *   - `client-error`: a definitive rejection — Freemius was reachable and is telling
 *     us the key/install is invalid/expired/utilized. Freemius reports these as an
 *     `error.code` in the body, frequently on an HTTP 200.
 *   - `connectivity`: a thrown fetch error, timeout/abort, 5xx, 408/429, HTTP 402,
 *     or a JSON parse failure — we could not get a definitive answer.
 */
export type MorOutcome =
  | { kind: 'ok'; json: any }
  | { kind: 'client-error'; code: string; message?: string }
  | { kind: 'connectivity' };

/**
 * Call a License-API endpoint with a hard abort timeout. Never throws; instead
 * returns a typed {@link MorOutcome} so callers can distinguish a definitive
 * rejection from a transient connectivity failure.
 *
 * The Freemius customer-portal license endpoints are unauthenticated — they are
 * keyed solely by the public product id, the customer's license key, and the client
 * uid — so this deliberately sends no credential header of any kind. Shipping a
 * seller secret in a package that runs on the customer's own server would be giving
 * it away; see `scripts/check-license-no-secret.mjs`, which enforces that mechanically.
 */
export async function morFetch(
  url: string,
  opts: { method: 'GET' | 'POST'; body?: Record<string, unknown>; timeoutMs?: number }
): Promise<MorOutcome> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), opts.timeoutMs ?? MOR_TIMEOUT_MS);

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };

  try {
    const response = await fetch(url, {
      method: opts.method,
      headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      signal: controller.signal,
    });

    // 402 reflects the SELLER's account state, not the customer's license; 408/429
    // and 5xx are transient. None of these are a verdict on the key, so they must
    // preserve a valid cached entitlement rather than hard-expire it.
    if (
      response.status === 402 ||
      response.status === 408 ||
      response.status === 429 ||
      response.status >= 500
    ) {
      console.warn(
        `[FormFlow License] License API request to ${url} returned HTTP ${response.status} — treating as unreachable.`
      );
      return { kind: 'connectivity' };
    }

    let json: any;
    try {
      json = await response.json();
    } catch {
      return { kind: 'connectivity' };
    }

    // Freemius signals definitive rejections in the body, often with HTTP 200.
    if (json?.error?.code) {
      return {
        kind: 'client-error',
        code: String(json.error.code),
        ...(json.error.message ? { message: String(json.error.message) } : {}),
      };
    }

    if (!response.ok) {
      return { kind: 'client-error', code: `http_${response.status}` };
    }

    return { kind: 'ok', json };
  } catch (error) {
    console.error(`[FormFlow License] License API request to ${url} failed:`, error);
    return { kind: 'connectivity' };
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Activate a license key against Freemius, binding it to this install's uid.
 * Returns the new install id and a best-effort tier, or `null` on any failure.
 *
 * Only the `instanceId` matters to the caller — `ensureActivated()` consumes just
 * that, and validate() is the authority on tier/expiry. Activate's response carries
 * `license_plan_name` but no `plan_id`/`expiration`, so the tier here is derived
 * from the plan name and `validUntil` is left null for validate to fill in.
 *
 * The `install_api_token` / `install_secret_key` / `user_secret_key` fields that
 * Freemius also returns are deliberately ignored — never persisted, logged, or sent.
 */
export async function activate(params: MorActivateParams): Promise<MorActivateResult | null> {
  const uid = toUid(params.instanceName);

  // Do not automatically retry this non-idempotent write: Freemius may allocate
  // another activation even when the first response was lost. The longer deadline
  // handles cold DNS/TLS without risking duplicate slots.
  const outcome = await morFetch(
    `${ENDPOINT_BASE}/products/${FREEMIUS_PRODUCT_ID}/licenses/activate.json`,
    {
      method: 'POST',
      body: { uid, license_key: params.licenseKey, title: uid },
      timeoutMs: ACTIVATE_TIMEOUT_MS,
    }
  );

  if (outcome.kind === 'ok') {
    const installId = outcome.json?.install_id;
    if (!installId) return null;
    return {
      instanceId: String(installId),
      tier: mapTierFromName(outcome.json.license_plan_name),
      validUntil: null,
    };
  }

  // The uid is already bound to an install we lost track of (e.g. the persisted
  // instance id was wiped but the activation still exists upstream). Recover the id
  // from the error message so validate() can proceed against the real install.
  if (outcome.kind === 'client-error' && outcome.code === 'license_activated' && outcome.message) {
    const match = /install\s+(\d+)/i.exec(outcome.message);
    if (match) {
      return { instanceId: match[1], tier: 'free', validUntil: null };
    }
  }

  // Any other failure falls through to validate(), whose missing-install-id guard
  // holds entitlement in grace rather than hard-expiring a possibly-valid key.
  return null;
}

/**
 * Validate a license key (optionally against a known instance id). Never throws.
 *
 * Returns `status: 'error'` ONLY for a genuine connectivity failure (network,
 * timeout/abort, 5xx, parse error) — the caller maps that to the grace window.
 *
 * A definitive 4xx from a reachable API (e.g. a deactivated/stale instance_id →
 * 404, or a malformed/unknown key → 400/403) resolves to `valid: false` with a
 * NON-'error' status (`not_found` / `invalid` / `disabled`) so the caller
 * hard-expires it immediately, with NO grace. A 2xx body is parsed as before:
 * `valid` requires `json.valid === true && license_key.status === 'active'`, so
 * a 200 reporting an inactive/expired key still hard-expires.
 *
 * `expires_at` is DELIBERATELY not enforced client-side: Lemon Squeezy flips
 * `status` to 'expired' itself when the expiry passes, and for subscriptions
 * `expires_at` can lag behind a renewal (dunning/retry windows) while the key is
 * still legitimately active — enforcing it here would wrongly cut off paying
 * customers. Status is the single source of truth.
 */
export async function validate(params: MorValidateParams): Promise<MorValidateResult> {
  const body: Record<string, unknown> = { license_key: params.licenseKey };
  if (params.instanceId) {
    body.instance_id = params.instanceId;
  }

  const outcome = await morFetch(`${ENDPOINT}/validate`, { method: 'POST', body });

  // (a) Connectivity failure: the ONLY case that yields 'error' → grace window.
  if (outcome.kind === 'connectivity') {
    return { valid: false, tier: 'free', validUntil: null, status: 'error' };
  }

  // (b) Definitive 4xx: API reachable and rejecting the key/instance. Hard-expire
  // via valid:false, but with a non-'error' status so it is NOT mistaken for a
  // connectivity loss. Map the HTTP status to a descriptive license status.
  if (outcome.kind === 'client-error') {
    const status =
      outcome.code === 'http_404' ? 'not_found' : outcome.code === 'http_403' ? 'disabled' : 'invalid';
    return { valid: false, tier: 'free', validUntil: null, status };
  }

  // (c) 2xx body: parse as before. `valid` requires an explicitly active key.
  const json = outcome.json;
  const status = String(json.license_key?.status ?? 'unknown');
  const valid = json.valid === true && status === 'active';

  return {
    valid,
    tier: mapTierFromName(json.meta?.variant_name),
    validUntil: parseDate(json.license_key?.expires_at),
    status,
  };
}

/**
 * Deactivate a license instance. Fire-and-forget: errors are logged, never
 * thrown, and there is no meaningful result for the caller to act on.
 */
export async function deactivate(params: MorDeactivateParams): Promise<void> {
  await morFetch(`${ENDPOINT}/deactivate`, {
    method: 'POST',
    body: {
      license_key: params.licenseKey,
      instance_id: params.instanceId,
    },
  });
}
