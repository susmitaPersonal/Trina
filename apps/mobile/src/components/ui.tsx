import { useNavigation } from '@react-navigation/native';
import React from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type TextInputProps,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Svg, { Path } from 'react-native-svg';
import { useApp } from '../app/store';
import { font, radius, space, TOUCH, useTheme } from './theme';

export function T({ children, v = 'body', style, muted, center, numberOfLines }: { children: React.ReactNode; v?: 'h1' | 'h2' | 'big' | 'body' | 'small' | 'huge'; style?: TextStyle; muted?: boolean; center?: boolean; numberOfLines?: number }) {
  const t = useTheme();
  const weight: TextStyle['fontWeight'] = v === 'h1' || v === 'h2' || v === 'huge' ? '800' : v === 'big' ? '700' : '400';
  return (
    <Text numberOfLines={numberOfLines} style={[{ color: muted ? t.textMuted : t.text, fontSize: font[v], fontWeight: weight, textAlign: center ? 'center' : undefined, lineHeight: font[v] * 1.3 }, style]}>
      {children}
    </Text>
  );
}

export function Screen({ title, children, scroll = true, right, pill = true, back = false }: { title?: string; children: React.ReactNode; scroll?: boolean; right?: React.ReactNode; pill?: boolean; back?: boolean }) {
  const t = useTheme();
  const nav = useNavigation();
  const body = <View style={{ padding: space.l, gap: space.l }}>{children}</View>;
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={['top', 'left', 'right']}>
      {(title || pill) && (
        <View style={{ paddingHorizontal: space.l, paddingTop: space.s, gap: space.s }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.s }}>
            {back && nav.canGoBack() && (
              <Pressable accessibilityRole="button" accessibilityLabel="Back" onPress={() => nav.goBack()} style={{ minWidth: 44, minHeight: 44, justifyContent: 'center' }}>
                <T v="h2">‹</T>
              </Pressable>
            )}
            {title ? <T v="h2" style={{ flex: 1 }}>{title}</T> : <View style={{ flex: 1 }} />}
            {right}
          </View>
          {pill && <SyncPillView />}
        </View>
      )}
      {scroll ? <ScrollView keyboardShouldPersistTaps="handled">{body}</ScrollView> : <View style={{ flex: 1 }}>{body}</View>}
    </SafeAreaView>
  );
}

export function Btn({ title, onPress, kind = 'primary', disabled, busy, icon, style, accessibilityLabel }: { title: string; onPress?: () => void; kind?: 'primary' | 'secondary' | 'danger' | 'ghost'; disabled?: boolean; busy?: boolean; icon?: string; style?: ViewStyle; accessibilityLabel?: string }) {
  const t = useTheme();
  const bg = kind === 'primary' ? t.primary : kind === 'danger' ? t.danger : kind === 'secondary' ? t.surfaceAlt : 'transparent';
  const fg = kind === 'primary' ? t.primaryText : kind === 'danger' ? '#fff' : t.text;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled: !!disabled || !!busy }}
      disabled={!!disabled || !!busy}
      onPress={disabled || busy ? undefined : onPress}
      style={({ pressed }) => [
        { minHeight: TOUCH, borderRadius: radius.m, backgroundColor: bg, alignItems: 'center', justifyContent: 'center', paddingHorizontal: space.l, flexDirection: 'row', gap: space.s, opacity: disabled ? 0.45 : pressed ? 0.8 : 1, borderWidth: kind === 'ghost' ? 1 : 0, borderColor: t.border },
        style,
      ]}
    >
      {busy ? <ActivityIndicator color={fg} /> : <Text style={{ color: fg, fontSize: font.big, fontWeight: '700' }}>{icon ? `${icon}  ` : ''}{title}</Text>}
    </Pressable>
  );
}

export function Card({ children, style, onPress, tone }: { children: React.ReactNode; style?: ViewStyle; onPress?: () => void; tone?: 'ok' | 'warn' | 'info' | 'offline' }) {
  const t = useTheme();
  const bg = tone === 'ok' ? t.okBg : tone === 'warn' ? t.warnBg : tone === 'info' ? t.infoBg : tone === 'offline' ? t.offlineBg : t.surface;
  const inner = <View style={[{ backgroundColor: bg, borderRadius: radius.l, padding: space.l, gap: space.s, borderWidth: StyleSheet.hairlineWidth, borderColor: t.border }, style]}>{children}</View>;
  return onPress ? (
    <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => ({ opacity: pressed ? 0.85 : 1 })}>
      {inner}
    </Pressable>
  ) : (
    inner
  );
}

export function SyncPillView() {
  const pill = useApp((s) => s.pill);
  const t = useTheme();
  const nav = useNavigation<any>();
  const bg = pill.tone === 'ok' ? t.okBg : pill.tone === 'warn' ? t.warnBg : pill.tone === 'offline' ? t.offlineBg : t.infoBg;
  const fg = pill.tone === 'ok' ? t.ok : pill.tone === 'warn' ? t.warn : pill.tone === 'offline' ? t.offline : t.info;
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`Sync status: ${pill.text}`} onPress={() => nav.navigate('SyncStatus')} style={{ backgroundColor: bg, borderRadius: 999, paddingVertical: space.s, paddingHorizontal: space.m, flexDirection: 'row', alignItems: 'center', gap: space.s, alignSelf: 'flex-start' }}>
      <Text style={{ fontSize: font.body }}>{pill.icon}</Text>
      <Text style={{ color: fg, fontSize: font.small, fontWeight: '700' }}>{pill.text}</Text>
    </Pressable>
  );
}

export function Field({ label, error, ...p }: TextInputProps & { label: string; error?: string }) {
  const t = useTheme();
  return (
    <View style={{ gap: space.xs }}>
      <T v="small" muted>{label}</T>
      <TextInput
        placeholderTextColor={t.textMuted}
        {...p}
        style={[{ minHeight: TOUCH, borderRadius: radius.m, borderWidth: 1, borderColor: error ? t.danger : t.border, backgroundColor: t.surface, color: t.text, fontSize: font.big, paddingHorizontal: space.m }, p.multiline ? { minHeight: 110, paddingTop: space.m, textAlignVertical: 'top' } : null]}
      />
      {error ? <T v="small" style={{ color: t.danger }}>{error}</T> : null}
    </View>
  );
}

export function Row({ children, gap = space.s, style }: { children: React.ReactNode; gap?: number; style?: ViewStyle }) {
  return <View style={[{ flexDirection: 'row', alignItems: 'center', gap, flexWrap: 'wrap' }, style]}>{children}</View>;
}

export function Stat({ label, value, big }: { label: string; value: string; big?: boolean }) {
  return (
    <View style={{ minWidth: 90, flexGrow: 1 }}>
      <T v={big ? 'h1' : 'big'}>{value}</T>
      <T v="small" muted>{label}</T>
    </View>
  );
}

export function Chip({ label, selected, onPress }: { label: string; selected?: boolean; onPress?: () => void }) {
  const t = useTheme();
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ selected }} onPress={onPress} style={{ minHeight: 44, justifyContent: 'center', paddingHorizontal: space.m, borderRadius: 999, borderWidth: 1, borderColor: selected ? t.primary : t.border, backgroundColor: selected ? t.okBg : t.surface }}>
      <Text style={{ color: t.text, fontSize: font.small, fontWeight: selected ? '700' : '400' }}>{label}</Text>
    </Pressable>
  );
}

export function StatusLine({ status, label, detail }: { status: 'pass' | 'warn' | 'fail' | 'pending'; label: string; detail?: string }) {
  const t = useTheme();
  const icon = status === 'pass' ? '✅' : status === 'warn' ? '⚠️' : status === 'fail' ? '⛔' : '⏳';
  const color = status === 'fail' ? t.danger : status === 'warn' ? t.warn : t.text;
  return (
    <Row>
      <Text style={{ fontSize: font.big }}>{icon}</Text>
      <View style={{ flex: 1 }}>
        <T style={{ color }}>{label}</T>
        {detail ? <T v="small" muted>{detail}</T> : null}
      </View>
    </Row>
  );
}

export function Banner({ text, tone = 'info' }: { text: string; tone?: 'ok' | 'warn' | 'info' | 'offline' }) {
  return (
    <Card tone={tone}>
      <T>{text}</T>
    </Card>
  );
}

export function MoodPicker({ value, onChange, label }: { value: number | null; onChange: (v: number | null) => void; label: string }) {
  const faces = ['😞', '🙁', '😐', '🙂', '😄'];
  const t = useTheme();
  return (
    <View style={{ gap: space.s }}>
      <T muted>{label} (optional)</T>
      <Row gap={space.s}>
        {faces.map((f, i) => (
          <Pressable key={f} accessibilityRole="button" accessibilityLabel={`Mood ${i + 1} of 5`} accessibilityState={{ selected: value === i + 1 }} onPress={() => onChange(value === i + 1 ? null : i + 1)} style={{ width: TOUCH, height: TOUCH, borderRadius: TOUCH / 2, alignItems: 'center', justifyContent: 'center', backgroundColor: value === i + 1 ? t.okBg : t.surfaceAlt, borderWidth: value === i + 1 ? 2 : 0, borderColor: t.primary }}>
            <Text style={{ fontSize: 28 }}>{f}</Text>
          </Pressable>
        ))}
      </Row>
    </View>
  );
}

export function CompassArrow({ bearing, size = 120 }: { bearing: number; size?: number }) {
  const t = useTheme();
  return (
    <View style={{ width: size, height: size, transform: [{ rotate: `${bearing}deg` }] }} accessibilityLabel={`Direction ${Math.round(bearing)} degrees`}>
      <Svg width={size} height={size} viewBox="0 0 100 100">
        <Path d="M50 6 L78 86 L50 70 L22 86 Z" fill={t.primary} />
      </Svg>
    </View>
  );
}

export function Loading({ text = 'Loading…' }: { text?: string }) {
  const t = useTheme();
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: space.m, backgroundColor: t.bg }}>
      <ActivityIndicator size="large" color={t.primary} />
      <T muted>{text}</T>
    </View>
  );
}

export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}

export function fmtKm(m: number): string {
  return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`;
}
