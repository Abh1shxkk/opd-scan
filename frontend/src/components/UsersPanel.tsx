/**
 * User administration.
 *
 * The endpoints and the client wrappers for this existed from the start; no screen ever called
 * them, so the only way to add a colleague, change a role or revoke access was to reach into the
 * database. On a system where role is the whole access-control model, that is the one admin task
 * that cannot be missing.
 *
 * Deactivating rather than deleting is deliberate and matches the backend: a user's name is
 * attached to review decisions in the audit trail, and deleting the row would orphan them.
 */

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatDateTime } from '../lib/status';
import type { Role, User } from '../lib/types';
import { Panel } from './Sheet';
import { useToast } from './Toast';
import { Button, ErrorState, Select, Spinner, TextInput } from './ui';

const ROLES: Role[] = ['admin', 'reviewer', 'uploader'];

const ROLE_BLURB: Record<Role, string> = {
  admin: 'Everything, including settings and user administration.',
  reviewer: 'Can accept pages, request rescans and correct readings.',
  uploader: 'Can add records and documents.',
};

export function UsersPanel() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const { user: me } = useAuth();
  const [adding, setAdding] = useState(false);

  const q = useQuery({ queryKey: ['users'], queryFn: () => api.listUsers() });

  const update = useMutation({
    mutationFn: (vars: { id: string; payload: { role?: string; is_active?: boolean } }) =>
      api.updateUser(vars.id, vars.payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['users'] });
      toast.push('User updated.', 'success');
    },
    onError: (e) => toast.push(e instanceof Error ? e.message : 'Could not update the user.', 'error'),
  });

  if (q.isLoading) return <Spinner label="Loading users…" />;
  if (q.isError) return <ErrorState error={q.error} retry={() => q.refetch()} />;

  const users = q.data ?? [];

  return (
    <Panel
      title="Users"
      description="Roles decide what each person can do. Access is revoked by deactivating an account, never by deleting it — names are attached to review decisions in the audit trail."
      actions={
        <Button variant="primary" onClick={() => setAdding(true)}>
          Add user
        </Button>
      }
    >
      <ul className="divide-y divide-rule">
        {users.map((u) => (
          <UserRow
            key={u.id}
            user={u}
            isSelf={u.id === me?.id}
            busy={update.isPending}
            onChange={(payload) => update.mutate({ id: u.id, payload })}
          />
        ))}
      </ul>

      {users.length === 0 ? <p className="text-[13px] text-ink-2">No users yet.</p> : null}

      {adding ? <AddUserForm onClose={() => setAdding(false)} /> : null}
    </Panel>
  );
}

function UserRow({
  user,
  isSelf,
  busy,
  onChange,
}: {
  user: User;
  isSelf: boolean;
  busy: boolean;
  onChange: (payload: { role?: string; is_active?: boolean }) => void;
}) {
  return (
    <li className="flex flex-wrap items-center gap-3 py-2">
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] font-medium text-ink">
          {user.full_name || user.email}
          {isSelf ? <span className="ml-1.5 text-[11px] text-ink-2">(you)</span> : null}
        </p>
        <p className="truncate text-[11px] text-ink-2">
          {user.email}
          {user.created_at ? ` · added ${formatDateTime(user.created_at)}` : ''}
        </p>
      </div>

      <label className="shrink-0">
        <span className="sr-only">Role for {user.email}</span>
        <select
          value={user.role}
          disabled={busy || isSelf}
          onChange={(e) => onChange({ role: e.target.value })}
          className="border border-rule-2 bg-paper px-2 py-1 text-[13px] text-ink disabled:text-ink-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
        >
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
      </label>

      {/* The backend refuses to let an admin deactivate themselves; the control is disabled here
          too so the refusal is never a surprise after the click. */}
      <Button
        variant={user.is_active ? 'secondary' : 'primary'}
        disabled={busy || isSelf}
        onClick={() => onChange({ is_active: !user.is_active })}
      >
        {user.is_active ? 'Deactivate' : 'Reactivate'}
      </Button>

      {!user.is_active ? (
        <span className="shrink-0 border border-rule-2 px-1.5 py-0.5 text-[11px] text-ink-2">
          Inactive
        </span>
      ) : null}
    </li>
  );
}

function AddUserForm({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [email, setEmail] = useState('');
  const [fullName, setFullName] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<Role>('uploader');

  const create = useMutation({
    mutationFn: () =>
      api.createUser({ email: email.trim(), full_name: fullName.trim(), password, role }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['users'] });
      toast.push(`${email.trim()} added. Ask them to change this password on first sign-in.`, 'success');
      onClose();
    },
    onError: (e) => toast.push(e instanceof Error ? e.message : 'Could not add the user.', 'error'),
  });

  const ready = email.trim().length > 0 && password.length >= 8;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (ready) create.mutate();
      }}
      className="mt-4 border-t border-rule pt-3"
    >
      <p className="text-[13px] font-semibold text-ink">New user</p>

      <div className="mt-2 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <TextInput
          label="Email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          autoComplete="off"
        />
        <TextInput label="Full name" value={fullName} onChange={(e) => setFullName(e.target.value)} />
        <TextInput
          label="Temporary password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          autoComplete="new-password"
          hint="At least 8 characters."
        />
        <Select label="Role" value={role} onChange={(e) => setRole(e.target.value as Role)}>
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </Select>
      </div>

      <p className="mt-1 text-[11px] text-ink-2">{ROLE_BLURB[role]}</p>

      <div className="mt-3 flex gap-2">
        <Button variant="secondary" onClick={onClose} disabled={create.isPending}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={!ready || create.isPending}>
          {create.isPending ? 'Adding…' : 'Add user'}
        </Button>
        {!ready && password.length > 0 && password.length < 8 ? (
          <span className="self-center text-[11px] text-ink-2">Password needs 8 characters.</span>
        ) : null}
      </div>
    </form>
  );
}
