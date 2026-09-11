/**
 * Sign in.
 *
 * The first sheet in the pad: a printed masthead, two boxed fields, and the footer notice that
 * tells a user what they are about to enter. The sheet sits on a plain ground — the printed
 * measuring grid belongs only to regions that actually plot a value, never to a page as texture.
 */

import { useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { ScanLine, TriangleAlert } from 'lucide-react';
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
    <main className="flex h-screen items-center justify-center overflow-y-auto bg-paper-2 p-4">
      <div className="w-full max-w-[23rem] border border-rule-2 bg-paper">
        {/* Masthead. The bordered mark is the neutral placeholder the hospital's own logo
            replaces once its assets are supplied — see PRODUCT.md, Brand Commitments. */}
        <div className="flex items-center gap-2.5 border-b border-rule-2 bg-paper-3 px-4 py-3">
          <span
            className="grid h-9 w-9 shrink-0 place-items-center border border-ink bg-paper text-ink"
            aria-hidden="true"
          >
            <ScanLine size={19} strokeWidth={2.25} />
          </span>
          <span className="min-w-0">
            <span className="block truncate font-label text-[14px] font-bold uppercase leading-none tracking-label text-ink">
              OPD Scan QC
            </span>
            <span className="mt-1 block truncate text-[11px] leading-none text-ink-2">
              Scan quality control for patient records
            </span>
          </span>
        </div>

        <form onSubmit={onSubmit} className="p-4">
          <h1 className="rule-double pb-2 text-[17px] font-semibold leading-tight tracking-tight text-ink">
            Sign in
          </h1>

          <div className="mt-3 space-y-3">
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
          </div>

          {/* role=alert so the failure is announced, not merely rendered. */}
          {error ? (
            <p
              role="alert"
              className="mt-3 flex gap-2 border border-plot/50 bg-plot/[0.07] px-2.5 py-2 text-[13px] text-ink"
            >
              <TriangleAlert
                size={14}
                strokeWidth={2.5}
                aria-hidden="true"
                className="mt-[2px] shrink-0 text-plot"
              />
              <span className="min-w-0">{error}</span>
            </p>
          ) : null}

          <Button type="submit" variant="primary" disabled={busy} className="mt-4 w-full">
            {busy ? 'Signing in…' : 'Sign in'}
          </Button>
        </form>

        {/* The footer notice a printed form carries: what this record is, and that it is logged. */}
        <p className="border-t border-rule-2 bg-paper-2 px-4 py-2.5 text-[11px] leading-snug text-ink-2">
          This system holds patient data. Access is recorded in an audit log.
        </p>
      </div>
    </main>
  );
}
