/**
 * New file upload — the intake form plus the files, in one submit.
 *
 * Same endpoint and rules as the web intake screen: the MR number is required and never inferred,
 * a returning patient's details are offered as a prefill the clerk can change, and a blank field
 * means "not recorded".
 */

import Ionicons from '@expo/vector-icons/Ionicons';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import * as DocumentPicker from 'expo-document-picker';
import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { useState } from 'react';
import { Alert, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Button, Card, DateField, Field, Muted, Picker, SectionLabel } from '@/components/ui';
import { Radius, Space, useColors } from '@/constants/theme';
import { api } from '@/lib/api';
import type { IntakeFormValues, IntakeResponse, PickedFile } from '@/lib/types';

const EMPTY: IntakeFormValues = {
  mr_number: '',
  ipd_number: '',
  patient_name: '',
  department: '',
  mobile: '',
  disease: '',
  icd_code: '',
  consultant_name: '',
  discharge_type: '',
  mlc_type: '',
  admission_date: '',
  discharge_date: '',
  record_date: '',
};

const MAX_BYTES = 100 * 1024 * 1024;

function formatSize(bytes?: number | null) {
  if (!bytes) return '';
  return bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export default function UploadScreen() {
  const c = useColors();
  const qc = useQueryClient();
  const [form, setForm] = useState<IntakeFormValues>(EMPTY);
  const [files, setFiles] = useState<PickedFile[]>([]);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<IntakeResponse | null>(null);
  const [lookupNote, setLookupNote] = useState<string | null>(null);

  const options = useQuery({ queryKey: ['intake-options'], queryFn: api.intakeOptions, staleTime: 300_000 });

  const set = (key: keyof IntakeFormValues) => (value: string) => setForm((f) => ({ ...f, [key]: value }));

  async function lookup() {
    const mr = form.mr_number.trim();
    if (!mr) return;
    try {
      const res = await api.lookupMr(mr);
      if (!res.found || !res.case) {
        setLookupNote(null);
        return;
      }
      const p = res.case;
      // Prefill only empty fields, so nothing the clerk already typed is overwritten.
      setForm((f) => ({
        ...f,
        patient_name: f.patient_name || p.patient_name,
        department: f.department || p.department,
        mobile: f.mobile || p.mobile,
        consultant_name: f.consultant_name || p.consultant_name,
      }));
      setLookupNote('Returning patient — details filled from their last record. Check before saving.');
    } catch {
      /* a failed prefill is not an error worth interrupting the clerk for */
    }
  }

  async function pickFiles() {
    const res = await DocumentPicker.getDocumentAsync({
      type: ['application/pdf', 'image/jpeg', 'image/png', 'image/tiff'],
      multiple: true,
      copyToCacheDirectory: true,
    });
    if (res.canceled) return;
    const picked: PickedFile[] = [];
    for (const a of res.assets) {
      if (a.size && a.size > MAX_BYTES) {
        Alert.alert('File too large', `${a.name} is over 100 MB.`);
        continue;
      }
      picked.push({ uri: a.uri, name: a.name, mimeType: a.mimeType ?? 'application/pdf', size: a.size });
    }
    setFiles((prev) => [...prev, ...picked.filter((p) => !prev.some((x) => x.name === p.name && x.size === p.size))]);
  }

  async function submit() {
    setError(null);
    if (!form.mr_number.trim()) {
      setError('MR number is required.');
      return;
    }
    if (form.admission_date && form.discharge_date && form.discharge_date < form.admission_date) {
      setError('The discharge date is before the admission date.');
      return;
    }
    setProgress(0);
    try {
      const res = await api.submitIntake(form, files, setProgress);
      setResult(res);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      void qc.invalidateQueries({ queryKey: ['cases'] });
      void qc.invalidateQueries({ queryKey: ['review-documents'] });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Upload failed.');
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      setProgress(null);
    }
  }

  function reset() {
    setForm(EMPTY);
    setFiles([]);
    setResult(null);
    setLookupNote(null);
    setError(null);
  }

  if (result) {
    const accepted = result.documents.filter((d) => d.status === 'accepted').length;
    return (
      <ScrollView style={{ backgroundColor: c.background }} contentContainerStyle={{ padding: Space.lg, gap: Space.lg }}>
        <Card style={{ alignItems: 'center', gap: Space.sm, paddingVertical: Space.xl }}>
          <Ionicons name="checkmark-circle" size={56} color={c.ok} />
          <Text style={{ color: c.text, fontSize: 20, fontWeight: '700' }}>Record saved</Text>
          <Muted style={{ textAlign: 'center' }}>
            MR {result.case.patient_ref} · {accepted} file{accepted === 1 ? '' : 's'} uploaded. Quality checks run in the background.
          </Muted>
        </Card>
        {result.documents.map((d, i) => (
          <Card key={`${d.filename}-${i}`} style={{ flexDirection: 'row', alignItems: 'center', gap: Space.md }}>
            <Ionicons
              name={d.status === 'accepted' ? 'document-text' : d.status === 'duplicate' ? 'copy-outline' : 'close-circle'}
              size={22}
              color={d.status === 'accepted' ? c.ok : d.status === 'duplicate' ? c.warn : c.bad}
            />
            <View style={{ flex: 1 }}>
              <Text style={{ color: c.text, fontWeight: '600' }} numberOfLines={1}>
                {d.filename}
              </Text>
              <Muted style={{ fontSize: 13 }}>
                {d.status === 'accepted' ? `${d.page_count ?? '?'} pages` : d.message || d.status}
              </Muted>
            </View>
          </Card>
        ))}
        <Button title="Open patient record" icon="person-outline" onPress={() => router.push({ pathname: '/patient/[id]', params: { id: result.case.id } })} />
        <Button title="Upload another" variant="secondary" icon="add" onPress={reset} />
      </ScrollView>
    );
  }

  const busy = progress !== null;
  const opts = options.data;

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView style={{ backgroundColor: c.background }} contentContainerStyle={{ padding: Space.lg, gap: Space.lg, paddingBottom: 60 }} keyboardShouldPersistTaps="handled">
        <SectionLabel>Patient</SectionLabel>
        <Card style={{ gap: Space.md }}>
          <Field label="MR number *" value={form.mr_number} onChangeText={set('mr_number')} onBlur={lookup} autoCapitalize="characters" autoCorrect={false} placeholder="e.g. 201409221237" />
          {lookupNote ? (
            <View style={[styles.note, { backgroundColor: c.surfaceAlt }]}>
              <Ionicons name="information-circle-outline" size={18} color={c.primary} />
              <Text style={{ color: c.text, flex: 1, fontSize: 13 }}>{lookupNote}</Text>
            </View>
          ) : null}
          <Field label="IPD number" value={form.ipd_number} onChangeText={set('ipd_number')} autoCapitalize="characters" autoCorrect={false} placeholder="e.g. IP.140922103" />
          <Field label="Patient name" value={form.patient_name} onChangeText={set('patient_name')} autoCapitalize="words" />
          <Field label="Mobile number" value={form.mobile} onChangeText={set('mobile')} keyboardType="phone-pad" />
          <Picker label="Department" value={form.department} options={opts?.departments ?? []} onChange={set('department')} />
        </Card>

        <SectionLabel>Clinical</SectionLabel>
        <Card style={{ gap: Space.md }}>
          <Field label="Disease" value={form.disease} onChangeText={set('disease')} />
          <Field label="ICD code" value={form.icd_code} onChangeText={set('icd_code')} autoCapitalize="characters" autoCorrect={false} />
          <Field label="Consultant name" value={form.consultant_name} onChangeText={set('consultant_name')} autoCapitalize="words" />
          <Picker label="Discharge type" value={form.discharge_type} options={opts?.discharge_types ?? []} onChange={set('discharge_type')} />
          <Picker label="MLC type" value={form.mlc_type} options={opts?.mlc_types ?? []} onChange={set('mlc_type')} />
        </Card>

        <SectionLabel>Dates</SectionLabel>
        <Card style={{ gap: Space.md }}>
          <View style={{ flexDirection: 'row', gap: Space.md }}>
            <DateField label="Admission" value={form.admission_date} onChange={set('admission_date')} />
            <DateField label="Discharge" value={form.discharge_date} onChange={set('discharge_date')} />
          </View>
          <DateField label="Record date" value={form.record_date} onChange={set('record_date')} />
        </Card>

        <SectionLabel>Files</SectionLabel>
        <Card style={{ gap: Space.md }}>
          {files.map((f, i) => (
            <View key={`${f.uri}-${i}`} style={[styles.fileRow, { borderColor: c.border }]}>
              <Ionicons name={f.mimeType === 'application/pdf' ? 'document-text-outline' : 'image-outline'} size={22} color={c.primary} />
              <View style={{ flex: 1 }}>
                <Text style={{ color: c.text, fontWeight: '600' }} numberOfLines={1}>
                  {f.name}
                </Text>
                <Muted style={{ fontSize: 12 }}>{formatSize(f.size)}</Muted>
              </View>
              {!busy ? (
                <Pressable onPress={() => setFiles((prev) => prev.filter((_, j) => j !== i))} hitSlop={10} accessibilityLabel={`Remove ${f.name}`}>
                  <Ionicons name="close-circle-outline" size={22} color={c.textSecondary} />
                </Pressable>
              ) : null}
            </View>
          ))}
          <Button title={files.length ? 'Add more files' : 'Choose PDF or image'} icon="attach" variant="secondary" onPress={pickFiles} disabled={busy} />
          <Muted style={{ fontSize: 12 }}>PDF, JPEG, PNG or TIFF · up to 100 MB each</Muted>
        </Card>

        {error ? (
          <View style={[styles.note, { backgroundColor: c.badBg }]}>
            <Ionicons name="alert-circle" size={18} color={c.bad} />
            <Text style={{ color: c.text, flex: 1 }}>{error}</Text>
          </View>
        ) : null}

        {busy ? (
          <View style={{ gap: 6 }}>
            <View style={[styles.track, { backgroundColor: c.surfaceAlt }]}>
              <View style={[styles.bar, { backgroundColor: c.primary, width: `${Math.round((progress ?? 0) * 100)}%` }]} />
            </View>
            <Muted style={{ textAlign: 'center' }}>
              {(progress ?? 0) < 1 ? `Uploading… ${Math.round((progress ?? 0) * 100)}%` : 'Saving…'}
            </Muted>
          </View>
        ) : null}

        <Button title={files.length ? `Save record and upload ${files.length} file${files.length === 1 ? '' : 's'}` : 'Save record'} icon="cloud-upload-outline" onPress={submit} loading={busy} />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  note: { flexDirection: 'row', gap: Space.sm, alignItems: 'center', padding: Space.md, borderRadius: Radius.md },
  fileRow: { flexDirection: 'row', alignItems: 'center', gap: Space.md, paddingBottom: Space.md, borderBottomWidth: StyleSheet.hairlineWidth },
  track: { height: 8, borderRadius: 4, overflow: 'hidden' },
  bar: { height: 8, borderRadius: 4 },
});
