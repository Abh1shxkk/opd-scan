import Ionicons from '@expo/vector-icons/Ionicons';
import { useQuery } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, RefreshControl, SectionList, StyleSheet, Text, View } from 'react-native';

import { ReplacePageSheet } from '@/components/replace-page';
import { Card, DateChip, Empty, ErrorView, Loading, Muted, PageImage, SearchBar } from '@/components/ui';
import { Radius, Space, useColors } from '@/constants/theme';
import { useDebounced } from '@/hooks/use-debounced';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { dayWindow, formatDateTime } from '@/lib/status';
import type { PageSummary } from '@/lib/types';

export default function RescanScreen() {
  const c = useColors();
  const { can } = useAuth();
  const [search, setSearch] = useState('');
  const [day, setDay] = useState<string | null>(null);
  const [replacing, setReplacing] = useState<PageSummary | null>(null);
  const q = useDebounced(search, 350);
  const range = useMemo(() => dayWindow(day), [day]);

  const pages = useQuery({
    queryKey: ['rescan-queue', q, day],
    queryFn: () => api.rescanPages({ search: q, from: range.from, to: range.to }),
  });

  // One section per file, so a scanner operator works one physical file at a time.
  const sections = useMemo(() => {
    const map = new Map<string, { title: string; mr?: string | null; data: PageSummary[] }>();
    for (const p of pages.data?.items ?? []) {
      const s = map.get(p.document_id) ?? { title: p.document_filename, mr: p.patient_ref, data: [] };
      s.data.push(p);
      map.set(p.document_id, s);
    }
    return [...map.values()].map((s) => ({ ...s, data: s.data.sort((a, b) => a.ordinal - b.ordinal) }));
  }, [pages.data]);

  const count = pages.data?.items.length ?? 0;

  return (
    <View style={{ flex: 1, backgroundColor: c.background }}>
      <View style={styles.filters}>
        <SearchBar value={search} onChange={setSearch} placeholder="File name, MR or IPD" />
        <View style={styles.row}>
          <DateChip value={day} onChange={setDay} label="Uploaded on…" />
          {pages.data ? (
            <Muted>
              {count} page{count === 1 ? '' : 's'} · {sections.length} file{sections.length === 1 ? '' : 's'}
            </Muted>
          ) : null}
        </View>
      </View>

      {pages.isLoading ? (
        <Loading />
      ) : pages.isError ? (
        <ErrorView error={pages.error} onRetry={() => pages.refetch()} />
      ) : (
        <SectionList
          sections={sections}
          keyExtractor={(p) => p.page_version_id}
          stickySectionHeadersEnabled={false}
          contentContainerStyle={{ padding: Space.lg, paddingTop: 0, gap: Space.sm, flexGrow: 1 }}
          refreshControl={<RefreshControl refreshing={pages.isRefetching} onRefresh={() => pages.refetch()} tintColor={c.primary} />}
          renderSectionHeader={({ section }) => (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: Space.sm, marginTop: Space.md }}>
              <Ionicons name="document-text-outline" size={18} color={c.primary} />
              <Text style={{ color: c.text, fontWeight: '700', flex: 1 }} numberOfLines={1}>
                {section.title}
              </Text>
              {section.mr ? <Muted style={{ fontSize: 13 }}>MR {section.mr}</Muted> : null}
            </View>
          )}
          renderItem={({ item }) => (
            <Card style={{ flexDirection: 'row', alignItems: 'center', gap: Space.md, padding: Space.md }}>
              <Pressable onPress={() => router.push({ pathname: '/page/[id]', params: { id: item.page_version_id } })}>
                <PageImage pageVersionId={item.page_version_id} style={[styles.thumb, { borderColor: c.border }]} />
              </Pressable>
              <View style={{ flex: 1 }}>
                <Text style={{ color: c.text, fontSize: 16, fontWeight: '700' }}>Page {item.ordinal}</Text>
                <Muted style={{ fontSize: 13 }}>Uploaded {formatDateTime(item.uploaded_at)}</Muted>
              </View>
              {can('uploader') ? (
                <Pressable
                  onPress={() => setReplacing(item)}
                  style={({ pressed }) => [styles.action, { backgroundColor: c.primary }, pressed && { opacity: 0.8 }]}
                  accessibilityLabel={`Upload new scan for page ${item.ordinal}`}
                >
                  <Ionicons name="cloud-upload-outline" size={18} color={c.primaryText} />
                  <Text style={{ color: c.primaryText, fontWeight: '600' }}>Upload</Text>
                </Pressable>
              ) : null}
            </Card>
          )}
          ListEmptyComponent={<Empty title="Nothing to rescan" message="Pages appear here when a reviewer asks for a rescan." />}
        />
      )}

      <ReplacePageSheet page={replacing} onClose={() => setReplacing(null)} />
    </View>
  );
}

const styles = StyleSheet.create({
  filters: { padding: Space.lg, gap: Space.sm },
  row: { flexDirection: 'row', alignItems: 'center', gap: Space.sm, justifyContent: 'space-between' },
  thumb: { width: 56, height: 72, borderRadius: Radius.sm, borderWidth: StyleSheet.hairlineWidth },
  action: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 44, paddingHorizontal: Space.md, borderRadius: Radius.md },
});
