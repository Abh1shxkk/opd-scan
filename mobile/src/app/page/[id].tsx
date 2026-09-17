/**
 * One page: the scan (pinch to zoom), its verdict and what was found, and the reviewer's decision.
 */

import Ionicons from '@expo/vector-icons/Ionicons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as Haptics from 'expo-haptics';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ReplacePageSheet } from '@/components/replace-page';
import { Button, ErrorView, Loading, Muted, PageImage, Pill } from '@/components/ui';
import { Zoomable } from '@/components/zoomable';
import { Radius, Space, useColors } from '@/constants/theme';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { refreshPageState } from '@/lib/refresh';
import { formatDateTime, pageStatus } from '@/lib/status';

export default function PageScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const c = useColors();
  const qc = useQueryClient();
  const { can } = useAuth();
  const [replacing, setReplacing] = useState(false);
  const [showDetails, setShowDetails] = useState(false);

  const page = useQuery({ queryKey: ['page', id], queryFn: () => api.getPage(id) });

  const review = useMutation({
    mutationFn: (action: 'accept' | 'request_rescan') => api.reviewPage(id, action),
    onSuccess: (res) => {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      refreshPageState(qc);
      goNext(res.review_state === 'accepted' ? 'Accepted' : 'Sent for rescan');
    },
    onError: (e) => Alert.alert('Could not save', e instanceof Error ? e.message : 'Try again.'),
  });

  function goNext(done: string) {
    const siblings = page.data?.document_pages ?? [];
    const idx = siblings.findIndex((p) => p.page_version_id === id);
    // Move to the next page in this file that still needs a decision.
    const next = siblings
      .slice(idx + 1)
      .find((p) => (p.page_class === 'review' || p.page_class === 'rescan') && (p.review_state ?? 'pending') === 'pending');
    if (next) {
      router.replace({ pathname: '/page/[id]', params: { id: next.page_version_id } });
    } else {
      Alert.alert(done, 'No more pages waiting in this file.', [{ text: 'OK', onPress: () => router.back() }]);
    }
  }

  if (page.isLoading) return <Loading />;
  if (page.isError || !page.data) return <ErrorView error={page.error} onRetry={() => page.refetch()} />;
  const p = page.data;
  const status = pageStatus(p.page_class, p.review_state);
  const lastReview = [...(p.reviews ?? [])].reverse().find((r) => r.action === 'accept' || r.action === 'request_rescan');

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: '#0B0D0F' }} edges={['bottom']}>
      <Stack.Screen options={{ title: `Page ${p.ordinal}` }} />

      <View style={{ flex: 1 }}>
        <Zoomable>
          <PageImage pageVersionId={p.page_version_id} kind="preview" style={{ flex: 1, backgroundColor: '#0B0D0F' }} />
        </Zoomable>
      </View>

      <View style={[styles.panel, { backgroundColor: c.surface }]}>
        <Pressable onPress={() => setShowDetails((v) => !v)} style={styles.header} accessibilityRole="button">
          <View style={{ flex: 1, gap: 4 }}>
            <Text style={{ color: c.text, fontWeight: '700', fontSize: 15 }} numberOfLines={1}>
              {p.document_filename}
            </Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: Space.sm }}>
              <Pill view={status} />
              {p.quality_score !== null ? <Muted style={{ fontSize: 13 }}>Score {p.quality_score.toFixed(2)}</Muted> : null}
            </View>
          </View>
          <Ionicons name={showDetails ? 'chevron-down' : 'chevron-up'} size={20} color={c.textSecondary} />
        </Pressable>

        {showDetails ? (
          <ScrollView style={{ maxHeight: 180 }} contentContainerStyle={{ gap: Space.sm, paddingBottom: Space.sm }}>
            {p.findings.length === 0 ? (
              <Muted>No scan problems found.</Muted>
            ) : (
              p.findings.map((f) => (
                <View key={f.id} style={{ flexDirection: 'row', gap: Space.sm }}>
                  <Ionicons name="alert-circle-outline" size={16} color={f.severity === 'high' ? c.bad : c.warn} style={{ marginTop: 2 }} />
                  <View style={{ flex: 1 }}>
                    <Text style={{ color: c.text, fontWeight: '600' }}>{f.label}</Text>
                    {f.detail ? <Muted style={{ fontSize: 13 }}>{f.detail}</Muted> : null}
                  </View>
                </View>
              ))
            )}
            {lastReview ? (
              <Muted style={{ fontSize: 13 }}>
                {lastReview.action === 'accept' ? 'Accepted' : 'Rescan requested'}
                {lastReview.reviewer_name ? ` by ${lastReview.reviewer_name}` : ''} · {formatDateTime(lastReview.created_at)}
              </Muted>
            ) : null}
          </ScrollView>
        ) : null}

        <View style={styles.actions}>
          {can('reviewer') ? (
            <>
              <Button
                title={p.review_state === 'accepted' ? 'Accepted' : 'Accept'}
                icon="checkmark"
                onPress={() => review.mutate('accept')}
                disabled={p.review_state === 'accepted'}
                loading={review.isPending && review.variables === 'accept'}
                style={{ flex: 1, backgroundColor: c.ok, borderColor: c.ok }}
              />
              <Button
                title="Rescan"
                icon="refresh"
                variant="secondary"
                onPress={() => review.mutate('request_rescan')}
                disabled={p.review_state === 'rescan_requested'}
                loading={review.isPending && review.variables === 'request_rescan'}
                style={{ flex: 1 }}
              />
            </>
          ) : null}
          {can('uploader') ? (
            <Button title="New scan" icon="cloud-upload-outline" variant="secondary" onPress={() => setReplacing(true)} style={{ flex: can('reviewer') ? 0 : 1, paddingHorizontal: Space.md }} />
          ) : null}
        </View>
      </View>

      <ReplacePageSheet
        page={replacing ? p : null}
        onClose={() => setReplacing(false)}
        onReplaced={(newId) => router.replace({ pathname: '/page/[id]', params: { id: newId } })}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  panel: { padding: Space.lg, gap: Space.md, borderTopLeftRadius: Radius.lg, borderTopRightRadius: Radius.lg },
  header: { flexDirection: 'row', alignItems: 'center', gap: Space.sm },
  actions: { flexDirection: 'row', gap: Space.sm },
});
