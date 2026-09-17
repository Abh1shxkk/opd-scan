/**
 * The small set of building blocks every screen uses. Kept here so spacing, colour and touch sizes
 * stay consistent — every tappable control is at least 44pt tall.
 */

import Ionicons from '@expo/vector-icons/Ionicons';
import DateTimePicker from '@react-native-community/datetimepicker';
import { Image } from 'expo-image';
import { useState, type ComponentProps, type ReactNode } from 'react';
import {
  ActivityIndicator,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type StyleProp,
  type TextInputProps,
  type ViewStyle,
} from 'react-native';

import { Radius, Space, useColors } from '@/constants/theme';
import { authHeaders, imageUrl } from '@/lib/api';
import { formatDate, pageStatus, toDay, toneColors, type StatusView } from '@/lib/status';
import type { PageClass, ReviewState } from '@/lib/types';

export type IconName = ComponentProps<typeof Ionicons>['name'];

// ------------------------------------------------------------------ text

export function Title({ children }: { children: ReactNode }) {
  const c = useColors();
  return <Text style={[styles.title, { color: c.text }]}>{children}</Text>;
}

export function Muted({ children, style }: { children: ReactNode; style?: object }) {
  const c = useColors();
  return <Text style={[{ color: c.textSecondary, fontSize: 14 }, style]}>{children}</Text>;
}

export function SectionLabel({ children }: { children: ReactNode }) {
  const c = useColors();
  return <Text style={[styles.sectionLabel, { color: c.textSecondary }]}>{children}</Text>;
}

// ---------------------------------------------------------------- surfaces

export function Card({ children, style, onPress }: { children: ReactNode; style?: StyleProp<ViewStyle>; onPress?: () => void }) {
  const c = useColors();
  const base = [styles.card, { backgroundColor: c.surface, borderColor: c.border }, style];
  if (!onPress) return <View style={base}>{children}</View>;
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [base, pressed && { opacity: 0.7 }]}>
      {children}
    </Pressable>
  );
}

// ------------------------------------------------------------------ controls

export function Button({
  title,
  onPress,
  variant = 'primary',
  icon,
  loading,
  disabled,
  style,
}: {
  title: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary' | 'danger';
  icon?: IconName;
  loading?: boolean;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const c = useColors();
  const bg = variant === 'primary' ? c.primary : variant === 'danger' ? c.bad : c.surface;
  const fg = variant === 'secondary' ? c.text : c.primaryText;
  const off = disabled || loading;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: off }}
      disabled={off}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        { backgroundColor: bg, borderColor: variant === 'secondary' ? c.border : bg },
        (pressed || off) && { opacity: off ? 0.55 : 0.8 },
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={fg} />
      ) : (
        <>
          {icon ? <Ionicons name={icon} size={18} color={fg} /> : null}
          <Text style={[styles.buttonText, { color: fg }]}>{title}</Text>
        </>
      )}
    </Pressable>
  );
}

export function Field({ label, error, ...props }: TextInputProps & { label: string; error?: string }) {
  const c = useColors();
  const [focused, setFocused] = useState(false);
  return (
    <View style={{ gap: 6 }}>
      <Text style={[styles.label, { color: c.text }]}>{label}</Text>
      <TextInput
        placeholderTextColor={c.textSecondary}
        {...props}
        onFocus={(e) => {
          setFocused(true);
          props.onFocus?.(e);
        }}
        onBlur={(e) => {
          setFocused(false);
          props.onBlur?.(e);
        }}
        style={[
          styles.input,
          { color: c.text, backgroundColor: c.surface, borderColor: error ? c.bad : focused ? c.primary : c.border },
          props.style,
        ]}
      />
      {error ? <Text style={{ color: c.bad, fontSize: 13 }}>{error}</Text> : null}
    </View>
  );
}

export function SearchBar({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  const c = useColors();
  return (
    <View style={[styles.search, { backgroundColor: c.surface, borderColor: c.border }]}>
      <Ionicons name="search" size={18} color={c.textSecondary} />
      <TextInput
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={c.textSecondary}
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="search"
        style={{ flex: 1, color: c.text, fontSize: 15, paddingVertical: 0 }}
      />
      {value ? (
        <Pressable onPress={() => onChange('')} hitSlop={10} accessibilityLabel="Clear search">
          <Ionicons name="close-circle" size={18} color={c.textSecondary} />
        </Pressable>
      ) : null}
    </View>
  );
}

/** A date chip: tap to pick a day, tap the × to clear. Value is YYYY-MM-DD or null. */
export function DateChip({ value, onChange, label = 'Any date' }: { value: string | null; onChange: (v: string | null) => void; label?: string }) {
  const c = useColors();
  const [open, setOpen] = useState(false);
  const active = Boolean(value);
  return (
    <>
      <Pressable
        onPress={() => setOpen(true)}
        style={[styles.chip, { backgroundColor: active ? c.primary : c.surface, borderColor: active ? c.primary : c.border }]}
      >
        <Ionicons name="calendar-outline" size={15} color={active ? c.primaryText : c.text} />
        <Text style={{ color: active ? c.primaryText : c.text, fontSize: 14 }}>{value ? formatDate(value) : label}</Text>
        {active ? (
          <Pressable onPress={() => onChange(null)} hitSlop={10} accessibilityLabel="Clear date">
            <Ionicons name="close" size={15} color={c.primaryText} />
          </Pressable>
        ) : null}
      </Pressable>
      {open ? (
        <DateTimePicker
          value={value ? new Date(`${value}T12:00:00`) : new Date()}
          mode="date"
          maximumDate={new Date()}
          display={Platform.OS === 'ios' ? 'inline' : 'default'}
          onChange={(event, date) => {
            setOpen(false);
            if (event.type === 'set' && date) onChange(toDay(date));
          }}
        />
      ) : null}
    </>
  );
}

export function Chip({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  const c = useColors();
  return (
    <Pressable
      onPress={onPress}
      accessibilityState={{ selected: active }}
      style={[styles.chip, { backgroundColor: active ? c.primary : c.surface, borderColor: active ? c.primary : c.border }]}
    >
      {active ? <Ionicons name="checkmark" size={15} color={c.primaryText} /> : null}
      <Text style={{ color: active ? c.primaryText : c.text, fontSize: 14 }}>{label}</Text>
    </Pressable>
  );
}

/** A select field that opens a bottom sheet of options. */
export function Picker({ label, value, options, onChange }: { label: string; value: string; options: string[]; onChange: (v: string) => void }) {
  const c = useColors();
  const [open, setOpen] = useState(false);
  return (
    <View style={{ gap: 6 }}>
      <Text style={[styles.label, { color: c.text }]}>{label}</Text>
      <Pressable onPress={() => setOpen(true)} style={[styles.input, styles.pickerRow, { backgroundColor: c.surface, borderColor: c.border }]}>
        <Text style={{ color: value ? c.text : c.textSecondary, fontSize: 15, flex: 1 }} numberOfLines={1}>
          {value || 'Not recorded'}
        </Text>
        <Ionicons name="chevron-down" size={18} color={c.textSecondary} />
      </Pressable>
      <Modal visible={open} transparent animationType="slide" onRequestClose={() => setOpen(false)}>
        <Pressable style={styles.backdrop} onPress={() => setOpen(false)} />
        <View style={[styles.sheet, { backgroundColor: c.surface }]}>
          <Text style={[styles.sheetTitle, { color: c.text }]}>{label}</Text>
          <ScrollView>
            {['', ...options].map((opt) => (
              <Pressable
                key={opt || '__none'}
                onPress={() => {
                  onChange(opt);
                  setOpen(false);
                }}
                style={[styles.sheetRow, { borderColor: c.border }]}
              >
                <Text style={{ color: opt ? c.text : c.textSecondary, fontSize: 16, flex: 1 }}>{opt || 'Not recorded'}</Text>
                {opt === value ? <Ionicons name="checkmark" size={20} color={c.primary} /> : null}
              </Pressable>
            ))}
          </ScrollView>
        </View>
      </Modal>
    </View>
  );
}

/** A date form field (YYYY-MM-DD string, '' when empty). */
export function DateField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  const c = useColors();
  const [open, setOpen] = useState(false);
  return (
    <View style={{ gap: 6, flex: 1 }}>
      <Text style={[styles.label, { color: c.text }]}>{label}</Text>
      <Pressable onPress={() => setOpen(true)} style={[styles.input, styles.pickerRow, { backgroundColor: c.surface, borderColor: c.border }]}>
        <Text style={{ color: value ? c.text : c.textSecondary, fontSize: 15, flex: 1 }}>{value ? formatDate(value) : 'Select'}</Text>
        {value ? (
          <Pressable onPress={() => onChange('')} hitSlop={10} accessibilityLabel={`Clear ${label}`}>
            <Ionicons name="close" size={16} color={c.textSecondary} />
          </Pressable>
        ) : (
          <Ionicons name="calendar-outline" size={16} color={c.textSecondary} />
        )}
      </Pressable>
      {open ? (
        <DateTimePicker
          value={value ? new Date(`${value}T12:00:00`) : new Date()}
          mode="date"
          display={Platform.OS === 'ios' ? 'inline' : 'default'}
          onChange={(event, date) => {
            setOpen(false);
            if (event.type === 'set' && date) onChange(toDay(date));
          }}
        />
      ) : null}
    </View>
  );
}

// ------------------------------------------------------------------ status

export function Pill({ view, small }: { view: StatusView; small?: boolean }) {
  const c = useColors();
  const { fg, bg } = toneColors(view.tone, c);
  return (
    <View style={[styles.pill, { backgroundColor: bg }, small && { paddingHorizontal: 6, paddingVertical: 2 }]}>
      <Text style={{ color: fg, fontSize: small ? 11 : 12, fontWeight: '600' }}>{view.label}</Text>
    </View>
  );
}

export function CountBadge({ count, active }: { count: number; active?: boolean }) {
  const c = useColors();
  return (
    <View style={[styles.badge, { backgroundColor: active ? c.primary : c.surfaceAlt }]}>
      <Text style={{ color: active ? c.primaryText : c.text, fontWeight: '700', fontSize: 13 }}>{count}</Text>
    </View>
  );
}

// ------------------------------------------------------------------ images

/** A page image from the API. The route is behind sign-in, so the token goes with the request. */
export function PageImage({ pageVersionId, kind = 'thumb', style }: { pageVersionId: string; kind?: 'thumb' | 'preview'; style?: object }) {
  const c = useColors();
  return (
    <Image
      source={{ uri: imageUrl[kind](pageVersionId), headers: authHeaders(), cacheKey: `${kind}-${pageVersionId}` }}
      // A page version never changes (a rescan is a new version id), so it is safe to keep on disk.
      cachePolicy="memory-disk"
      contentFit="contain"
      transition={150}
      style={[{ backgroundColor: c.surfaceAlt }, style]}
    />
  );
}

export function PageTile({
  pageVersionId,
  ordinal,
  pageClass,
  reviewState,
  onPress,
}: {
  pageVersionId: string;
  ordinal: number;
  pageClass: PageClass;
  reviewState?: ReviewState;
  onPress: () => void;
}) {
  const c = useColors();
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.tile, pressed && { opacity: 0.7 }]} accessibilityLabel={`Open page ${ordinal}`}>
      <PageImage pageVersionId={pageVersionId} style={[styles.tileImage, { borderColor: c.border }]} />
      <Text style={{ color: c.text, fontWeight: '600', fontSize: 13 }}>Page {ordinal}</Text>
      <Pill view={pageStatus(pageClass, reviewState)} small />
    </Pressable>
  );
}

// ------------------------------------------------------------------ states

export function Loading({ label = 'Loading…' }: { label?: string }) {
  const c = useColors();
  return (
    <View style={styles.center}>
      <ActivityIndicator color={c.primary} size="large" />
      <Muted>{label}</Muted>
    </View>
  );
}

export function ErrorView({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const c = useColors();
  const message = error instanceof Error ? error.message : 'Something went wrong.';
  return (
    <View style={styles.center}>
      <Ionicons name="cloud-offline-outline" size={40} color={c.textSecondary} />
      <Text style={{ color: c.text, fontSize: 15, textAlign: 'center' }}>{message}</Text>
      {onRetry ? <Button title="Try again" variant="secondary" onPress={onRetry} /> : null}
    </View>
  );
}

export function Empty({ icon = 'checkmark-done-outline', title, message }: { icon?: IconName; title: string; message?: string }) {
  const c = useColors();
  return (
    <View style={styles.center}>
      <Ionicons name={icon} size={44} color={c.textSecondary} />
      <Text style={{ color: c.text, fontSize: 16, fontWeight: '600', textAlign: 'center' }}>{title}</Text>
      {message ? <Muted style={{ textAlign: 'center' }}>{message}</Muted> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  title: { fontSize: 22, fontWeight: '700' },
  sectionLabel: { fontSize: 12, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.6 },
  card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: Radius.md, padding: Space.lg },
  button: {
    minHeight: 48,
    borderRadius: Radius.md,
    borderWidth: 1,
    paddingHorizontal: Space.lg,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Space.sm,
  },
  buttonText: { fontSize: 16, fontWeight: '600' },
  label: { fontSize: 14, fontWeight: '500' },
  input: { minHeight: 48, borderWidth: 1, borderRadius: Radius.md, paddingHorizontal: Space.md, fontSize: 15 },
  pickerRow: { flexDirection: 'row', alignItems: 'center', gap: Space.sm },
  search: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.sm,
    minHeight: 46,
    borderWidth: 1,
    borderRadius: Radius.md,
    paddingHorizontal: Space.md,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    minHeight: 36,
    borderWidth: 1,
    borderRadius: Radius.pill,
    paddingHorizontal: Space.md,
  },
  pill: { alignSelf: 'flex-start', borderRadius: Radius.pill, paddingHorizontal: 8, paddingVertical: 3 },
  badge: { minWidth: 30, height: 26, borderRadius: Radius.pill, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 8 },
  tile: { width: '31%', gap: 4 },
  tileImage: { width: '100%', aspectRatio: 0.75, borderRadius: Radius.sm, borderWidth: StyleSheet.hairlineWidth },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: Space.xl, gap: Space.md },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)' },
  sheet: { maxHeight: '70%', borderTopLeftRadius: Radius.lg, borderTopRightRadius: Radius.lg, paddingBottom: Space.xl },
  sheetTitle: { fontSize: 17, fontWeight: '700', padding: Space.lg },
  sheetRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: Space.lg, minHeight: 52, borderTopWidth: StyleSheet.hairlineWidth },
});
