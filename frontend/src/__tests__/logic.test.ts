/**
 * The pure logic behind filters, paging and status wording. These are the pieces that silently
 * showed wrong data before (UTC days, ignored paging, "review required" on accepted pages), so each
 * is pinned here.
 */

import { describe, expect, it } from 'vitest';
import { pageParams } from '../components/Pager';
import { groupByFile, toUploadWindow } from '../components/WorkFilters';
import { EMPTY_FILTERS, toApiSearchParams, toSearchParams } from '../lib/filters';
import { pageClassView } from '../lib/status';

describe('pageParams', () => {
  it('turns a page number into limit and offset', () => {
    expect(pageParams(1)).toEqual({ limit: '50', offset: '0' });
    expect(pageParams(3, 20)).toEqual({ limit: '20', offset: '40' });
    expect(pageParams(0)).toEqual({ limit: '50', offset: '0' });
  });
});

describe('date filters use the local day', () => {
  it('sends the instant the local day starts and ends', () => {
    const sp = toApiSearchParams({ ...EMPTY_FILTERS, from: '2026-09-17', to: '2026-09-17' });
    expect(sp.get('from')).toBe(new Date('2026-09-17T00:00:00').toISOString());
    expect(sp.get('to')).toBe(new Date('2026-09-17T23:59:59.999').toISOString());
  });

  it('leaves the address-bar query string as plain dates', () => {
    const sp = toSearchParams({ ...EMPTY_FILTERS, from: '2026-09-17' });
    expect(sp.get('from')).toBe('2026-09-17');
  });

  it('builds an upload window only when a day is chosen', () => {
    expect(toUploadWindow({ search: '', day: '', fromTime: '10:00', toTime: '' })).toEqual({});
    const w = toUploadWindow({ search: '', day: '2026-09-17', fromTime: '10:00', toTime: '11:30' });
    expect(w.from).toBe(new Date('2026-09-17T10:00:00').toISOString());
    expect(w.to).toBe(new Date('2026-09-17T11:30:59.999').toISOString());
  });
});

describe('groupByFile', () => {
  it('keeps first-seen order and groups rows by document', () => {
    const rows = [
      { doc: 'b', n: 1 },
      { doc: 'a', n: 2 },
      { doc: 'b', n: 3 },
    ];
    const groups = groupByFile(rows, (r) => ({ documentId: r.doc, filename: `${r.doc}.pdf` }));
    expect(groups.map((g) => g.documentId)).toEqual(['b', 'a']);
    expect(groups[0].items.map((r) => r.n)).toEqual([1, 3]);
  });
});

describe('pageClassView', () => {
  it('shows an accepted page as acceptable', () => {
    for (const c of ['review', 'rescan'] as const) {
      const v = pageClassView(c, 'accepted');
      expect(v.label).toBe(pageClassView('acceptable').label);
      expect(v.qualifier).toBe('accepted by reviewer');
    }
  });

  it('keeps the engine verdict when nobody has accepted the page', () => {
    expect(pageClassView('rescan', 'pending').label).not.toBe(pageClassView('acceptable').label);
    expect(pageClassView('rescan').label).not.toBe(pageClassView('acceptable').label);
  });
});
