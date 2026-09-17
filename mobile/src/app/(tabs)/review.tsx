import Ionicons from '@expo/vector-icons/Ionicons';
import { useInfiniteQuery } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, RefreshControl, StyleSheet, Text, View } from 'react-native';

import { Card, CountBadge, DateChip, Empty, ErrorView, Loading, Muted, SearchBar } from '@/components/ui';
import { Radius, Space, useColors } from '@/constants/theme';
import { useDebounced } from '@/hooks/use-debounced';
import { api } from '@/lib/api';
import { dayWindow, formatDateTime } from '@/lib/status';
import type { DocumentSummary } from '@/lib/types';

const PAGE = 30;

export default function ReviewScreen() {
  const c = useColors();
  const [search, setSearch] = useState('');
  const [day, setDay] = useState<string | null>(null);
  const q = useDebounced(search, 350);
  const range = useMemo(() => dayWindow(day), [day]);

  const docs = useInfiniteQuery({
    queryKey: ['review-documents', q, day],
    initialPageParam: 0,
    queryFn: ({ pageParam }) => api.reviewDocuments({ search: q, from: range.from, to: range.to, limit: PAGE, offset: pageParam }),
    getNextPageParam: (last) => (last.offset + last.items.length < last.total ? last.offset + last.items.length : undefined),
  });

  const rows = docs.data?.pages.flatMap((p) => p.items) ?? [];
  const total = docs.data?.pages[0]?.total ?? 0;
  const open = rows.reduce((n, d) => n + (d.awaiting_review ?? 0), 0);

  return (
    <View style={{ flex: 1, backgroundColor: c.background }}>
      <View style={styles.filters}>
        <SearchBar value={search} onChange={setSearch} placeholder="File name, MR or IPD" />
        <View style={styles.row}>
          <DateChip value={day} onChange={setDay} label="Uploaded on…" />
          {docs.data ? (
            <Muted>
              {open} open · {total} file{total === 1 ? '' : 's'}
            </Muted>
          ) : null}
        </View>
      </View>

      {docs.isLoading ? (
        <Loading />
      ) : docs.isError ? (
        <ErrorView error={docs.error} onRetry={() => docs.refetch()} />
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(d) => d.id}
          contentContainerStyle={{ padding: Space.lg, paddingTop: 0, gap: Space.md, flexGrow: 1 }}
          renderItem={({ item }) => <FileRow doc={item} />}
          onEndReachedThreshold={0.4}
          onEndReached={() => {
            if (docs.hasNextPage && !docs.isFetchingNextPage) void docs.fetchNextPage();
          }}
          refreshControl={<RefreshControl refreshing={docs.isRefetching && !docs.isFetchingNextPage} onRefresh={() => docs.refetch()} tintColor={c.primary} />}
          ListFooterComponent={docs.isFetchingNextPage ? <ActivityIndicator color={c.primary} style={{ margin: Space.lg }} /> : null}
          ListEmptyComponent={<Empty title="All caught up" message="Nothing is waiting for review." />}
        />
      )}
    </View>
  );
}

function FileRow({ doc }: { doc: DocumentSummary }) {
  const c = useColors();
  const active = doc.pages_active ?? doc.page_count;
  const open = doc.awaiting_review ?? 0;
  const pct = active ? Math.round(((active - open) / active) * 100) : 100;
  return (
    <Card onPress={() => router.push({ pathname: '/file/[id]', params: { id: doc.id } })}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: Space.md }}>
        <Ionicons name="document-text-outline" size={24} color={c.primary} />
        <View style={{ flex: 1 }}>
          <Text style={{ color: c.text, fontSize: 15, fontWeight: '600' }} numberOfLines={1}>
            {doc.original_filename}
          </Text>
          <Muted style={{ fontSize: 13 }}>
            {doc.patient_ref ? `MR ${doc.patient_ref} · ` : ''}
            {formatDateTime(doc.uploaded_at)}
          </Muted>
        </View>
        <CountBadge count={open} active />
      </View>
      <View style={[styles.track, { backgroundColor: c.surfaceAlt, marginTop: Space.md }]}>
        <View style={[styles.bar, { backgroundColor: c.primary, width: `${pct}%` }]} />
      </View>
      <Muted style={{ fontSize: 12, marginTop: 4 }}>
        {pct}% of {active} pages reviewed
      </Muted>
    </Card>
  );
}

const styles = StyleSheet.create({
  filters: { padding: Space.lg, gap: Space.sm },
  row: { flexDirection: 'row', alignItems: 'center', gap: Space.sm, justifyContent: 'space-between' },
  track: { height: 6, borderRadius: Radius.pill, overflow: 'hidden' },
  bar: { height: 6, borderRadius: Radius.pill },
});
