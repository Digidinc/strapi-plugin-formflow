export default {
  type: 'content-api',
  routes: [
    {
      method: 'GET',
      path: '/',
      handler: 'public.index',
      config: {
        auth: false,
        policies: [],
      },
    },
    {
      method: 'GET',
      path: '/forms/:slug',
      handler: 'public.getFormSchema',
      config: {
        auth: false,
        policies: ['plugin::formflow.is-form-active'],
      },
    },
    {
      method: 'POST',
      path: '/forms/:slug/analytics/start',
      handler: 'public.trackFormStart',
      config: {
        auth: false,
        policies: ['plugin::formflow.is-form-active'],
      },
    },
    {
      // Accepts BOTH application/json and multipart/form-data. Multipart is
      // required for `file` fields: the global `strapi::body` middleware
      // (koa-body, multipart + patchKoa enabled by default) parses uploads into
      // `ctx.request.files` (keyed by field name) and text fields into
      // `ctx.request.body`. No route-level body config is needed; oversize
      // uploads beyond koa-body's limit are rejected by core with HTTP 413.
      method: 'POST',
      path: '/forms/:slug/submit',
      handler: 'public.submitForm',
      config: {
        auth: false,
        policies: ['plugin::formflow.is-form-active', 'plugin::formflow.rate-limit'],
        middlewares: ['plugin::formflow.spam-check'],
      },
    },
    {
      // Save & resume (Pro): persist a partial submission and return a resume
      // token. The handler maps an unentitled license to HTTP 402.
      method: 'POST',
      path: '/forms/:slug/partial',
      handler: 'public.savePartialForm',
      config: {
        auth: false,
        policies: ['plugin::formflow.is-form-active', 'plugin::formflow.rate-limit'],
      },
    },
    {
      // Resume a saved partial submission by its token.
      method: 'GET',
      path: '/forms/:slug/partial/:resumeToken',
      handler: 'public.getPartialForm',
      config: {
        auth: false,
        policies: ['plugin::formflow.is-form-active'],
      },
    },
  ],
};
