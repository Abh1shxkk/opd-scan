/**
 * Left-hand navigation shell.
 *
 * Role gating here only hides an item — the server is still the authority (see App.tsx). Icons are
 * decorative and always paired with a text label, so nothing here depends on recognising a glyph.
 */

import { NavLink } from 'react-router-dom';
import {
  LayoutDashboard,
  FileStack,
  ClipboardCheck,
  Stethoscope,
  UploadCloud,
  BarChart3,
  Pill,
  Settings as SettingsIcon,
  LogOut,
  ScanLine,
  type LucideIcon,
} from 'lucide-react';
import { useAuth } from '../lib/auth';
import type { Role } from '../lib/types';
import { FOCUS_RING } from './ui';

const MAIN_NAV: Array<{ to: string; label: string; role?: Role; icon: LucideIcon }> = [
  { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/documents', label: 'Documents', icon: FileStack },
  { to: '/review', label: 'Review queue', role: 'reviewer', icon: ClipboardCheck },
  { to: '/diagnoses', label: 'Diagnosis review', role: 'reviewer', icon: Stethoscope },
  { to: '/upload', label: 'Upload', role: 'uploader', icon: UploadCloud },
  { to: '/prescriptions', label: 'Prescription analyzer', role: 'uploader', icon: Pill },
  { to: '/reports', label: 'Reports', icon: BarChart3 },
];

const SETTINGS_NAV: Array<{ to: string; label: string; role?: Role; icon: LucideIcon }> = [
  { to: '/settings', label: 'Settings', role: 'admin', icon: SettingsIcon },
];

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  const first = parts[0]?.[0] ?? '';
  const last = parts.length > 1 ? parts[parts.length - 1][0] : '';
  return (first + last).toUpperCase() || '?';
}

function NavGroup({
  label,
  items,
  can,
}: {
  label: string;
  items: Array<{ to: string; label: string; role?: Role; icon: LucideIcon }>;
  can: (role: Role) => boolean;
}) {
  const visible = items.filter((n) => !n.role || can(n.role));
  if (visible.length === 0) return null;

  return (
    <div>
      <p className="px-3 pb-1.5 pt-4 text-[11px] font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500">
        {label}
      </p>
      <div className="space-y-0.5">
        {visible.map((n) => {
          const Icon = n.icon;
          return (
            <NavLink
              key={n.to}
              to={n.to}
              className={({ isActive }) =>
                `flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors ${FOCUS_RING} ${
                  isActive
                    ? 'bg-slate-100 font-semibold text-slate-900 dark:bg-slate-800 dark:text-slate-50'
                    : 'font-medium text-slate-500 hover:bg-slate-50 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800/60 dark:hover:text-slate-50'
                }`
              }
            >
              <Icon size={17} strokeWidth={2} />
              {n.label}
            </NavLink>
          );
        })}
      </div>
    </div>
  );
}

export function Sidebar() {
  const { user, logout, can } = useAuth();
  const displayName = user?.full_name || user?.email || '';

  return (
    <aside className="flex h-screen w-64 shrink-0 flex-col border-r border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
      <div className="flex items-center gap-2.5 border-b border-slate-100 px-5 py-5 dark:border-slate-800">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-sky-700 text-white dark:bg-sky-600">
          <ScanLine size={19} strokeWidth={2.25} aria-hidden="true" />
        </span>
        <span className="min-w-0">
          <span className="block truncate text-sm font-semibold text-slate-900 dark:text-slate-50">
            Scan QC
          </span>
          <span className="block truncate text-xs text-slate-500 dark:text-slate-400">Patient records</span>
        </span>
      </div>

      <nav aria-label="Main" className="flex-1 overflow-y-auto px-3 pb-4">
        <NavGroup label="Main menu" items={MAIN_NAV} can={can} />
        <NavGroup label="Setting" items={SETTINGS_NAV} can={can} />
      </nav>

      <div className="p-3">
        <div className="flex items-center gap-2.5 rounded-xl bg-slate-50 px-2.5 py-2.5 dark:bg-slate-800/60">
          <span
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-200 text-xs font-semibold text-slate-700 dark:bg-slate-700 dark:text-slate-200"
            aria-hidden="true"
          >
            {initials(displayName)}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium text-slate-900 dark:text-slate-50">
              {displayName}
            </span>
            <span className="block truncate text-xs capitalize text-slate-500 dark:text-slate-400">
              {user?.role}
            </span>
          </span>
          <button
            type="button"
            onClick={logout}
            aria-label="Sign out"
            title="Sign out"
            className={`shrink-0 rounded-lg p-1.5 text-slate-400 hover:bg-slate-200 hover:text-slate-900 dark:text-slate-500 dark:hover:bg-slate-700 dark:hover:text-slate-50 ${FOCUS_RING}`}
          >
            <LogOut size={16} strokeWidth={2} />
          </button>
        </div>
      </div>
    </aside>
  );
}
