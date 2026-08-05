/* SPDX-License-Identifier: LicenseRef-FormFlow-EE — Commercial. See LICENSE-EE. Not covered by MIT. */

import type { Tier } from '../feature-map';

/**
 * Freemius License API adapter. This file is the SOLE place where the HTTP details
 * for license activate/validate/deactivate live — the license service is
 * transport-agnostic and only ever sees the typed results below.
 */

/** Abort ordinary License API requests if Freemius does not respond in time. */
const MOR_TIMEOUT_MS = 5000;

/** Activation is a cold-boot write and needs more time for DNS/TLS + processing. */
const ACTIVATE_TIMEOUT_MS = 15_000;

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
  /** Source of the Freemius `uid`; required by validate, normalized via {@link toUid}. */
  instanceName: string;
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
  /** Required: Freemius keys deactivation on the same uid used to activate. */
  instanceName: string;
}

/**
 * Public Freemius identifiers. These are plain identifiers that appear in every
 * checkout URL — NOT credentials, and safe to ship in the published package.
 */
export const FREEMIUS_PRODUCT_ID = '34764';
export const FREEMIUS_PRO_PLAN_ID = '59829';
export const FREEMIUS_BUSINESS_PLAN_ID = '59830';
/**
 * Agency is a volume SKU, not an entitlement tier: it sells the Business feature
 * set with a larger activation quota, and that quota is enforced by Freemius
 * server-side. It therefore maps to the `business` tier, and `Tier` deliberately
 * stays 'free' | 'pro' | 'business' — an 'agency' tier would thread a fourth
 * column through the limit, feature and rank maps to express an entitlement
 * identical to Business.
 */
export const FREEMIUS_AGENCY_PLAN_ID = '60487';

/** Freemius API base. */
export const ENDPOINT_BASE = 'https://api.freemius.com/v1';

/**
 * Freemius requires the client `uid` to be exactly 32 characters, and it must be
 * identical across activate/validate/deactivate for the same install. Our persisted
 * instance name is a 36-char hyphenated UUIDv4, so stripping the hyphens yields
 * exactly 32 hex chars. The service never learns about this encoding — it keeps
 * persisting and comparing the canonical UUID.
 */
export function toUid(instanceName: string): string | null {
  const uid = instanceName.replace(/-/g, '').toLowerCase();
  return /^[0-9a-f]{32}$/.test(uid) ? uid : null;
}

const PLAN_TIER: Record<string, Tier> = {
  [FREEMIUS_PRO_PLAN_ID]: 'pro',
  [FREEMIUS_BUSINESS_PLAN_ID]: 'business',
  [FREEMIUS_AGENCY_PLAN_ID]: 'business',
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
 *
 * `agency` resolves to the `business` tier: Agency sells the Business feature set
 * with a larger activation quota, and quota is Freemius's to enforce, not ours.
 * It is matched before `pro` so a name like "Agency Pro" cannot be downgraded.
 */
export function mapTierFromName(name: string | null | undefined): Tier {
  const v = (name ?? '').toLowerCase();
  if (v.includes('business') || v.includes('agency')) return 'business';
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
 *   - `connectivity`: a thrown fetch error, timeout/abort, 5xx, 408/429, or a JSON
 *     parse failure — we could not get a definitive answer.
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

    // 408/429 and 5xx are transient. None of these are a verdict on the key, so they must
    // preserve a valid cached entitlement rather than hard-expire it.
    if (response.status === 408 || response.status === 429 || response.status >= 500) {
      console.warn(
        `[FormFlow License] License API returned HTTP ${response.status} — treating as unreachable.`
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
    // Never log the URL: validate requests carry the customer's license key in
    // their query string.
    console.error('[FormFlow License] License API request failed:', error);
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
  if (!uid) return null;

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

  // Say WHY activation was refused. Without this the caller only ever reports
  // "validation unreachable", which sends an admin who has simply run out of
  // activation slots off debugging their network. Log the code, never the upstream
  // message — messages are free text and must not become a way for the licence key
  // to reach the logs.
  if (outcome.kind === 'client-error') {
    const hint =
      outcome.code === 'license_utilized'
        ? ' — every activation slot for this key is in use. Deactivate the installation you no longer use from your account dashboard, then restart Strapi.'
        : '';
    console.warn(`[FormFlow License] Activation refused (${outcome.code})${hint || '.'}`);
  }

  // Any other failure falls through to validate(), whose missing-install-id guard
  // holds entitlement in grace rather than hard-expiring a possibly-valid key.
  return null;
}

/** Definitive Freemius rejections → a descriptive, NON-'error' status (hard-expire). */
const ERROR_STATUS: Record<string, string> = {
  invalid_license_key: 'invalid',
  license_expired: 'expired',
  license_utilized: 'utilized',
  license_error: 'invalid',
};

/** Indeterminate outcome: the caller serves the cached tier inside the grace window. */
const GRACE: MorValidateResult = { valid: false, tier: 'free', validUntil: null, status: 'error' };

/**
 * Validate a license key against its Freemius install. Never throws.
 *
 * Returns `status: 'error'` for every INDETERMINATE outcome — connectivity failure,
 * timeout, 5xx, a missing/invalid install identity, or any rejection code we do not
 * recognize — and the caller maps that to the grace window. Only a DOCUMENTED
 * rejection code resolves to `valid: false` with a non-'error' status, which makes
 * the caller hard-expire immediately with NO grace.
 *
 * The asymmetry is deliberate. A wrong 'error' costs at most 14 more days of access;
 * a wrong rejection cuts off a paying customer instantly. Fail-closed would also buy
 * no security here, since anyone wanting the grace path can simply block the licence
 * host — so unrecognized responses resolve to grace, not to revocation.
 *
 * Unlike the previous provider, Freemius returns no server-computed status, so the
 * expiry MUST be enforced here: `valid` requires no error code, `is_cancelled` not
 * true, and `now <= expiration`. Renewals extend `expiration`, so the residual risk
 * is a renewal still retrying past the old expiry — that is a definitive 'expired',
 * not a connectivity error, and the grace window deliberately does not cover it.
 */
export async function validate(params: MorValidateParams): Promise<MorValidateResult> {
  // An unknown install is NOT a revoked license. Without an install id Freemius
  // cannot validate at all, so this is indeterminate → grace, never a rejection.
  // This guard is what makes activate()'s `license_activated` recovery safe: a
  // failed recovery holds the cached tier instead of hard-expiring a valid key.
  // (With no cache the caller still lands on free, so no entitlement leaks.)
  const uid = toUid(params.instanceName);
  if (!uid) {
    // Distinguish this from a network failure: the caller logs every 'error' as
    // "validation unreachable", which would send anyone debugging this down the
    // wrong path entirely.
    console.warn(
      '[FormFlow License] Persisted instance name is not a UUID — cannot derive the install identity.'
    );
    return { ...GRACE };
  }
  if (!params.instanceId) {
    return { ...GRACE };
  }

  const query = new URLSearchParams({
    uid,
    license_key: params.licenseKey,
  });
  const outcome = await morFetch(
    `${ENDPOINT_BASE}/products/${FREEMIUS_PRODUCT_ID}/installs/${params.instanceId}/license.json?${query}`,
    { method: 'GET' }
  );

  if (outcome.kind === 'connectivity') {
    return { ...GRACE };
  }

  if (outcome.kind === 'client-error') {
    // Only the documented rejection codes are a verdict on the customer's key.
    // Anything else — a new upstream code, an argument error of ours, a
    // seller-account problem (Freemius reports several of these as HTTP 402) — says
    // nothing about the licence, so it must not revoke a paying customer. Grace is
    // the safe default and costs nothing: it never refreshes the cache, so it runs
    // out 14 days after the last SUCCESSFUL validation and then falls back to free.
    const status = ERROR_STATUS[outcome.code];
    if (!status) {
      console.warn(
        `[FormFlow License] Unrecognized licence API code "${outcome.code}" — treating as indeterminate, not as a revocation.`
      );
      return { ...GRACE };
    }
    return { valid: false, tier: 'free', validUntil: null, status };
  }

  const license = outcome.json ?? {};
  const tier = mapTier(license.plan_id);
  const validUntil = parseDate(license.expiration);

  if (license.is_cancelled === true) {
    return { valid: false, tier: 'free', validUntil, status: 'cancelled' };
  }
  if (validUntil !== null && new Date() > validUntil) {
    return { valid: false, tier: 'free', validUntil, status: 'expired' };
  }

  // Freemius uses a null expiration for lifetime licences, and FormFlow sells annual
  // subscriptions only — so a paid plan with no expiry must never grant premium
  // entitlement. Treat it as indeterminate rather than as a revocation: the response
  // is otherwise the server AFFIRMING the licence, and a missing/renamed/empty
  // `expiration` field would otherwise hard-expire every paying customer at once.
  // Grace still closes the hole, since it cannot outlive the 14-day window.
  if (tier !== 'free' && validUntil === null) {
    console.warn(
      '[FormFlow License] Paid plan returned with no expiration — not an annual subscription we sell; withholding premium entitlement.'
    );
    return { ...GRACE };
  }

  return { valid: true, tier, validUntil, status: 'active' };
}

/**
 * Deactivate a license instance. Fire-and-forget: errors are logged, never
 * thrown, and there is no meaningful result for the caller to act on.
 */
export async function deactivate(params: MorDeactivateParams): Promise<void> {
  const uid = toUid(params.instanceName);
  if (!uid) return;

  await morFetch(`${ENDPOINT_BASE}/products/${FREEMIUS_PRODUCT_ID}/licenses/deactivate.json`, {
    method: 'POST',
    body: {
      uid,
      install_id: params.instanceId,
      license_key: params.licenseKey,
    },
  });
}
