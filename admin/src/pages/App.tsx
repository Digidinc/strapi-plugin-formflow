import { lazy, Suspense } from 'react';
import { Page } from '@strapi/strapi/admin';
import { Routes, Route, Navigate, useParams } from 'react-router-dom';

// Pages
import { FormsListPage } from './FormsListPage';
import { FormEditPage } from './FormEditPage';
import { SubmissionsListPage } from './SubmissionsListPage';
import { SubmissionDetailPage } from './SubmissionDetailPage';
import { PERMISSIONS } from '../permissions';
import { LicenseStatusNotice } from '../ee/components/LicenseStatusNotice';
import { LicenseProvider } from '../ee/providers/LicenseProvider';

// Pro analytics page is lazy-loaded from the ee/ tree so it is split out of the
// main bundle and only fetched when the analytics route is visited.
const AnalyticsPage = lazy(() =>
  import('../ee/pages/AnalyticsPage').then((m) => ({ default: m.AnalyticsPage }))
);

// Business compliance page — lazy-loaded from the ee/ tree (code-split, only
// fetched when the compliance route is visited).
const CompliancePage = lazy(() =>
  import('../ee/pages/CompliancePage').then((m) => ({ default: m.CompliancePage }))
);

/** Reads :formId from the URL and feeds it to the analytics page. */
const AnalyticsRoute = () => {
  const { formId } = useParams<{ formId: string }>();
  return (
    <Suspense fallback={null}>
      <AnalyticsPage formDocumentId={formId ?? ''} />
    </Suspense>
  );
};

const App = () => {
  return (
    <Page.Protect permissions={PERMISSIONS.main}>
      <LicenseProvider>
        <LicenseStatusNotice />
        <Routes>
          {/* Forms */}
          <Route index element={<FormsListPage />} />
          <Route path="forms" element={<FormsListPage />} />
          <Route path="forms/create" element={<FormEditPage />} />
          <Route path="forms/:id/edit" element={<FormEditPage />} />
          {/* Bare form route -> redirect to the editor (avoids the error page) */}
          <Route path="forms/:id" element={<Navigate to="edit" replace />} />

          {/* Submissions */}
          <Route path="forms/:formId/submissions" element={<SubmissionsListPage />} />
          <Route path="submissions/:id" element={<SubmissionDetailPage />} />

          {/* Analytics (Pro) */}
          <Route path="forms/:formId/analytics" element={<AnalyticsRoute />} />

          {/* Compliance (Business) */}
          <Route
            path="compliance"
            element={
              <Suspense fallback={null}>
                <CompliancePage />
              </Suspense>
            }
          />

          {/* Fallback */}
          <Route path="*" element={<Page.Error />} />
        </Routes>
      </LicenseProvider>
    </Page.Protect>
  );
};

export { App };
