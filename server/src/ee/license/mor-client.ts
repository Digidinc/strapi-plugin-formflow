/* SPDX-License-Identifier: LicenseRef-FormFlow-EE — Commercial. See LICENSE-EE. Not covered by MIT. */

import type { Tier } from '../feature-map';

/**
 * Lemon Squeezy License API adapter. This file is the SOLE place where the HTTP
 * details for license activate/validate/deactivate live — the license service is
 * transport-agnostic and only ever sees the typed results below.
 */

/** Abort the request if Lemon Squeezy does not respond in time. */
const MOR_TIMEOUT_MS = 5000;

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
 * Map a Lemon Squeezy variant name to a plugin tier. Never trust a client-supplied
 * tier — the tier is derived purely from the purchased variant string returned by
 * Lemon Squeezy. `business` wins over `pro` when both substrings are present.
 */
function mapTier(variant: string | null | undefined): Tier {
  const v = (variant ?? '').toLowerCase();
  if (v.includes('business')) return 'business';
  if (v.includes('pro')) return 'pro';
  return 'free';
}

function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Outcome of a single License-API HTTP call. Distinguishes the three cases the
 * license grace logic depends on:
 *   - `ok`: a 2xx response with a parsed JSON body.
 *   - `client-error`: a definitive 4xx response — Lemon Squeezy was reachable and
 *     is telling us the key/instance is invalid/not-found/disabled. Request timeout
 *     and rate-limit responses are transient and therefore excluded.
 *   - `connectivity`: a thrown fetch error, timeout/abort, 5xx server error, or
 *     a JSON parse failure — we could not get a definitive answer.
 */
type MorOutcome =
  | { kind: 'ok'; json: any }
  | { kind: 'client-error'; httpStatus: number }
  | { kind: 'connectivity' };

/**
 * POST JSON to a License-API endpoint with a hard abort timeout. Never throws;
 * instead returns a typed {@link MorOutcome} so callers can distinguish a
 * definitive client-side rejection (4xx) from a transient connectivity failure
 * (network, abort, 5xx, parse error).
 */
async function morFetch(url: string, body: Record<string, unknown>): Promise<MorOutcome> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), MOR_TIMEOUT_MS);

  // The Lemon Squeezy License API (activate/validate/deactivate) is authenticated
  // SOLELY by the license key in the request body — it needs no seller token, so we
  // deliberately send NO Authorization header. (Reading a `LEMON_SQUEEZY_API_KEY`
  // from the host env was removed: a stray/foreign value — e.g. the host's own
  // Lemon Squeezy integration sharing that generic var name — would be attached as a
  // Bearer and could trigger a 401/403 that wrongly hard-expires a valid license.)
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      console.warn(
        `[FormFlow License] License API request to ${url} returned HTTP ${response.status}`
      );
      // Most 4xx responses are definitive key/instance rejections. HTTP 408 and
      // 429 are transient transport/capacity responses, just like a 5xx, and must
      // preserve any valid cached entitlement rather than hard-expire it.
      if (response.status === 408 || response.status === 429) {
        return { kind: 'connectivity' };
      }
      if (response.status >= 400 && response.status < 500) {
        return { kind: 'client-error', httpStatus: response.status };
      }
      return { kind: 'connectivity' };
    }

    return { kind: 'ok', json: await response.json() };
  } catch (error) {
    console.error(`[FormFlow License] License API request to ${url} failed:`, error);
    return { kind: 'connectivity' };
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Activate a license key against Lemon Squeezy, binding it to an instance name.
 * Returns the new instance id and resolved tier, or `null` on any failure.
 */
export async function activate(params: MorActivateParams): Promise<MorActivateResult | null> {
  const outcome = await morFetch(`${ENDPOINT}/activate`, {
    license_key: params.licenseKey,
    instance_name: params.instanceName,
  });

  // Activation only succeeds on a 2xx body that confirms activation. Any
  // connectivity failure OR definitive client-error is a failed activation.
  if (outcome.kind !== 'ok') {
    return null;
  }
  const json = outcome.json;

  if (json.activated !== true || !json.instance?.id) {
    return null;
  }

  return {
    instanceId: String(json.instance.id),
    tier: mapTier(json.meta?.variant_name),
    validUntil: parseDate(json.license_key?.expires_at),
  };
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

  const outcome = await morFetch(`${ENDPOINT}/validate`, body);

  // (a) Connectivity failure: the ONLY case that yields 'error' → grace window.
  if (outcome.kind === 'connectivity') {
    return { valid: false, tier: 'free', validUntil: null, status: 'error' };
  }

  // (b) Definitive 4xx: API reachable and rejecting the key/instance. Hard-expire
  // via valid:false, but with a non-'error' status so it is NOT mistaken for a
  // connectivity loss. Map the HTTP status to a descriptive license status.
  if (outcome.kind === 'client-error') {
    const status =
      outcome.httpStatus === 404
        ? 'not_found'
        : outcome.httpStatus === 403
          ? 'disabled'
          : 'invalid';
    return { valid: false, tier: 'free', validUntil: null, status };
  }

  // (c) 2xx body: parse as before. `valid` requires an explicitly active key.
  const json = outcome.json;
  const status = String(json.license_key?.status ?? 'unknown');
  const valid = json.valid === true && status === 'active';

  return {
    valid,
    tier: mapTier(json.meta?.variant_name),
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
    license_key: params.licenseKey,
    instance_id: params.instanceId,
  });
}
