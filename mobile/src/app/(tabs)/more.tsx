import Ionicons from '@expo/vector-icons/Ionicons';
import Constants from 'expo-constants';
import { Alert, ScrollView, Switch, Text, View } from 'react-native';

import { Button, Card, Muted, SectionLabel } from '@/components/ui';
import { Space, useColors } from '@/constants/theme';
import { API_BASE } from '@/lib/api';
import { useAuth } from '@/lib/auth';

export default function AccountScreen() {
  const c = useColors();
  const { user, logout, biometricAvailable, biometricEnabled, setBiometricEnabled } = useAuth();

  return (
    <ScrollView style={{ backgroundColor: c.background }} contentContainerStyle={{ padding: Space.lg, gap: Space.lg }}>
      <Card style={{ alignItems: 'center', gap: Space.sm, paddingVertical: Space.xl }}>
        <View style={{ width: 72, height: 72, borderRadius: 36, backgroundColor: c.primary, alignItems: 'center', justifyContent: 'center' }}>
          <Text style={{ color: c.primaryText, fontSize: 28, fontWeight: '700' }}>
            {(user?.full_name || user?.username || user?.email || '?').slice(0, 1).toUpperCase()}
          </Text>
        </View>
        <Text style={{ color: c.text, fontSize: 19, fontWeight: '700' }}>{user?.full_name || user?.username || user?.email}</Text>
        <Muted>{[user?.username, user?.email].filter(Boolean).join(' · ')}</Muted>
        <View style={{ backgroundColor: c.surfaceAlt, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 4 }}>
          <Text style={{ color: c.text, fontWeight: '600', textTransform: 'capitalize' }}>{user?.role}</Text>
        </View>
      </Card>

      <SectionLabel>Security</SectionLabel>
      <Card style={{ flexDirection: 'row', alignItems: 'center', gap: Space.md }}>
        <Ionicons name="finger-print" size={24} color={c.primary} />
        <View style={{ flex: 1 }}>
          <Text style={{ color: c.text, fontSize: 16, fontWeight: '600' }}>Unlock with fingerprint</Text>
          <Muted style={{ fontSize: 13 }}>
            {biometricAvailable ? 'Ask for fingerprint or face each time the app opens.' : 'Set up a fingerprint or face lock on this phone first.'}
          </Muted>
        </View>
        <Switch
          value={biometricEnabled}
          disabled={!biometricAvailable}
          onValueChange={(on) => void setBiometricEnabled(on)}
          trackColor={{ true: c.primary }}
        />
      </Card>

      <SectionLabel>About</SectionLabel>
      <Card style={{ gap: 4 }}>
        <Muted>Server: {API_BASE.replace(/\/api$/, '')}</Muted>
        <Muted>Version {Constants.expoConfig?.version ?? '1.0.0'}</Muted>
      </Card>

      <Button
        title="Sign out"
        icon="log-out-outline"
        variant="danger"
        onPress={() =>
          Alert.alert('Sign out?', 'You will need your password to sign in again.', [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Sign out', style: 'destructive', onPress: () => void logout() },
          ])
        }
      />
    </ScrollView>
  );
}
