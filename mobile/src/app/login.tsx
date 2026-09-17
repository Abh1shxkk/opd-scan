import Ionicons from '@expo/vector-icons/Ionicons';
import { useRef, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Button } from '@/components/ui';
import { Radius, Space, useColors } from '@/constants/theme';
import { useAuth } from '@/lib/auth';

export default function LoginScreen() {
  const c = useColors();
  const { login } = useAuth();
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const passwordRef = useRef<TextInput>(null);

  async function submit() {
    if (!identifier.trim() || !password) {
      setError('Enter your username and password.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await login(identifier, password);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Sign in failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: c.primary }} edges={['top']}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={{ flexGrow: 1 }} keyboardShouldPersistTaps="handled">
          <View style={styles.hero}>
            <View style={[styles.logo, { backgroundColor: 'rgba(255,255,255,0.15)' }]}>
              <Ionicons name="scan-outline" size={34} color="#fff" />
            </View>
            <Text style={styles.brand}>OPD Scan QC</Text>
            <Text style={styles.tagline}>Every patient record, scanned right the first time.</Text>
          </View>

          <View style={[styles.panel, { backgroundColor: c.background }]}>
            <Text style={[styles.h1, { color: c.text }]}>Welcome back</Text>
            <Text style={{ color: c.textSecondary, fontSize: 15, marginBottom: Space.lg }}>Sign in to continue.</Text>

            <Text style={[styles.label, { color: c.text }]}>Username or email</Text>
            <View style={[styles.inputRow, { backgroundColor: c.surface, borderColor: c.border }]}>
              <Ionicons name="person-outline" size={18} color={c.textSecondary} />
              <TextInput
                value={identifier}
                onChangeText={setIdentifier}
                placeholder="e.g. ward_clerk"
                placeholderTextColor={c.textSecondary}
                autoCapitalize="none"
                autoCorrect={false}
                autoComplete="username"
                textContentType="username"
                returnKeyType="next"
                onSubmitEditing={() => passwordRef.current?.focus()}
                style={[styles.input, { color: c.text }]}
              />
            </View>

            <Text style={[styles.label, { color: c.text, marginTop: Space.md }]}>Password</Text>
            <View style={[styles.inputRow, { backgroundColor: c.surface, borderColor: c.border }]}>
              <Ionicons name="lock-closed-outline" size={18} color={c.textSecondary} />
              <TextInput
                ref={passwordRef}
                value={password}
                onChangeText={setPassword}
                placeholder="Your password"
                placeholderTextColor={c.textSecondary}
                secureTextEntry={!show}
                autoCapitalize="none"
                autoComplete="current-password"
                textContentType="password"
                returnKeyType="go"
                onSubmitEditing={submit}
                style={[styles.input, { color: c.text }]}
              />
              <Pressable onPress={() => setShow((v) => !v)} hitSlop={10} accessibilityLabel={show ? 'Hide password' : 'Show password'}>
                <Ionicons name={show ? 'eye-off-outline' : 'eye-outline'} size={20} color={c.textSecondary} />
              </Pressable>
            </View>

            {error ? (
              <View style={[styles.error, { backgroundColor: c.badBg }]} accessibilityLiveRegion="polite">
                <Ionicons name="alert-circle" size={18} color={c.bad} />
                <Text style={{ color: c.text, flex: 1 }}>{error}</Text>
              </View>
            ) : null}

            <Button title="Sign in" onPress={submit} loading={busy} style={{ marginTop: Space.xl }} />

            <View style={styles.footer}>
              <Ionicons name="shield-checkmark-outline" size={15} color={c.textSecondary} />
              <Text style={{ color: c.textSecondary, fontSize: 13, flex: 1 }}>
                This app holds patient data. Access is recorded in an audit log.
              </Text>
            </View>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  hero: { alignItems: 'center', paddingTop: Space.xxl, paddingBottom: Space.xxl, paddingHorizontal: Space.xl, gap: Space.sm },
  logo: { width: 68, height: 68, borderRadius: 34, alignItems: 'center', justifyContent: 'center', marginBottom: Space.sm },
  brand: { color: '#fff', fontSize: 24, fontWeight: '700' },
  tagline: { color: 'rgba(255,255,255,0.85)', fontSize: 15, textAlign: 'center' },
  panel: { flex: 1, borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: Space.xl, paddingTop: Space.xxl },
  h1: { fontSize: 26, fontWeight: '700' },
  label: { fontSize: 14, fontWeight: '500', marginBottom: 6 },
  inputRow: { flexDirection: 'row', alignItems: 'center', gap: Space.sm, minHeight: 50, borderWidth: 1, borderRadius: Radius.md, paddingHorizontal: Space.md },
  input: { flex: 1, fontSize: 16, paddingVertical: 0 },
  error: { flexDirection: 'row', gap: Space.sm, alignItems: 'center', padding: Space.md, borderRadius: Radius.md, marginTop: Space.md },
  footer: { flexDirection: 'row', gap: Space.sm, alignItems: 'center', marginTop: Space.xl },
});
