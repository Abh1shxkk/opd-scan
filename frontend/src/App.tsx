/**
 * Routing and the application shell.
 *
 * Role gating on routes mirrors docs/API.md so a user is not led to a screen the server will
 * refuse, but the server remains the authority — `RequireRole` hides, it does not protect.
 */

import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useAuth } from './lib/auth';
import type { Role } from './lib/types';
import { Sidebar } from './components/Sidebar';

import LoginPage from './pages/LoginPage';
import DashboardPage from './pages/DashboardPage';
import UploadPage from './pages/UploadPage';
import DocumentsPage from './pages/DocumentsPage';
import PageViewerPage from './pages/PageViewerPage';
import ReviewQueuePage from './pages/ReviewQueuePage';
import DiagnosisReviewPage from './pages/DiagnosisReviewPage';
import DiagnosisQueuePage from './pages/DiagnosisQueuePage';
import ReportsPage from './pages/ReportsPage';
import SettingsPage from './pages/SettingsPage';
import PrescriptionAnalyzerPage from './pages/PrescriptionAnalyzerPage';
import PrescriptionResultPage from './pages/PrescriptionResultPage';

function RequireAuth({ children }: { children: ReactNode }) {
  const { isAuthenticated } = useAuth();
  const location = useLocation();
  if (!isAuthenticated) {
    // Remember where the user was heading so the login can send them back there.
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }
  return <>{children}</>;
}

function RequireRole({ role, children }: { role: Role; children: ReactNode }) {
  const { can } = useAuth();
  if (!can(role)) {
    return (
      <main className="mx-auto max-w-2xl p-8">
        <h1 className="text-xl font-semibold">You do not have access to this screen</h1>
        <p className="mt-2 text-sm text-slate-700 dark:text-slate-300">
          This area is limited to the <strong>{role}</strong> role. Ask an administrator if you need it.
        </p>
      </main>
    );
  }
  return <>{children}</>;
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-screen overflow-hidden bg-slate-50 dark:bg-slate-950">
      <a href="#main" className="skip-link">
        Skip to main content
      </a>
      <Sidebar />
      <main id="main" tabIndex={-1} className="min-w-0 flex-1 overflow-y-auto p-6 lg:p-8">
        <div className="mx-auto max-w-[100rem]">{children}</div>
      </main>
    </div>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        path="*"
        element={
          <RequireAuth>
            <Shell>
              <Routes>
                <Route path="/" element={<Navigate to="/dashboard" replace />} />
                <Route path="/dashboard" element={<DashboardPage />} />
                <Route path="/documents" element={<DocumentsPage />} />
                <Route path="/pages/:pageVersionId" element={<PageViewerPage />} />
                <Route
                  path="/review"
                  element={
                    <RequireRole role="reviewer">
                      <ReviewQueuePage />
                    </RequireRole>
                  }
                />
                <Route
                  path="/diagnoses"
                  element={
                    <RequireRole role="reviewer">
                      <DiagnosisQueuePage />
                    </RequireRole>
                  }
                />
                <Route
                  path="/diagnoses/:diagnosisId"
                  element={
                    <RequireRole role="reviewer">
                      <DiagnosisReviewPage />
                    </RequireRole>
                  }
                />
                <Route
                  path="/upload"
                  element={
                    <RequireRole role="uploader">
                      <UploadPage />
                    </RequireRole>
                  }
                />
                <Route path="/reports" element={<ReportsPage />} />
                <Route
                  path="/prescriptions"
                  element={
                    <RequireRole role="uploader">
                      <PrescriptionAnalyzerPage />
                    </RequireRole>
                  }
                />
                <Route
                  path="/prescriptions/:documentId"
                  element={
                    <RequireRole role="uploader">
                      <PrescriptionResultPage />
                    </RequireRole>
                  }
                />
                <Route
                  path="/settings"
                  element={
                    <RequireRole role="admin">
                      <SettingsPage />
                    </RequireRole>
                  }
                />
                <Route
                  path="*"
                  element={
                    <div className="p-8">
                      <h1 className="text-xl font-semibold">Page not found</h1>
                    </div>
                  }
                />
              </Routes>
            </Shell>
          </RequireAuth>
        }
      />
    </Routes>
  );
}
