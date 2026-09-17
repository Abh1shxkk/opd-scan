import Ionicons from '@expo/vector-icons/Ionicons';
import { useEffect } from 'react';
import { Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Button } from '@/components/ui';
import { Space, useColors } from '@/constants/theme';
import { useAuth } from '@/lib/auth';

/** Shown when a saved session exists and fingerprint unlock is on. */
export default function LockScreen() {
  const c = useColors();
  const { unlock, logout, user } = useAuth();

  useEffect(() => {
    void unlock();
  }, [unlock]);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: c.background }}>
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: Space.xl, gap: Space.lg }}>
        <View style={{ width: 88, height: 88, borderRadius: 44, backgroundColor: c.surfaceAlt, alignItems: 'center', justifyContent: 'center' }}>
          <Ionicons name="finger-print" size={46} color={c.primary} />
        </View>
        <Text style={{ color: c.text, fontSize: 22, fontWeight: '700' }}>Locked</Text>
        <Text style={{ color: c.textSecondary, fontSize: 15, textAlign: 'center' }}>
          {user ? `Signed in as ${user.full_name || user.username || user.email}.` : ''} Unlock to continue.
        </Text>
        <Button title="Unlock" icon="finger-print" onPress={() => void unlock()} style={{ alignSelf: 'stretch' }} />
        <Button title="Sign in with password instead" variant="secondary" onPress={() => void logout()} style={{ alignSelf: 'stretch' }} />
      </View>
    </SafeAreaView>
  );
}
