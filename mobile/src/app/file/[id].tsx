import { useQuery } from '@tanstack/react-query';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Card, Chip, Empty, ErrorView, Loading, Muted, PageTile } from '@/components/ui';
import { Space, useColors } from '@/constants/theme';
import { api } from '@/lib/api';
import { formatDateTime, isOpenForReview } from '@/lib/status';

export default function FileScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const c = useColors();
  const [onlyOpen, setOnlyOpen] = useState(true);

  const doc = useQuery({ queryKey: ['document', id], queryFn: () => api.getDocument(id) });
  const pages = useQuery({ queryKey: ['document-pages', id], queryFn: () => api.documentPages(id) });

  const all = useMemo(() => [...(pages.data?.items ?? [])].sort((a, b) => a.ordinal - b.ordinal), [pages.data]);
  const open = all.filter((p) => isOpenForReview(p.page_class, p.review_state));
  const shown = onlyOpen ? open : all;

  if (doc.isLoading) return <Loading />;
  if (doc.isError || !doc.data) return <ErrorView error={doc.error} onRetry={() => doc.refetch()} />;
  const d = doc.data;

  return (
    <>
      <Stack.Screen options={{ title: d.original_filename }} />
      <ScrollView
        style={{ backgroundColor: c.background }}
        contentContainerStyle={{ padding: Space.lg, gap: Space.lg }}
        refreshControl={<RefreshControl refreshing={pages.isRefetching} onRefresh={() => pages.refetch()} tintColor={c.primary} />}
      >
        <Card style={{ gap: 4 }}>
          <Text style={{ color: c.text, fontSize: 17, fontWeight: '700' }}>{d.original_filename}</Text>
          <Muted>
            {d.patient_ref ? `MR ${d.patient_ref} · ` : ''}
            {all.length} pages · {formatDateTime(d.uploaded_at)}
          </Muted>
          <Text style={{ color: c.text, marginTop: Space.sm, fontWeight: '600' }}>
            {open.length} page{open.length === 1 ? '' : 's'} waiting for a decision
          </Text>
        </Card>

        <View style={{ flexDirection: 'row', gap: Space.sm }}>
          <Chip label={`Needs decision (${open.length})`} active={onlyOpen} onPress={() => setOnlyOpen(true)} />
          <Chip label={`All pages (${all.length})`} active={!onlyOpen} onPress={() => setOnlyOpen(false)} />
        </View>

        {pages.isLoading ? (
          <Loading label="Loading pages…" />
        ) : shown.length === 0 ? (
          <Empty title="Nothing waiting in this file" message="Every flagged page has a decision." />
        ) : (
          <View style={styles.grid}>
            {shown.map((p) => (
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
        )}
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: '3.5%', rowGap: Space.lg },
});
