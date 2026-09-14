/**
 * The index column of the case sheet.
 *
 * Role gating here only hides an item — the server is still the authority (see App.tsx). Icons are
 * decorative and always paired with a text label, so nothing here depends on recognising a glyph;
 * that holds at every width, which is why the narrow layout turns this into a scrolling strip of
 * labelled items rather than an icon-only rail.
 *
 * The active item is filled rather than marked with a coloured edge: an inked field is how a
 * printed form says "this one", and it cannot be mistaken for decoration.
 */
import { useState } from 'react';
import { NavLink } from 'react-router-dom';
import {
  LayoutDashboard,
  FileStack,
  ClipboardCheck,
  Stethoscope,
  FilePlus2,
  BarChart3,
  Pill,
  Settings as SettingsIcon,
  LogOut,
  ScanLine,
  Monitor,
  Sun,
  Moon,
  type LucideIcon,
} from 'lucide-react';
import { useAuth } from '../lib/auth';
import { applyTheme, readTheme, THEME_LABEL, THEMES, type Theme } from '../lib/theme';
import type { Role } from '../lib/types';

/**
 * `/documents` and `/upload` are deliberately absent.
 *
 * Neither was removed — both still work at their own address, and `/patients` links into the
 * document list for any record whose scans need the wider view. They left the menu because the
 * patient list now answers the same question in the place a clerk actually starts: a person, not
 * a file. Nothing lost, one fewer fork in the road.
 */
const MAIN_NAV: Array<{ to: string; label: string; role?: Role; icon: LucideIcon }> = [
  { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/patients', label: 'Patient records', icon: FileStack },
  { to: '/review', label: 'Review queue', role: 'reviewer', icon: ClipboardCheck },
  { to: '/rescans', label: 'Awaiting rescan', role: 'reviewer', icon: ScanLine },
  { to: '/diagnoses', label: 'Diagnosis review', role: 'reviewer', icon: Stethoscope },
  { to: '/intake', label: 'New file upload', role: 'uploader', icon: FilePlus2 },
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
    // `contents` on narrow screens: the group dissolves and its items join the one scrolling strip.
    <div className="max-md:contents">
      <p className="field-label px-2 pb-1 pt-3 max-md:hidden">{label}</p>
      {visible.map((n) => {
        const Icon = n.icon;
        return (
          <NavLink
            key={n.to}
            to={n.to}
            className={({ isActive }) =>
              `flex items-center gap-2 whitespace-nowrap px-2 py-1.5 text-[13px] transition-colors duration-150 ease-chart max-md:shrink-0 max-md:border-r max-md:border-rule ${
                isActive ? 'bg-chart font-semibold text-paper' : 'text-ink hover:bg-chart/[0.07]'
              }`
            }
          >
            <Icon size={15} strokeWidth={2} aria-hidden="true" className="shrink-0" />
            {n.label}
          </NavLink>
        );
      })}
    </div>
  );
}

const THEME_ICON: Record<Theme, LucideIcon> = { system: Monitor, light: Sun, dark: Moon };

/**
 * Light / dark / follow the workstation.
 *
 * Three explicit states rather than a two-way switch: "system" is a real answer here, and a
 * toggle that silently pins a machine to one scheme is how a centrally-configured ward display
 * ends up fighting its own site setting.
 */
function ThemeControl() {
  const [theme, setTheme] = useState<Theme>(() => readTheme());

  function choose(next: Theme) {
    setTheme(next);
    applyTheme(next);
  }

  return (
    <div className="hidden border-t border-rule-2 px-2.5 py-2 md:block">
      <p className="field-label mb-1.5">Appearance</p>
      <div role="group" aria-label="Colour scheme" className="flex border border-rule-2">
        {THEMES.map((t) => {
          const Icon = THEME_ICON[t];
          const active = theme === t;
          return (
            <button
              key={t}
              type="button"
              onClick={() => choose(t)}
              aria-pressed={active}
              title={THEME_LABEL[t]}
              className={`flex flex-1 items-center justify-center gap-1 py-1.5 font-label text-[10px] font-semibold uppercase tracking-label transition-colors duration-150 ease-chart [&:not(:first-child)]:border-l [&:not(:first-child)]:border-rule-2 ${
                active ? 'bg-chart text-paper' : 'text-ink-2 hover:bg-chart/[0.07] hover:text-ink'
              }`}
            >
              <Icon size={12} strokeWidth={2.25} aria-hidden="true" />
              {THEME_LABEL[t]}
            </button>
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
    <aside className="flex shrink-0 flex-col border-rule-2 bg-paper-2 max-md:border-b md:h-screen md:w-[13.5rem] md:border-r">
      {/* Masthead. The bordered mark is the neutral placeholder that the hospital's own logo
 replaces once its assets are supplied — see PRODUCT.md, Brand Commitments. */}
      <div className="flex items-center gap-2.5 border-b border-rule-2 px-2.5 py-2">
        <span
          className="grid h-8 w-8 shrink-0 place-items-center border border-ink bg-paper text-ink"
          aria-hidden="true"
        >
          <ScanLine size={17} strokeWidth={2.25} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate font-label text-[13px] font-bold uppercase leading-none tracking-label text-ink">
            OPD Scan QC
          </span>
          <span className="mt-1 block truncate text-[11px] leading-none text-ink-2">
            Patient records
          </span>
        </span>
        {/* On a narrow screen the account controls ride in the masthead, since the footer block
 below is laid out for a tall column. */}
        <span className="flex items-center gap-1.5 md:hidden">
          <span className="truncate text-[11px] text-ink-2">{displayName}</span>
          <button
            type="button"
            onClick={logout}
            aria-label="Sign out"
            title="Sign out"
            className="border border-rule-2 bg-paper p-1.5 text-ink-2 transition-colors duration-150 ease-chart hover:bg-paper-3 hover:text-ink"
          >
            <LogOut size={15} strokeWidth={2} aria-hidden="true" />
          </button>
        </span>
      </div>
      <nav
        aria-label="Main"
        className="flex overflow-x-auto md:flex-1 md:flex-col md:overflow-y-auto md:overflow-x-hidden md:px-1.5 md:pb-3"
      >
        <NavGroup label="Main menu" items={MAIN_NAV} can={can} />
        <NavGroup label="Setting" items={SETTINGS_NAV} can={can} />
      </nav>
      <ThemeControl />

      {/* Signature block, the way a form is signed off at the foot. */}
      <div className="hidden border-t border-rule-2 px-2.5 py-2 md:block">
        <div className="flex items-center gap-2">
          <span
            className="grid h-7 w-7 shrink-0 place-items-center border border-rule-2 bg-paper font-label text-[11px] font-bold tracking-label text-ink-2"
            aria-hidden="true"
          >
            {initials(displayName)}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[12px] font-medium leading-none text-ink">
              {displayName}
            </span>
            <span className="field-label mt-1 block truncate">{user?.role}</span>
          </span>
          <button
            type="button"
            onClick={logout}
            aria-label="Sign out"
            title="Sign out"
            className="shrink-0 border border-rule-2 bg-paper p-1.5 text-ink-2 transition-colors duration-150 ease-chart hover:bg-paper-3 hover:text-ink"
          >
            <LogOut size={15} strokeWidth={2} aria-hidden="true" />
          </button>
        </div>
      </div>
    </aside>
  );
}
