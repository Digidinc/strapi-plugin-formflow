/**
 * Opt-out, privacy and batching regression tests for telemetry.
 *
 * Telemetry MUST stay silent whenever the host has opted out — no project
 * `uuid`, `STRAPI_TELEMETRY_DISABLED`, or `strapi.telemetryDisabled` in
 * package.json — or when the FormFlow-specific `FORMFLOW_TELEMETRY_DISABLED`
 * switch is set. It must also send the raw project UUID to nobody (only a hash)
 * and never re-send the one-time install event.
 *
 * It must additionally never put operator- or user-authored text on the wire:
 * only values drawn from the plugin's own catalogs (field types, feature keys,
 * fixed enums, counts) are reportable, and activity must ship batched with the
 * daily heartbeat rather than as it happens.
 *
 * Run via: npm run test:unit:telemetry
 *
 * Plain Node assert script (mirrors server/src/ee/license/__tests__): it throws
 * on failure and exits cleanly on success.
 */

import assert from 'node:assert/strict';
import telemetryService from '../telemetry';

interface WireEvent {
  event: string;
  distinct_id: string;
  properties: Record<string, unknown>;
}

interface FetchCall {
  url: string;
  body: { batch?: WireEvent[] } & Partial<WireEvent>;
}

/** Every request is either a batch or a single legacy event; normalise both. */
const eventsOf = (call: FetchCall): WireEvent[] =>
  call.body.batch ?? [call.body as WireEvent];

/** All events across all requests, flattened. */
const allEvents = (calls: FetchCall[]): WireEvent[] => calls.flatMap(eventsOf);

const findEvent = (calls: FetchCall[], name: string): WireEvent | undefined =>
  allEvents(calls).find((event) => event.event === name);

/** Replace global fetch with a spy that records each ping. */
function installFetchSpy(): FetchCall[] {
  const calls: FetchCall[] = [];
  (globalThis as { fetch: unknown }).fetch = async (_url: string, init?: { body?: string }) => {
    calls.push({ url: _url, body: init?.body ? JSON.parse(init.body) : undefined });
    return { ok: true, status: 202, async text() { return ''; } };
  };
  return calls;
}

/**
 * One active form using a known field type, an UNKNOWN field type that must be
 * dropped, and operator-authored text in every free-text position. None of the
 * text may ever appear on the wire.
 */
const FORMS_FIXTURE = [
  {
    title: 'Acme Corp Employee Onboarding',
    slug: 'acme-corp-onboarding',
    isActive: true,
    requiresApproval: false,
    locales: {},
    fields: [
      { id: 'a', type: 'text', label: 'Home address of applicant' },
      { id: 'b', type: 'rating', label: 'Rate your manager' },
      { id: 'c', type: 'totally_custom_type', label: 'secret' },
      { id: 'd', type: 'email', conditional: { field: 'a', op: 'eq', value: 'x' } },
    ],
    settings: {
      layout: 'multi-step',
      steps: [{ id: 's1' }],
      webhooks: [{ url: 'https://internal.acme.example/hook' }],
      emailNotifications: [{ to: 'hr@acme.example', isAutoresponder: true }],
      spam: { honeypot: true },
    },
  },
  {
    title: 'Draft form',
    isActive: false,
    fields: [{ id: 'e', type: 'text' }],
    settings: {},
  },
];

/** Minimal strapi stub with an in-memory plugin store. */
function makeStrapi(configOverrides: Record<string, unknown> = {}) {
  const store = new Map<string, unknown>();
  const config: Record<string, unknown> = {
    uuid: 'project-uuid-abc',
    'info.strapi': '5.4.0',
    'database.connection.client': 'postgres',
    ...configOverrides,
  };
  const strapi = {
    config: { get: (key: string) => config[key] },
    store: () => ({
      async get({ key }: { key: string }) {
        return store.has(key) ? store.get(key) : null;
      },
      async set({ key, value }: { key: string; value: unknown }) {
        store.set(key, value);
      },
    }),
    plugin: () => ({
      service: (name: string) => {
        if (name === 'license') return { tier: () => 'free', state: () => 'free' };
        if (name === 'form') {
          return {
            getFieldTypes: () => [
              { type: 'text' },
              { type: 'email' },
              { type: 'rating' },
              { type: 'select' },
            ],
          };
        }
        return {};
      },
    }),
    documents: () => ({
      count: async () => 3,
      findMany: async () => FORMS_FIXTURE,
    }),
    log: { debug() {} },
  } as unknown as Parameters<typeof telemetryService>[0]['strapi'];
  return { strapi, store };
}

(async () => {
  const origFormflow = process.env.FORMFLOW_TELEMETRY_DISABLED;
  const origStrapi = process.env.STRAPI_TELEMETRY_DISABLED;
  delete process.env.FORMFLOW_TELEMETRY_DISABLED;
  delete process.env.STRAPI_TELEMETRY_DISABLED;

  // 1. Enabled by default (uuid present, no opt-out).
  {
    const { strapi } = makeStrapi();
    assert.strictEqual(
      telemetryService({ strapi }).isEnabled(),
      true,
      'enabled when uuid is set and nothing opts out'
    );
  }

  // 2. Disabled when the project uuid is absent (mirrors Strapi's own opt-out).
  {
    const { strapi } = makeStrapi({ uuid: undefined });
    assert.strictEqual(
      telemetryService({ strapi }).isEnabled(),
      false,
      'disabled when uuid is missing'
    );
  }

  // 3. Disabled by package.json `strapi.telemetryDisabled`.
  {
    const { strapi } = makeStrapi({ 'packageJsonStrapi.telemetryDisabled': true });
    assert.strictEqual(
      telemetryService({ strapi }).isEnabled(),
      false,
      'disabled by packageJsonStrapi.telemetryDisabled'
    );
  }

  // 4. Disabled by STRAPI_TELEMETRY_DISABLED.
  {
    process.env.STRAPI_TELEMETRY_DISABLED = 'true';
    const { strapi } = makeStrapi();
    assert.strictEqual(
      telemetryService({ strapi }).isEnabled(),
      false,
      'disabled by STRAPI_TELEMETRY_DISABLED'
    );
    delete process.env.STRAPI_TELEMETRY_DISABLED;
  }

  // 5. Disabled by FORMFLOW_TELEMETRY_DISABLED.
  {
    process.env.FORMFLOW_TELEMETRY_DISABLED = '1';
    const { strapi } = makeStrapi();
    assert.strictEqual(
      telemetryService({ strapi }).isEnabled(),
      false,
      'disabled by FORMFLOW_TELEMETRY_DISABLED'
    );
    delete process.env.FORMFLOW_TELEMETRY_DISABLED;
  }

  // 6. init() performs no network call when disabled.
  {
    const calls = installFetchSpy();
    const { strapi } = makeStrapi({ uuid: undefined });
    await telemetryService({ strapi }).init();
    assert.strictEqual(calls.length, 0, 'no network when disabled');
  }

  // 7. Fresh install sends install + heartbeat with an anonymized id.
  {
    const calls = installFetchSpy();
    const { strapi } = makeStrapi();
    await telemetryService({ strapi }).init();
    assert.strictEqual(calls.length, 2, 'fresh install sends install + heartbeat');

    const installed = findEvent(calls, 'plugin_installed');
    const beat = findEvent(calls, 'plugin_heartbeat');
    assert.ok(installed, 'plugin_installed was sent');
    assert.ok(beat, 'plugin_heartbeat was sent');
    assert.match(installed.distinct_id, /^[a-f0-9]{64}$/, 'distinct_id is a sha-256 hex');
    assert.notStrictEqual(
      installed.distinct_id,
      'project-uuid-abc',
      'the raw project uuid is never sent'
    );
    assert.strictEqual(installed.properties.forms_count, 3, 'forms_count is included');
  }

  // 8. A second boot is throttled/deduped — already installed + recent heartbeat.
  {
    const calls = installFetchSpy();
    const { strapi, store } = makeStrapi();
    store.set('telemetry-installed-sent', true);
    store.set('telemetry-last-heartbeat', Date.now());
    await telemetryService({ strapi }).init();
    assert.strictEqual(calls.length, 0, 'no resend when already installed and recently beat');
  }

  // 9. A rejected send must NOT persist state, so a later boot retries it. (This
  //    is the bug that silently lost the install event: marking it "sent" before
  //    the endpoint confirmed receipt.)
  {
    (globalThis as { fetch: unknown }).fetch = async () => ({
      ok: false,
      status: 500,
      async text() {
        return '';
      },
    });
    const { strapi, store } = makeStrapi();
    await telemetryService({ strapi }).init();
    assert.strictEqual(
      store.get('telemetry-installed-sent') ?? null,
      null,
      'install must not be marked sent when the endpoint rejects it'
    );
    assert.strictEqual(
      store.get('telemetry-last-heartbeat') ?? null,
      null,
      'heartbeat timestamp must not be recorded when the endpoint rejects it'
    );
  }

  // 10. A transient failure on the first attempt recovers on retry — the cold
  //     first-request fix. Install is delivered and marked sent.
  {
    let attempts = 0;
    (globalThis as { fetch: unknown }).fetch = async (_url: string, init?: { body?: string }) => {
      attempts += 1;
      if (attempts === 1) throw new Error('ECONNRESET (simulated cold first request)');
      return { ok: true, status: 202, async text() { return ''; }, _body: init?.body };
    };
    const { strapi, store } = makeStrapi();
    await telemetryService({ strapi }).init();
    assert.strictEqual(
      store.get('telemetry-installed-sent'),
      true,
      'install is marked sent after the retry succeeds'
    );
    assert.ok(attempts >= 2, 'the first failed attempt was retried');
  }

  // 11. PRIVACY: no operator- or user-authored text ever reaches the wire, and
  //     an unknown field type is dropped rather than passed through.
  {
    const calls = installFetchSpy();
    const { strapi } = makeStrapi();
    await telemetryService({ strapi }).init();

    const wire = JSON.stringify(calls);
    for (const secret of [
      'Acme Corp Employee Onboarding',
      'acme-corp-onboarding',
      'Home address of applicant',
      'Rate your manager',
      'internal.acme.example',
      'hr@acme.example',
      'totally_custom_type',
      'project-uuid-abc',
    ]) {
      assert.ok(!wire.includes(secret), `authored value must never be sent: ${secret}`);
    }

    const beat = findEvent(calls, 'plugin_heartbeat');
    assert.ok(beat, 'heartbeat present');
    assert.deepStrictEqual(
      beat.properties.field_types_used,
      ['email', 'rating', 'text'],
      'only field types from the plugin catalog are reported'
    );
    assert.strictEqual(beat.properties.active_forms_count, 1, 'active forms counted');
    assert.strictEqual(beat.properties.max_fields_per_form, 4, 'largest form measured');
    assert.strictEqual(beat.properties.submissions_bucket, '1-10', 'submissions are bucketed');
    assert.strictEqual(beat.properties.db_client, 'postgres', 'db client reported');

    const features = beat.properties.features_configured as string[];
    for (const expected of [
      'multistep',
      'conditionalLogic',
      'webhooks',
      'email.autoresponder',
      'spam.honeypot',
    ]) {
      assert.ok(features.includes(expected), `feature detected: ${expected}`);
    }
  }

  // 12. BATCHING: activity does not fire on its own — it is aggregated with a
  //     count and shipped inside the next heartbeat request.
  {
    const calls = installFetchSpy();
    const { strapi, store } = makeStrapi();
    store.set('telemetry-installed-sent', true);
    const service = telemetryService({ strapi });

    service.recordGateHit('webhooks', 'pro');
    service.recordGateHit('webhooks', 'pro');
    service.recordGateHit('multistep', 'pro');
    service.recordExport('csv');
    assert.strictEqual(calls.length, 0, 'recording activity performs no network call');

    await service.heartbeat();
    assert.strictEqual(calls.length, 1, 'a full day of activity ships in ONE request');

    const events = eventsOf(calls[0]);
    assert.strictEqual(events[0].event, 'plugin_heartbeat', 'heartbeat leads the batch');

    const gates = events.filter((event) => event.event === 'feature_gate_hit');
    assert.strictEqual(gates.length, 2, 'one event per distinct gated feature, not per hit');
    const webhookGate = gates.find((event) => event.properties.feature === 'webhooks');
    assert.ok(webhookGate, 'webhooks gate reported');
    assert.strictEqual(webhookGate.properties.count, 2, 'repeat hits are counted, not duplicated');

    const exported = events.find((event) => event.event === 'export_performed');
    assert.ok(exported, 'export reported');
    assert.strictEqual(exported.properties.format, 'csv', 'export format reported');
  }

  // 13. The outbox is cleared only after confirmed delivery, and a queued event
  //     survives a failed send to be retried on the next heartbeat.
  {
    (globalThis as { fetch: unknown }).fetch = async () => ({
      ok: false,
      status: 500,
      async text() { return ''; },
    });
    const { strapi, store } = makeStrapi();
    store.set('telemetry-installed-sent', true);
    const service = telemetryService({ strapi });
    service.recordGateHit('webhooks', 'pro');
    await service.heartbeat();

    const outbox = store.get('telemetry-outbox') as { entries: unknown[] } | undefined;
    assert.ok(outbox && outbox.entries.length === 1, 'queued activity survives a failed send');

    const calls = installFetchSpy();
    await service.heartbeat();
    const retried = findEvent(calls, 'feature_gate_hit');
    assert.ok(retried, 'the queued gate hit is retried on the next heartbeat');
    assert.deepStrictEqual(
      (store.get('telemetry-outbox') as { entries: unknown[] }).entries,
      [],
      'the outbox is cleared once delivery is confirmed'
    );
  }

  // 14. An unknown export format is collapsed to 'other' rather than echoed —
  //     a query string must never become a free-text analytics property.
  {
    const calls = installFetchSpy();
    const { strapi, store } = makeStrapi();
    store.set('telemetry-installed-sent', true);
    const service = telemetryService({ strapi });
    service.recordExport('../../etc/passwd');
    await service.heartbeat();

    const exported = findEvent(calls, 'export_performed');
    assert.ok(exported, 'export event present');
    assert.strictEqual(exported.properties.format, 'other', 'unknown format is collapsed');
    assert.ok(
      !JSON.stringify(calls).includes('passwd'),
      'the raw format string never reaches the wire'
    );
  }

  // 15. A Worker predating batch support answers 400; the events are re-sent
  //     one at a time so delivery does not depend on deploy order.
  {
    const calls: FetchCall[] = [];
    (globalThis as { fetch: unknown }).fetch = async (_url: string, init?: { body?: string }) => {
      const body = init?.body ? JSON.parse(init.body) : undefined;
      calls.push({ url: _url, body });
      if (body && body.batch) return { ok: false, status: 400, async text() { return ''; } };
      return { ok: true, status: 202, async text() { return ''; } };
    };

    const { strapi, store } = makeStrapi();
    store.set('telemetry-installed-sent', true);
    const service = telemetryService({ strapi });
    service.recordGateHit('webhooks', 'pro');
    await service.heartbeat();

    assert.ok(
      calls.some((call) => call.body.batch !== undefined),
      'the batch shape is attempted first'
    );
    const singles = calls.filter((call) => call.body.batch === undefined);
    assert.strictEqual(singles.length, 2, 'both events are re-sent individually after the 400');
    assert.ok(
      singles.some((call) => call.body.event === 'plugin_heartbeat'),
      'heartbeat survives the legacy fallback'
    );
    assert.strictEqual(
      store.get('telemetry-last-heartbeat') !== undefined,
      true,
      'the fallback counts as delivered'
    );
  }

  if (origFormflow !== undefined) process.env.FORMFLOW_TELEMETRY_DISABLED = origFormflow;
  if (origStrapi !== undefined) process.env.STRAPI_TELEMETRY_DISABLED = origStrapi;

  console.log('telemetry opt-out, privacy and batching tests passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
