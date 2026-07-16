import assert from 'node:assert/strict';

import publicController from '../public';
import contentApiRoutes from '../../routes/content-api';

const events: Array<{ formDocumentId: string; eventType: string }> = [];

const strapi: any = {
  plugin(name: string) {
    assert.equal(name, 'formflow');
    return {
      service(serviceName: string) {
        if (serviceName === 'form') {
          return {
            async findBySlug(slug: string) {
              assert.equal(slug, 'contact-form');
              return { documentId: 'form-document-id', isActive: true };
            },
          };
        }

        if (serviceName === 'analytics') {
          return {
            recordEvent(formDocumentId: string, eventType: string) {
              events.push({ formDocumentId, eventType });
            },
          };
        }

        throw new Error(`Unexpected service: ${serviceName}`);
      },
    };
  },
};

void (async () => {
  const route = contentApiRoutes.routes.find(
    (candidate) => candidate.path === '/forms/:slug/analytics/start'
  );

  assert.ok(route, 'The public start-tracking route must be registered');
  assert.equal(route.method, 'POST');
  assert.equal(route.handler, 'public.trackFormStart');
  assert.equal(route.config.auth, false);
  assert.deepEqual(route.config.policies, ['plugin::formflow.is-form-active']);

  const controller = publicController({ strapi }) as any;
  const ctx: any = {
    params: { slug: 'contact-form' },
    status: 200,
    notFound(message?: string) {
      throw new Error(message ?? 'Not found');
    },
  };

  await controller.trackFormStart(ctx);

  assert.equal(ctx.status, 204);
  assert.deepEqual(events, [{ formDocumentId: 'form-document-id', eventType: 'start' }]);

  console.log('All assertions passed: public analytics start tracking.');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
