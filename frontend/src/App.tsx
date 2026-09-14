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
import PatientsPage from './pages/PatientsPage';
import PatientDetailPage from './pages/PatientDetailPage';
import UploadPage from './pages/UploadPage';
import DocumentsPage from './pages/DocumentsPage';
import PageViewerPage from './pages/PageViewerPage';
import JobsPage from './pages/JobsPage';
import RescanQueuePage from './pages/RescanQueuePage';
import ReviewQueuePage from './pages/ReviewQueuePage';
import ReviewDocumentsPage from './pages/ReviewDocumentsPage';
import ReviewDocumentPage from './pages/ReviewDocumentPage';
import DiagnosisReviewPage from './pages/DiagnosisReviewPage';
import DiagnosisQueuePage from './pages/DiagnosisQueuePage';
import ReportsPage from './pages/ReportsPage';
import SettingsPage from './pages/SettingsPage';
import PatientIntakePage from './pages/PatientIntakePage';
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
      <main className="mx-auto max-w-xl p-6">
        <div className="sheet p-4">
          <h1 className="text-[17px] font-semibold tracking-tight text-ink">
            You do not have access to this screen
          </h1>
          <p className="mt-1.5 text-[13px] text-ink-2">
            This area is limited to the <strong className="text-ink">{role}</strong> role. Ask an
            administrator if you need it.
          </p>
        </div>
      </main>
    );
  }
  return <>{children}</>;
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-screen flex-col overflow-hidden bg-paper md:flex-row">
      <a href="#main" className="skip-link">
        Skip to main content
      </a>
      <Sidebar />
      <main id="main" tabIndex={-1} className="min-w-0 flex-1 overflow-y-auto p-3 lg:p-5">
        <div className="mx-auto max-w-[110rem]">{children}</div>
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
                <Route path="/patients" element={<PatientsPage />} />
                <Route path="/patients/:caseId" element={<PatientDetailPage />} />
                {/* Still reachable, and linked from a patient record that has several files —
                    it left the menu, not the application. */}
                <Route path="/documents" element={<DocumentsPage />} />
                <Route path="/pages/:pageVersionId" element={<PageViewerPage />} />
                {/* The queue is now file-first. The page-at-a-time list it replaced still works
                    at /review/pages for anyone who preferred it. */}
                <Route
                  path="/review"
                  element={
                    <RequireRole role="reviewer">
                      <ReviewDocumentsPage />
                    </RequireRole>
                  }
                />
                <Route
                  path="/review/pages"
                  element={
                    <RequireRole role="reviewer">
                      <ReviewQueuePage />
                    </RequireRole>
                  }
                />
                <Route
                  path="/review/:documentId"
                  element={
                    <RequireRole role="reviewer">
                      <ReviewDocumentPage />
                    </RequireRole>
                  }
                />
                <Route
                  path="/rescans"
                  element={
                    <RequireRole role="reviewer">
                      <RescanQueuePage />
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
                  path="/intake"
                  element={
                    <RequireRole role="uploader">
                      <PatientIntakePage />
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
                <Route path="/jobs" element={<JobsPage />} />
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
                    <div className="p-6">
                      <div className="sheet max-w-xl p-4">
                        <h1 className="text-[17px] font-semibold tracking-tight text-ink">
                          Page not found
                        </h1>
                        <p className="mt-1.5 text-[13px] text-ink-2">
                          There is no screen at this address.
                        </p>
                      </div>
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
