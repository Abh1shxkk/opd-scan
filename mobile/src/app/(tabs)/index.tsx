import Ionicons from '@expo/vector-icons/Ionicons';
import { useInfiniteQuery } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, RefreshControl, StyleSheet, Text, View } from 'react-native';

import { Card, DateChip, Empty, ErrorView, Loading, Muted, Pill, SearchBar } from '@/components/ui';
import { Space, useColors } from '@/constants/theme';
import { useDebounced } from '@/hooks/use-debounced';
import { api } from '@/lib/api';
import { dayWindow, formatDate, formatDateTime } from '@/lib/status';
import type { Case } from '@/lib/types';

const PAGE = 30;

export default function RecordsScreen() {
  const c = useColors();
  const [search, setSearch] = useState('');
  const [day, setDay] = useState<string | null>(null);
  const q = useDebounced(search, 350);
  const range = useMemo(() => dayWindow(day), [day]);

  const records = useInfiniteQuery({
    queryKey: ['cases', q, day],
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      api.listCases({ search: q, created_from: range.from, created_to: range.to, limit: PAGE, offset: pageParam }),
    getNextPageParam: (last) => (last.offset + last.items.length < last.total ? last.offset + last.items.length : undefined),
  });

  const rows = records.data?.pages.flatMap((p) => p.items) ?? [];
  const first = records.data?.pages[0];

  return (
    <View style={{ flex: 1, backgroundColor: c.background }}>
      <View style={styles.filters}>
        <SearchBar value={search} onChange={setSearch} placeholder="Search MR or IPD number" />
        <View style={styles.row}>
          <DateChip value={day} onChange={setDay} label="Entered on…" />
          {first ? (
            <Muted>
              {first.total} of {first.grand_total} records
            </Muted>
          ) : null}
        </View>
      </View>

      {records.isLoading ? (
        <Loading label="Loading records…" />
      ) : records.isError ? (
        <ErrorView error={records.error} onRetry={() => records.refetch()} />
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(item) => item.id}
          contentContainerStyle={{ padding: Space.lg, paddingTop: 0, gap: Space.md, flexGrow: 1 }}
          renderItem={({ item }) => <RecordRow record={item} />}
          onEndReachedThreshold={0.4}
          onEndReached={() => {
            if (records.hasNextPage && !records.isFetchingNextPage) void records.fetchNextPage();
          }}
          refreshControl={<RefreshControl refreshing={records.isRefetching && !records.isFetchingNextPage} onRefresh={() => records.refetch()} tintColor={c.primary} />}
          ListFooterComponent={records.isFetchingNextPage ? <ActivityIndicator color={c.primary} style={{ margin: Space.lg }} /> : null}
          ListEmptyComponent={<Empty icon="people-outline" title="No records found" message={q || day ? 'Try a different search or date.' : undefined} />}
        />
      )}
    </View>
  );
}

function RecordRow({ record }: { record: Case }) {
  const c = useColors();
  const working = record.documents_pending > 0 || record.jobs_active > 0;
  return (
    <Card onPress={() => router.push({ pathname: '/patient/[id]', params: { id: record.id } })}>
      <View style={styles.rowTop}>
        <View style={{ flex: 1 }}>
          <Text style={{ color: c.text, fontSize: 16, fontWeight: '700' }} numberOfLines={1}>
            {record.patient_name || 'Name not recorded'}
          </Text>
          <Muted>
            MR {record.patient_ref} · IPD {record.encounter_ref}
          </Muted>
        </View>
        <Ionicons name="chevron-forward" size={20} color={c.textSecondary} />
      </View>

      <View style={[styles.row, { marginTop: Space.sm, flexWrap: 'wrap' }]}>
        {record.department ? <Pill view={{ label: record.department, tone: 'info' }} small /> : null}
        {working ? (
          <Pill view={{ label: 'Processing…', tone: 'warn' }} small />
        ) : record.ingest_failed > 0 ? (
          <Pill view={{ label: 'Upload problem', tone: 'bad' }} small />
        ) : null}
        <Muted style={{ fontSize: 13 }}>
          {record.page_count} page{record.page_count === 1 ? '' : 's'}
        </Muted>
      </View>

      <Muted style={{ fontSize: 12, marginTop: Space.sm }}>
        {record.admission_date ? `Admitted ${formatDate(record.admission_date)} · ` : ''}Entered {formatDateTime(record.created_at)}
      </Muted>
    </Card>
  );
}

const styles = StyleSheet.create({
  filters: { padding: Space.lg, gap: Space.sm },
  row: { flexDirection: 'row', alignItems: 'center', gap: Space.sm, justifyContent: 'space-between' },
  rowTop: { flexDirection: 'row', alignItems: 'center', gap: Space.sm },
});
