import type { Core } from '@strapi/strapi';
import { createHash } from 'node:crypto';

import { version as PLUGIN_VERSION } from '../../../package.json';
import { bucketCount, collectFacts } from '../utils/telemetry-facts';

/**
 * Anonymous, opt-out usage telemetry.
 *
 * Sends events to a FormFlow-owned Cloudflare Worker, which forwards them to
 * analytics (PostHog). The Worker URL is the ONLY endpoint the plugin knows —
 * the analytics credentials live as Worker secrets, so the backend can be
 * rotated or swapped without republishing the plugin.
 *
 * Privacy:
 * - No PII is ever sent. The `distinct_id` is a SHA-256 hash of the Strapi
 *   project UUID (a random value), so installs can be counted without exposing
 *   the raw project id. Every reported value comes from a vocabulary the plugin
 *   itself authors — see `utils/telemetry-facts.ts` for the enforced rule.
 * - Telemetry is fully opt-out and mirrors Strapi's own opt-out exactly: if the
 *   host disabled Strapi telemetry (no `uuid`, `STRAPI_TELEMETRY_DISABLED`, or
 *   `strapi.telemetryDisabled` in package.json), this stays silent too. A
 *   dedicated `FORMFLOW_TELEMETRY_DISABLED` env var disables only this.
 * - Every send is fire-and-forget with a short timeout and never throws, so a
 *   slow or unreachable endpoint can never affect plugin boot or requests.
 *
 * Volume:
 * - Activity events are NOT sent as they happen. They accumulate in a local
 *   outbox (aggregated by kind, with a count) and ship in ONE batched request
 *   alongside the daily heartbeat. A busy install therefore costs about one
 *   request and a handful of analytics events per day, which keeps the whole
 *   fleet comfortably inside a free analytics tier.
 */

/** FormFlow-owned ingestion Worker. Hardcoded by design (see module docs). */
const TELEMETRY_ENDPOINT = 'https://formflow-telemetry.lo-agency.workers.dev';

/**
 * Payload schema version. Bump when the property set changes meaningfully so
 * historical analytics queries can tell old shapes from new ones.
 */
const TELEMETRY_SCHEMA_VERSION = 2;

/** Abort a single ping attempt if the endpoint doesn't respond quickly. */
const REQUEST_TIMEOUT_MS = 3000;

/**
 * Retry transient send failures. The very first outbound request from a fresh
 * Node process (cold DNS/TLS/worker) can fail where the next succeeds, so a
 * couple of retries materially improve delivery of the one-shot install event.
 */
const MAX_SEND_ATTEMPTS = 3;
const RETRY_DELAY_MS = 1000;

/**
 * Minimum gap between boot-triggered heartbeats. Prevents dev restarts from
 * sending a heartbeat on every reload while still capturing active installs.
 */
const HEARTBEAT_THROTTLE_MS = 20 * 60 * 60 * 1000; // 20 hours

/**
 * Upper bound on distinct queued activity kinds. Entries aggregate by key, so
 * this is only reached by genuinely diverse activity, never by volume.
 */
const OUTBOX_MAX_ENTRIES = 50;

/**
 * How often in-process counters are written through to the persistent outbox.
 * Bounds store writes when a gated public endpoint is hit repeatedly — the
 * counts keep accumulating in memory between writes.
 */
const OUTBOX_PERSIST_INTERVAL_MS = 60 * 1000;

/** Plugin store keys (namespaced under the `formflow` plugin store). */
const STORE_INSTALLED_KEY = 'telemetry-installed-sent';
const STORE_LAST_HEARTBEAT_KEY = 'telemetry-last-heartbeat';
const STORE_OUTBOX_KEY = 'telemetry-outbox';
const STORE_LAST_VERSION_KEY = 'telemetry-last-version';
const STORE_LAST_TIER_KEY = 'telemetry-last-tier';

/** Event names the ingestion Worker accepts. Keep in sync with the Worker allowlist. */
export type TelemetryEvent =
  | 'plugin_installed'
  | 'plugin_heartbeat'
  | 'plugin_upgraded'
  | 'license_changed'
  | 'feature_gate_hit'
  | 'form_published'
  | 'export_performed';

/** Non-PII properties attached to install/heartbeat events. */
export interface TelemetryProperties {
  telemetry_schema_version: number;
  plugin_version: string;
  strapi_version: string;
  node_version: string;
  license_tier: string;
  license_state: string;
  forms_count: number;
  active_forms_count: number;
  submissions_bucket: string;
  max_fields_per_form: number;
  field_types_used: string[];
  features_configured: string[];
  db_client: string;
  os_platform: string;
  node_env: string;
}

/** One aggregated activity entry awaiting the next batched send. */
interface OutboxEntry {
  event: TelemetryEvent;
  /** Entries sharing a key are merged and counted rather than duplicated. */
  key: string;
  count: number;
  properties: Record<string, unknown>;
  occurred_on: string;
}

interface Outbox {
  entries: OutboxEntry[];
  /** Entries refused because the outbox was full — reported, not hidden. */
  dropped: number;
}

export interface TelemetryService {
  /**
   * Called on bootstrap. Sends a one-time `plugin_installed` event (first boot
   * ever, persisted via the plugin store) and a throttled `plugin_heartbeat`.
   * Resolves immediately on opt-out and never throws.
   */
  init(): Promise<void>;
  /**
   * Send a `plugin_heartbeat` now, together with everything queued in the
   * outbox, as a single batched request. Used by the daily cron. No-op on
   * opt-out and never throws.
   */
  heartbeat(): Promise<void>;
  /** Whether telemetry is currently allowed to send. */
  isEnabled(): boolean;
  /** Queue: a licensed feature was refused for this install. Fire-and-forget. */
  recordGateHit(feature: string, requiredTier?: string): void;
  /** Queue: a form was created/published. Fire-and-forget. */
  recordFormPublished(fieldCount: number, hasMultistep: boolean, hasConditional: boolean): void;
  /** Queue: submissions were exported in the given format. Fire-and-forget. */
  recordExport(format: string, rowCount?: number): void;
}

/**
 * Matches Strapi's own telemetry `isTruthy` (core `metrics/is-truthy.ts`):
 * accepts `true`, `1`, and case-insensitive `'true'`/`'1'`. Kept in parity so a
 * value that disables Strapi telemetry disables ours identically.
 */
const isTruthy = (value: unknown): boolean =>
  value === true || value === 1 || ['true', '1'].includes(String(value).toLowerCase());

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Day precision, not a timestamp: enough to bucket activity, less to correlate. */
const today = (): string => new Date().toISOString().slice(0, 10);

const emptyOutbox = (): Outbox => ({ entries: [], dropped: 0 });

const telemetryService = ({ strapi }: { strapi: Core.Strapi }): TelemetryService => {
  const store = () => strapi.store({ type: 'plugin', name: 'formflow' });

  /**
   * In-process accumulator. Activity is counted here first and written through
   * to the persistent outbox at most once per interval, so a hammered gated
   * endpoint cannot turn telemetry into a write amplifier. Worst case on an
   * abrupt crash is the loss of under a minute of counts, which is immaterial
   * for usage analytics.
   */
  const pending = new Map<string, OutboxEntry>();
  let lastPersistAt = 0;

  /**
   * Mirror Strapi's own telemetry opt-out verbatim. From core
   * `services/metrics/index.ts`:
   *   isDisabled = !uuid
   *     || isTruthy(process.env.STRAPI_TELEMETRY_DISABLED)
   *     || isTruthy(config.get('packageJsonStrapi.telemetryDisabled'))
   * plus a FormFlow-specific switch. Anyone who disabled Strapi telemetry (no
   * uuid, env var, or `strapi.telemetryDisabled` in package.json) disables ours.
   */
  const isEnabled = (): boolean => {
    if (!strapi.config.get('uuid')) return false;
    if (isTruthy(process.env.FORMFLOW_TELEMETRY_DISABLED)) return false;
    if (isTruthy(process.env.STRAPI_TELEMETRY_DISABLED)) return false;
    if (isTruthy(strapi.config.get('packageJsonStrapi.telemetryDisabled'))) return false;
    return true;
  };

  /** SHA-256 of the project UUID — a stable, anonymous install identifier. */
  const distinctId = (): string =>
    createHash('sha256')
      .update(String(strapi.config.get('uuid') ?? ''))
      .digest('hex');

  const buildProperties = async (): Promise<TelemetryProperties> => {
    let licenseTier = 'free';
    try {
      licenseTier = strapi.plugin('formflow').service('license').tier();
    } catch {
      // License service unavailable (e.g. stripped MIT fork) — default to free.
    }

    const facts = await collectFacts(strapi);

    return {
      telemetry_schema_version: TELEMETRY_SCHEMA_VERSION,
      plugin_version: PLUGIN_VERSION,
      strapi_version: String(strapi.config.get('info.strapi') ?? 'unknown'),
      node_version: process.versions.node,
      license_tier: licenseTier,
      ...facts,
    };
  };

  /**
   * Light context attached to every queued activity event, so analytics can
   * break activity down by version and plan without re-joining to a heartbeat.
   */
  const eventContext = (): Record<string, unknown> => {
    let licenseTier = 'free';
    try {
      licenseTier = strapi.plugin('formflow').service('license').tier();
    } catch {
      // Stripped fork — stays 'free'.
    }
    return {
      telemetry_schema_version: TELEMETRY_SCHEMA_VERSION,
      plugin_version: PLUGIN_VERSION,
      license_tier: licenseTier,
    };
  };

  const readOutbox = async (): Promise<Outbox> => {
    try {
      const raw = (await store().get({ key: STORE_OUTBOX_KEY })) as Outbox | null;
      if (!raw || !Array.isArray(raw.entries)) return emptyOutbox();
      return { entries: raw.entries, dropped: Number(raw.dropped) || 0 };
    } catch {
      return emptyOutbox();
    }
  };

  const writeOutbox = async (outbox: Outbox): Promise<void> => {
    try {
      await store().set({ key: STORE_OUTBOX_KEY, value: outbox });
    } catch {
      // Queue persistence is best-effort; never surfaces to the caller.
    }
  };

  const mergeEntry = (outbox: Outbox, entry: OutboxEntry): void => {
    const existing = outbox.entries.find((e) => e.key === entry.key);
    if (existing) {
      existing.count += entry.count;
      // Keep the newest properties so the sample reflects current usage.
      existing.properties = entry.properties;
      return;
    }
    if (outbox.entries.length >= OUTBOX_MAX_ENTRIES) {
      outbox.dropped += entry.count;
      return;
    }
    outbox.entries.push(entry);
  };

  /**
   * Write in-process counters through to the durable outbox.
   *
   * Serialized through a promise chain: `record()` fires this without awaiting,
   * so an un-chained version could still be mid-write when the heartbeat reads
   * the queue, and that cycle's activity would silently slip to the next day.
   * Awaiting the chain makes "persist, then read" ordered for every caller.
   */
  let persistChain: Promise<void> = Promise.resolve();

  const persistPending = (): Promise<void> => {
    persistChain = persistChain
      .then(async () => {
        if (pending.size === 0) return;
        const batch = [...pending.values()];
        pending.clear();
        lastPersistAt = Date.now();

        const outbox = await readOutbox();
        for (const entry of batch) mergeEntry(outbox, entry);
        await writeOutbox(outbox);
      })
      .catch(() => {
        // Best-effort; counts stay in memory for the next attempt.
      });
    return persistChain;
  };

  /**
   * Accumulate one activity event. Never awaits, never throws: call sites are
   * request paths and must not pay for telemetry.
   */
  const record = (
    event: TelemetryEvent,
    key: string,
    properties: Record<string, unknown>
  ): void => {
    if (!isEnabled()) return;
    try {
      const existing = pending.get(key);
      if (existing) {
        existing.count += 1;
        existing.properties = properties;
      } else {
        pending.set(key, { event, key, count: 1, properties, occurred_on: today() });
      }

      if (Date.now() - lastPersistAt > OUTBOX_PERSIST_INTERVAL_MS) {
        persistPending().catch(() => {
          // Best-effort; counts stay in memory for the next attempt.
        });
      }
    } catch {
      // Telemetry must never affect the request that triggered it.
    }
  };

  const recordGateHit = (feature: string, requiredTier = 'pro'): void => {
    // `feature` comes from the plugin's own FeatureKey vocabulary at every call
    // site, so it is safe to report verbatim.
    record('feature_gate_hit', `gate:${feature}`, { feature, required_tier: requiredTier });
  };

  const recordFormPublished = (
    fieldCount: number,
    hasMultistep: boolean,
    hasConditional: boolean
  ): void => {
    const bucket = bucketCount(fieldCount);
    record('form_published', `form_published:${bucket}:${hasMultistep}:${hasConditional}`, {
      field_count_bucket: bucket,
      has_multistep: hasMultistep,
      has_conditional: hasConditional,
    });
  };

  const recordExport = (format: string, rowCount?: number): void => {
    // Allowlist the format so a hand-crafted query string can never become a
    // free-text property on the wire.
    const safeFormat = ['csv', 'json', 'xlsx', 'pdf'].includes(format) ? format : 'other';
    record('export_performed', `export:${safeFormat}`, {
      format: safeFormat,
      ...(rowCount === undefined ? {} : { row_count_bucket: bucketCount(rowCount) }),
    });
  };

  /**
   * POST one batch of events. Returns true only when the endpoint confirms
   * receipt (2xx). Never throws. Retries network errors a few times (handles
   * the cold first-request failure); does not retry an explicit non-2xx.
   *
   * A `400` means the Worker predates batch support, so the events are re-sent
   * one at a time in the legacy single-event shape. That keeps delivery correct
   * regardless of the order in which the Worker and the plugin are deployed.
   */
  const postJson = async (payload: unknown): Promise<number | null> => {
    const body = JSON.stringify(payload);

    for (let attempt = 1; attempt <= MAX_SEND_ATTEMPTS; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      try {
        const res = await fetch(TELEMETRY_ENDPOINT, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
          signal: controller.signal,
        });
        return res.status;
      } catch (error) {
        strapi.log.debug(
          `[FormFlow] Telemetry attempt ${attempt}/${MAX_SEND_ATTEMPTS} failed (non-fatal): ${error}`
        );
      } finally {
        clearTimeout(timer);
      }
      if (attempt < MAX_SEND_ATTEMPTS) await delay(RETRY_DELAY_MS);
    }
    return null;
  };

  interface WireEvent {
    event: TelemetryEvent;
    distinct_id: string;
    /** Heartbeat/install carry the typed snapshot; queued activity carries free-form counts. */
    properties: TelemetryProperties | Record<string, unknown>;
  }

  const send = async (events: WireEvent[]): Promise<boolean> => {
    if (events.length === 0) return true;

    const status = await postJson({ batch: events });
    if (status !== null && status >= 200 && status < 300) return true;

    if (status === 400) {
      // Legacy Worker without batch support: fall back to single-event posts.
      strapi.log.debug('[FormFlow] Telemetry endpoint rejected a batch; retrying individually.');
      let allOk = true;
      for (const event of events) {
        const single = await postJson(event);
        if (single === null || single < 200 || single >= 300) allOk = false;
      }
      return allOk;
    }

    if (status !== null) {
      strapi.log.debug(`[FormFlow] Telemetry batch rejected: ${status}`);
    }
    return false;
  };

  /**
   * Compare the current version/tier against the last reported values and queue
   * a transition event when they differ. Deriving these from state means no
   * hooks are needed in the upgrade or licensing paths, and a transition that
   * fails to send is simply re-derived on the next attempt.
   */
  const queueTransitions = async (properties: TelemetryProperties): Promise<void> => {
    const s = store();

    try {
      const lastVersion = (await s.get({ key: STORE_LAST_VERSION_KEY })) as string | null;
      if (lastVersion && lastVersion !== properties.plugin_version) {
        record('plugin_upgraded', `plugin_upgraded:${lastVersion}:${properties.plugin_version}`, {
          from_version: lastVersion,
          to_version: properties.plugin_version,
        });
      }
    } catch {
      // Best-effort.
    }

    try {
      const lastTier = (await s.get({ key: STORE_LAST_TIER_KEY })) as string | null;
      if (lastTier && lastTier !== properties.license_tier) {
        record('license_changed', `license_changed:${lastTier}:${properties.license_tier}`, {
          from_tier: lastTier,
          to_tier: properties.license_tier,
          to_state: properties.license_state,
        });
      }
    } catch {
      // Best-effort.
    }
  };

  const rememberState = async (properties: TelemetryProperties): Promise<void> => {
    try {
      const s = store();
      await s.set({ key: STORE_LAST_VERSION_KEY, value: properties.plugin_version });
      await s.set({ key: STORE_LAST_TIER_KEY, value: properties.license_tier });
    } catch {
      // Bookkeeping is best-effort.
    }
  };

  const heartbeat = async (): Promise<void> => {
    if (!isEnabled()) return;

    const properties = await buildProperties();
    await queueTransitions(properties);
    await persistPending();

    const outbox = await readOutbox();
    const context = eventContext();
    const queued: WireEvent[] = outbox.entries.map((entry) => ({
      event: entry.event,
      distinct_id: distinctId(),
      properties: {
        ...context,
        ...entry.properties,
        count: entry.count,
        occurred_on: entry.occurred_on,
      },
    }));

    const heartbeatEvent: WireEvent = {
      event: 'plugin_heartbeat',
      distinct_id: distinctId(),
      properties: outbox.dropped > 0 ? { ...properties, outbox_dropped: outbox.dropped } : properties,
    };

    // Only clear the queue and record the timestamp on confirmed delivery, so a
    // failed send is retried on the next boot instead of being throttled away.
    if (await send([heartbeatEvent, ...queued])) {
      await writeOutbox(emptyOutbox());
      await rememberState(properties);
      try {
        await store().set({ key: STORE_LAST_HEARTBEAT_KEY, value: Date.now() });
      } catch {
        // Throttle bookkeeping is best-effort.
      }
    }
  };

  const init = async (): Promise<void> => {
    if (!isEnabled()) {
      strapi.log.debug('[FormFlow] Telemetry disabled; skipping.');
      return;
    }

    const s = store();

    // One-time install event. The "sent" flag is persisted ONLY after confirmed
    // delivery, so a failed first attempt is retried on a later boot rather than
    // being lost forever.
    try {
      const alreadySent = await s.get({ key: STORE_INSTALLED_KEY });
      if (!alreadySent) {
        const properties = await buildProperties();
        const sent = await send([
          { event: 'plugin_installed', distinct_id: distinctId(), properties },
        ]);
        if (sent) {
          await s.set({ key: STORE_INSTALLED_KEY, value: true });
          await rememberState(properties);
        }
      }
    } catch (error) {
      strapi.log.debug(`[FormFlow] Telemetry install event failed (non-fatal): ${error}`);
    }

    // Throttled boot heartbeat so short-lived/dev restarts don't spam.
    try {
      const last = Number(await s.get({ key: STORE_LAST_HEARTBEAT_KEY })) || 0;
      if (Date.now() - last > HEARTBEAT_THROTTLE_MS) {
        await heartbeat();
      }
    } catch (error) {
      strapi.log.debug(`[FormFlow] Telemetry boot heartbeat failed (non-fatal): ${error}`);
    }
  };

  return { init, heartbeat, isEnabled, recordGateHit, recordFormPublished, recordExport };
};

export default telemetryService;
