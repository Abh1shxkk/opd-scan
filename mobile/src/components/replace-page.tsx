/**
 * Upload a new scan for one page. The API makes it a new version; the old one stays in history.
 * Shared by the rescan tab and the page viewer.
 */

import Ionicons from '@expo/vector-icons/Ionicons';
import { useQueryClient } from '@tanstack/react-query';
import * as DocumentPicker from 'expo-document-picker';
import * as Haptics from 'expo-haptics';
import { useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';

import { Button, Muted } from '@/components/ui';
import { Radius, Space, useColors } from '@/constants/theme';
import { api } from '@/lib/api';
import { refreshPageState } from '@/lib/refresh';
import type { PageSummary, PickedFile } from '@/lib/types';

export function ReplacePageSheet({
  page,
  onClose,
  onReplaced,
}: {
  page: Pick<PageSummary, 'page_version_id' | 'ordinal' | 'document_filename'> | null;
  onClose: () => void;
  onReplaced?: (newId: string) => void;
}) {
  const c = useColors();
  const qc = useQueryClient();
  const [file, setFile] = useState<PickedFile | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  function close() {
    if (progress !== null) return;
    setFile(null);
    setError(null);
    onClose();
  }

  async function pick() {
    const res = await DocumentPicker.getDocumentAsync({
      type: ['application/pdf', 'image/jpeg', 'image/png', 'image/tiff'],
      copyToCacheDirectory: true,
    });
    if (res.canceled) return;
    const a = res.assets[0];
    setFile({ uri: a.uri, name: a.name, mimeType: a.mimeType ?? 'application/pdf', size: a.size });
    setError(null);
  }

  async function upload() {
    if (!page || !file) return;
    setProgress(0);
    setError(null);
    try {
      const res = await api.replacePage(page.page_version_id, file, setProgress);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      refreshPageState(qc);
      setFile(null);
      setProgress(null);
      onReplaced?.(res.page_version_id);
      onClose();
    } catch (e) {
      setProgress(null);
      setError(e instanceof Error ? e.message : 'Upload failed.');
    }
  }

  return (
    <Modal visible={page !== null} transparent animationType="slide" onRequestClose={close}>
      <Pressable style={styles.backdrop} onPress={close} />
      <View style={[styles.sheet, { backgroundColor: c.background }]}>
        <Text style={{ color: c.text, fontSize: 18, fontWeight: '700' }}>Upload new scan</Text>
        {page ? (
          <Muted>
            Page {page.ordinal} of {page.document_filename}. The current scan is kept in history.
          </Muted>
        ) : null}

        <Pressable onPress={pick} disabled={progress !== null} style={[styles.drop, { borderColor: c.border, backgroundColor: c.surface }]}>
          <Ionicons name={file ? 'document-attach' : 'attach'} size={28} color={c.primary} />
          <Text style={{ color: c.text, fontWeight: '600', textAlign: 'center' }} numberOfLines={2}>
            {file ? file.name : 'Choose the rescanned page'}
          </Text>
          <Muted style={{ fontSize: 12 }}>One image, or a single-page PDF</Muted>
        </Pressable>

        {error ? <Text style={{ color: c.bad }}>{error}</Text> : null}
        {progress !== null ? <Muted>Uploading… {Math.round(progress * 100)}%</Muted> : null}

        <Button title="Upload" icon="cloud-upload-outline" onPress={upload} disabled={!file} loading={progress !== null} />
        <Button title="Cancel" variant="secondary" onPress={close} disabled={progress !== null} />
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)' },
  sheet: { padding: Space.xl, gap: Space.md, borderTopLeftRadius: Radius.lg, borderTopRightRadius: Radius.lg, paddingBottom: Space.xxl },
  drop: { borderWidth: 1.5, borderStyle: 'dashed', borderRadius: Radius.md, padding: Space.xl, alignItems: 'center', gap: Space.sm },
});
