/**
 * Checklist administration.
 *
 * A checklist is the list of documents a complete record of a given kind is expected to contain —
 * the thing gap detection measures a case against. The CRUD endpoints existed from the start and no
 * screen called them, so no checklist could be created, and with none to attach, every completeness
 * panel in the product reported "not verified" permanently. The feature was whole except for the
 * way in.
 *
 * Deactivating is offered alongside deleting because a checklist that has already been used to
 * judge records should stop being offered without rewriting what it once measured.
 */

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import type { Checklist, ChecklistInput } from '../lib/types';
import { Panel } from './Sheet';
import { useToast } from './Toast';
import { Button, ErrorState, Spinner, TextInput } from './ui';
import { Trash2 } from 'lucide-react';

type DraftItem = { doc_type: string; min_pages: string; required: boolean };

const BLANK_ITEM: DraftItem = { doc_type: '', min_pages: '1', required: true };

export function ChecklistsPanel() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [editing, setEditing] = useState<Checklist | 'new' | null>(null);

  const q = useQuery({ queryKey: ['checklists'], queryFn: () => api.listChecklists() });

  const remove = useMutation({
    mutationFn: (id: string) => api.deleteChecklist(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['checklists'] });
      toast.push('Checklist deleted.', 'success');
    },
    onError: (e) =>
      toast.push(e instanceof Error ? e.message : 'Could not delete the checklist.', 'error'),
  });

  if (q.isLoading) return <Spinner label="Loading checklists…" />;
  if (q.isError) return <ErrorState error={q.error} retry={() => q.refetch()} />;

  const lists = q.data ?? [];

  return (
    <Panel
      title="Completeness checklists"
      description="What a complete record of each kind should contain. A case measured against a checklist reports which expected documents are missing; a case with none attached reports nothing."
      actions={
        <Button variant="primary" onClick={() => setEditing('new')}>
          New checklist
        </Button>
      }
    >
      {lists.length === 0 ? (
        <p className="text-[13px] text-ink-2">
          No checklists yet. Until one exists and is attached to a case, completeness stays
          unverified everywhere.
        </p>
      ) : (
        <ul className="divide-y divide-rule">
          {lists.map((c) => (
            <li key={c.id} className="flex flex-wrap items-start gap-3 py-2">
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-medium text-ink">
                  {c.name}
                  {!c.is_active ? (
                    <span className="ml-2 border border-rule-2 px-1.5 py-0.5 text-[11px] text-ink-2">
                      Inactive
                    </span>
                  ) : null}
                </p>
                <p className="mt-0.5 text-[11px] text-ink-2">
                  {c.items && c.items.length > 0
                    ? c.items
                        .map(
                          (i) =>
                            `${i.doc_type}${i.min_pages > 1 ? ` ×${i.min_pages}` : ''}${
                              i.required ? '' : ' (optional)'
                            }`,
                        )
                        .join(' · ')
                    : 'No documents listed — this checklist would find nothing missing.'}
                </p>
              </div>
              <div className="flex shrink-0 gap-2">
                <Button variant="secondary" onClick={() => setEditing(c)}>
                  Edit
                </Button>
                <Button
                  variant="danger"
                  disabled={remove.isPending}
                  onClick={() => remove.mutate(c.id)}
                  aria-label={`Delete ${c.name}`}
                >
                  <Trash2 size={14} strokeWidth={2} aria-hidden="true" />
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {editing ? (
        <ChecklistForm
          existing={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </Panel>
  );
}

function ChecklistForm({ existing, onClose }: { existing: Checklist | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const toast = useToast();

  const [name, setName] = useState(existing?.name ?? '');
  const [isActive, setIsActive] = useState(existing?.is_active ?? true);
  const [items, setItems] = useState<DraftItem[]>(
    existing?.items?.length
      ? existing.items.map((i) => ({
          doc_type: i.doc_type,
          min_pages: String(i.min_pages),
          required: i.required,
        }))
      : [{ ...BLANK_ITEM }],
  );

  const save = useMutation({
    mutationFn: () => {
      const payload: ChecklistInput = {
        name: name.trim(),
        is_active: isActive,
        // Blank rows are dropped rather than saved as an expectation of a document with no name.
        items: items
          .filter((i) => i.doc_type.trim())
          .map((i) => ({
            doc_type: i.doc_type.trim(),
            min_pages: Math.max(1, Number(i.min_pages) || 1),
            required: i.required,
          })),
      };
      return existing ? api.updateChecklist(existing.id, payload) : api.createChecklist(payload);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['checklists'] });
      toast.push(existing ? 'Checklist updated.' : 'Checklist created.', 'success');
      onClose();
    },
    onError: (e) =>
      toast.push(e instanceof Error ? e.message : 'Could not save the checklist.', 'error'),
  });

  const setItem = (index: number, patch: Partial<DraftItem>) =>
    setItems((list) => list.map((it, i) => (i === index ? { ...it, ...patch } : it)));

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim()) save.mutate();
      }}
      className="mt-4 border-t border-rule pt-3"
    >
      <p className="text-[13px] font-semibold text-ink">
        {existing ? `Edit “${existing.name}”` : 'New checklist'}
      </p>

      <div className="mt-2 grid gap-3 sm:grid-cols-2">
        <TextInput
          label="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          hint="What kind of record this describes, e.g. “Surgical admission”."
        />
        <label className="flex items-end gap-2 pb-1 text-[13px] text-ink">
          <input
            type="checkbox"
            checked={isActive}
            onChange={(e) => setIsActive(e.target.checked)}
            className="h-4 w-4"
          />
          Active — offered when attaching a checklist to a case
        </label>
      </div>

      <p className="mt-3 text-[13px] font-medium text-ink">Expected documents</p>
      <ul className="mt-1 space-y-2">
        {items.map((item, index) => (
          <li key={index} className="grid gap-2 sm:grid-cols-[1fr_7rem_9rem_3rem]">
            <TextInput
              label="Document type"
              value={item.doc_type}
              onChange={(e) => setItem(index, { doc_type: e.target.value })}
              placeholder="e.g. Discharge summary"
            />
            <TextInput
              label="Min pages"
              type="number"
              min={1}
              value={item.min_pages}
              onChange={(e) => setItem(index, { min_pages: e.target.value })}
            />
            <label className="flex items-end gap-2 pb-1 text-[13px] text-ink">
              <input
                type="checkbox"
                checked={item.required}
                onChange={(e) => setItem(index, { required: e.target.checked })}
                className="h-4 w-4"
              />
              Required
            </label>
            <div className="flex items-end pb-0.5">
              <Button
                variant="secondary"
                onClick={() => setItems((l) => l.filter((_, i) => i !== index))}
                aria-label={`Remove row ${index + 1}`}
                disabled={items.length === 1}
              >
                <Trash2 size={14} strokeWidth={2} aria-hidden="true" />
              </Button>
            </div>
          </li>
        ))}
      </ul>

      <div className="mt-3 flex flex-wrap gap-2">
        <Button variant="secondary" onClick={() => setItems((l) => [...l, { ...BLANK_ITEM }])}>
          Add document
        </Button>
        <span className="flex-1" />
        <Button variant="secondary" onClick={onClose} disabled={save.isPending}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={!name.trim() || save.isPending}>
          {save.isPending ? 'Saving…' : 'Save checklist'}
        </Button>
      </div>
    </form>
  );
}
