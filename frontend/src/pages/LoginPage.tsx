/**
 * Sign in.
 *
 * Two halves: on the left, an illustration of what the product does — a record being scanned and
 * checked — so the first screen says what this is; on the right, the form. The illustration is
 * inline SVG (no external image to fail to load on a hospital network) and holds still for anyone
 * who has asked for reduced motion. On a phone only the form is shown.
 */

import { useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import {
  Eye,
  EyeOff,
  FileSearch,
  Lock,
  ScanLine,
  ShieldCheck,
  Stethoscope,
  TriangleAlert,
  User,
} from 'lucide-react';
import { useAuth } from '../lib/auth';

const FIELD =
  'h-11 w-full border border-rule-2 bg-paper pl-10 pr-3 text-[15px] text-ink placeholder:text-ink-2/60 transition-colors focus:border-chart focus:outline-none focus-visible:ring-2 focus-visible:ring-chart/25';

export default function LoginPage() {
  const { login, isAuthenticated } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from ?? '/dashboard';

  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [capsLock, setCapsLock] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (isAuthenticated) return <Navigate to={from} replace />;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(identifier, password);
      navigate(from, { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign in failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="grid min-h-screen bg-paper lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
      {/* ------------------------------------------------ illustration */}
      <section
        aria-hidden="true"
        className="relative hidden overflow-hidden bg-chart text-paper lg:flex lg:flex-col lg:justify-between lg:p-12"
      >
        {/* soft grid texture */}
        <svg className="absolute inset-0 h-full w-full opacity-[0.07]" aria-hidden="true">
          <defs>
            <pattern id="login-grid" width="32" height="32" patternUnits="userSpaceOnUse">
              <path d="M32 0H0V32" fill="none" stroke="currentColor" strokeWidth="1" />
            </pattern>
          </defs>
          <rect width="100%" height="100%" fill="url(#login-grid)" />
        </svg>

        <div className="relative flex items-center gap-3">
          <span className="grid h-10 w-10 place-items-center rounded-full bg-paper/15">
            <ScanLine size={20} strokeWidth={2.25} />
          </span>
          <span className="text-[17px] font-semibold tracking-tight">OPD Scan QC</span>
        </div>

        <div className="relative mx-auto my-8 w-full max-w-[26rem]">
          <ScanIllustration />
        </div>

        <div className="relative max-w-[28rem]">
          <h2 className="text-[28px] font-semibold leading-tight tracking-tight">
            Every patient record, scanned right the first time.
          </h2>
          <ul className="mt-6 space-y-3 text-[15px] text-paper/90">
            <li className="flex items-center gap-3">
              <FileSearch size={18} className="shrink-0 text-paper/70" />
              Quality checked automatically on upload
            </li>
            <li className="flex items-center gap-3">
              <Stethoscope size={18} className="shrink-0 text-paper/70" />
              Diagnoses read from the page, confirmed by a reviewer
            </li>
            <li className="flex items-center gap-3">
              <ShieldCheck size={18} className="shrink-0 text-paper/70" />
              Every access recorded in an audit log
            </li>
          </ul>
        </div>
      </section>

      {/* ------------------------------------------------ form */}
      <section className="flex items-center justify-center p-6 sm:p-10">
        <div className="login-rise w-full max-w-[24rem]">
          <div className="mb-8 flex items-center gap-3 lg:hidden">
            <span className="grid h-10 w-10 place-items-center rounded-full bg-chart text-paper">
              <ScanLine size={20} strokeWidth={2.25} aria-hidden="true" />
            </span>
            <span className="text-[17px] font-semibold tracking-tight text-ink">OPD Scan QC</span>
          </div>

          <h1 className="text-[28px] font-semibold leading-tight tracking-tight text-ink">Welcome back</h1>
          <p className="mt-1.5 text-[15px] text-ink-2">Sign in to continue to your work queue.</p>

          <form onSubmit={onSubmit} className="mt-8 space-y-4">
            <div>
              <label htmlFor="login-identifier" className="mb-1.5 block text-[14px] font-medium text-ink">
                Username or email
              </label>
              <div className="relative">
                <User
                  size={17}
                  aria-hidden="true"
                  className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-2"
                />
                {/* type="text", not "email": staff are issued usernames, and the browser would
                    otherwise refuse a perfectly valid one for not containing an "@". */}
                <input
                  id="login-identifier"
                  type="text"
                  name="username"
                  autoComplete="username"
                  autoFocus
                  required
                  placeholder="e.g. ward_clerk"
                  value={identifier}
                  onChange={(e) => setIdentifier(e.target.value)}
                  className={FIELD}
                />
              </div>
            </div>

            <div>
              <label htmlFor="login-password" className="mb-1.5 block text-[14px] font-medium text-ink">
                Password
              </label>
              <div className="relative">
                <Lock
                  size={17}
                  aria-hidden="true"
                  className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-2"
                />
                <input
                  id="login-password"
                  type={showPassword ? 'text' : 'password'}
                  name="password"
                  autoComplete="current-password"
                  required
                  placeholder="Your password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  onKeyUp={(e) => setCapsLock(e.getModifierState('CapsLock'))}
                  onKeyDown={(e) => setCapsLock(e.getModifierState('CapsLock'))}
                  className={`${FIELD} pr-11`}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  aria-pressed={showPassword}
                  className="absolute right-1.5 top-1/2 grid h-8 w-8 -translate-y-1/2 place-items-center text-ink-2 hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
                >
                  {showPassword ? <EyeOff size={17} /> : <Eye size={17} />}
                </button>
              </div>
              {capsLock ? (
                <p className="mt-1.5 flex items-center gap-1.5 text-[13px] text-note">
                  <TriangleAlert size={13} aria-hidden="true" />
                  Caps Lock is on
                </p>
              ) : null}
            </div>

            {/* role=alert so the failure is announced, not merely rendered. */}
            {error ? (
              <p
                role="alert"
                className="flex gap-2 border border-plot/40 bg-plot/[0.07] px-3 py-2.5 text-[14px] text-ink"
              >
                <TriangleAlert size={16} aria-hidden="true" className="mt-[2px] shrink-0 text-plot" />
                <span className="min-w-0">{error}</span>
              </p>
            ) : null}

            <button
              type="submit"
              disabled={busy}
              className="flex h-11 w-full items-center justify-center gap-2 bg-chart text-[15px] font-semibold text-paper transition-all duration-150 hover:bg-chart/90 active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-70 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
            >
              {busy ? (
                <>
                  <span
                    className="h-4 w-4 animate-spin rounded-full border-2 border-paper/40 border-t-paper"
                    aria-hidden="true"
                  />
                  Signing in…
                </>
              ) : (
                'Sign in'
              )}
            </button>
          </form>

          <p className="mt-8 flex items-center gap-2 text-[13px] text-ink-2">
            <ShieldCheck size={15} aria-hidden="true" className="shrink-0" />
            This system holds patient data. Access is recorded in an audit log.
          </p>
        </div>
      </section>
    </main>
  );
}

/** A record sheet being scanned, with its checks ticking off. Decorative. */
function ScanIllustration() {
  return (
    <svg viewBox="0 0 420 300" className="h-auto w-full" role="presentation">
      {/* back sheet */}
      <g className="login-float-slow">
        <rect x="200" y="40" width="170" height="220" rx="6" fill="currentColor" opacity="0.12" />
        <rect x="222" y="70" width="110" height="8" rx="4" fill="currentColor" opacity="0.25" />
        <rect x="222" y="90" width="126" height="6" rx="3" fill="currentColor" opacity="0.18" />
        <rect x="222" y="106" width="96" height="6" rx="3" fill="currentColor" opacity="0.18" />
      </g>

      {/* main sheet */}
      <g className="login-float">
        <rect x="70" y="20" width="200" height="260" rx="8" fill="currentColor" opacity="0.95" />
        <g fill="rgb(var(--c-chart))">
          <rect x="94" y="46" width="90" height="10" rx="5" opacity="0.9" />
          <rect x="94" y="66" width="140" height="6" rx="3" opacity="0.35" />
          <rect x="94" y="80" width="120" height="6" rx="3" opacity="0.35" />
          <rect x="94" y="108" width="60" height="6" rx="3" opacity="0.6" />
          <rect x="94" y="122" width="150" height="6" rx="3" opacity="0.3" />
          <rect x="94" y="136" width="132" height="6" rx="3" opacity="0.3" />
          <rect x="94" y="164" width="70" height="6" rx="3" opacity="0.6" />
          <rect x="94" y="178" width="146" height="6" rx="3" opacity="0.3" />
          <rect x="94" y="192" width="110" height="6" rx="3" opacity="0.3" />
          <path d="M96 236 q14 -16 28 0 t28 0 t28 0" fill="none" stroke="rgb(var(--c-chart))" strokeWidth="3" strokeLinecap="round" opacity="0.55" />
        </g>

        {/* scan beam */}
        <g className="login-scanline">
          <rect x="60" y="44" width="220" height="3" rx="1.5" fill="#7dd3fc" />
          <rect x="60" y="30" width="220" height="16" fill="#7dd3fc" opacity="0.18" />
        </g>
      </g>

      {/* checks */}
      <g>
        <g className="login-pop">
          <circle cx="318" cy="170" r="20" fill="#22c55e" />
          <path d="M309 170 l6 6 l12 -13" fill="none" stroke="#fff" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
        </g>
        <rect x="346" y="162" width="56" height="7" rx="3.5" fill="currentColor" opacity="0.5" />
        <rect x="346" y="175" width="40" height="6" rx="3" fill="currentColor" opacity="0.3" />
      </g>
      <g>
        <circle cx="318" cy="222" r="20" fill="currentColor" opacity="0.18" />
        <rect x="346" y="214" width="50" height="7" rx="3.5" fill="currentColor" opacity="0.35" />
        <rect x="346" y="227" width="34" height="6" rx="3" fill="currentColor" opacity="0.22" />
      </g>
    </svg>
  );
}
