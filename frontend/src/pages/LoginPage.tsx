import { useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { Button, TextInput } from '../components/ui';

export default function LoginPage() {
  const { login, isAuthenticated } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from ?? '/dashboard';

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (isAuthenticated) return <Navigate to={from} replace />;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(email, password);
      navigate(from, { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign in failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex h-screen items-center justify-center overflow-y-auto p-4">
      <div className="w-full max-w-sm rounded-xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900">
        <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-50">Sign in</h1>
        <p className="mt-1 text-sm text-slate-700 dark:text-slate-300">
          Scan quality control for patient records.
        </p>

        <form onSubmit={onSubmit} className="mt-5 space-y-4">
          <TextInput
            label="Email"
            type="email"
            name="email"
            autoComplete="username"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <TextInput
            label="Password"
            type="password"
            name="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />

          {/* role=alert so the failure is announced, not merely rendered. */}
          {error ? (
            <p
              role="alert"
              className="rounded-lg border border-red-400 bg-red-50 px-3 py-2 text-sm text-red-950 dark:border-red-700 dark:bg-red-950 dark:text-red-50"
            >
              <span aria-hidden="true">⚠ </span>
              {error}
            </p>
          ) : null}

          <Button type="submit" variant="primary" disabled={busy} className="w-full">
            {busy ? 'Signing in…' : 'Sign in'}
          </Button>
        </form>

        <p className="mt-5 text-xs text-slate-600 dark:text-slate-400">
          This system holds patient data. Access is recorded in an audit log.
        </p>
      </div>
    </main>
  );
}
