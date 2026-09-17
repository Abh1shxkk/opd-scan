import { useQuery } from '@tanstack/react-query';
import { router, useLocalSearchParams } from 'expo-router';
import { RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Card, Empty, ErrorView, Loading, Muted, PageTile, SectionLabel } from '@/components/ui';
import { Space, useColors } from '@/constants/theme';
import { api } from '@/lib/api';
import { formatDate, formatDateTime } from '@/lib/status';

export default function PatientScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const c = useColors();

  const record = useQuery({ queryKey: ['case', id], queryFn: () => api.getCase(id) });
  const pages = useQuery({ queryKey: ['case-pages', id], queryFn: () => api.casePages(id) });

  if (record.isLoading) return <Loading />;
  if (record.isError || !record.data) return <ErrorView error={record.error} onRetry={() => record.refetch()} />;

  const r = record.data;
  // Grouped by file, pages in scan order.
  const byFile = new Map<string, { name: string; items: NonNullable<typeof pages.data>['items'] }>();
  for (const p of pages.data?.items ?? []) {
    const g = byFile.get(p.document_id) ?? { name: p.document_filename, items: [] };
    g.items.push(p);
    byFile.set(p.document_id, g);
  }

  const details: Array<[string, string]> = [
    ['IPD number', r.encounter_ref],
    ['Department', r.department],
    ['Mobile', r.mobile],
    ['Consultant', r.consultant_name],
    ['Disease', r.disease],
    ['ICD code', r.icd_code],
    ['Discharge type', r.discharge_type],
    ['MLC type', r.mlc_type],
    ['Admission', r.admission_date ? formatDate(r.admission_date) : ''],
    ['Discharge', r.discharge_date ? formatDate(r.discharge_date) : ''],
    ['Record date', r.record_date ? formatDate(r.record_date) : ''],
    ['Entered', formatDateTime(r.created_at)],
  ];

  return (
    <ScrollView
      style={{ backgroundColor: c.background }}
      contentContainerStyle={{ padding: Space.lg, gap: Space.lg }}
      refreshControl={<RefreshControl refreshing={record.isRefetching || pages.isRefetching} onRefresh={() => { void record.refetch(); void pages.refetch(); }} tintColor={c.primary} />}
    >
      <Card style={{ gap: 2 }}>
        <Text style={{ color: c.text, fontSize: 20, fontWeight: '700' }}>{r.patient_name || 'Name not recorded'}</Text>
        <Muted>MR {r.patient_ref}</Muted>
      </Card>

      <SectionLabel>Details</SectionLabel>
      <Card style={{ paddingVertical: Space.sm }}>
        {details.map(([k, v], i) => (
          <View key={k} style={[styles.detail, i > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderColor: c.border }]}>
            <Muted style={{ fontSize: 14, flex: 1 }}>{k}</Muted>
            <Text style={{ color: v ? c.text : c.textSecondary, fontSize: 14, flex: 1.4, textAlign: 'right' }}>{v || '—'}</Text>
          </View>
        ))}
      </Card>

      <SectionLabel>Scans</SectionLabel>
      {pages.isLoading ? (
        <Loading label="Loading pages…" />
      ) : byFile.size === 0 ? (
        <Card>
          <Empty icon="document-outline" title="No scans attached yet" />
        </Card>
      ) : (
        [...byFile.entries()].map(([docId, g]) => (
          <Card key={docId} style={{ gap: Space.md }}>
            <Text style={{ color: c.text, fontWeight: '600' }} numberOfLines={1}>
              {g.name}
            </Text>
            <View style={styles.grid}>
              {g.items
                .sort((a, b) => a.ordinal - b.ordinal)
                .map((p) => (
                  <PageTile
                    key={p.page_version_id}
                    pageVersionId={p.page_version_id}
                    ordinal={p.ordinal}
                    pageClass={p.page_class}
                    reviewState={p.review_state}
                    onPress={() => router.push({ pathname: '/page/[id]', params: { id: p.page_version_id } })}
                  />
                ))}
            </View>
          </Card>
        ))
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  detail: { flexDirection: 'row', paddingVertical: 10, gap: Space.md },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: '3.5%', rowGap: Space.md },
});
