import qrcode from 'qrcode-generator';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AccessibilityInfo, Pressable, ScrollView, Text, View, useWindowDimensions, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';
import Svg, { Path, Rect } from 'react-native-svg';
import { font, radius, space, useTheme } from './theme';
import { Row, T } from './ui';

/* ------------------------------ verification ------------------------------ */

const LABEL_ICON: Record<string, string> = { Measured: '📡', Evidenced: '📷', Confirmed: '🤝', 'Self-reported': '✋', 'Checked after sync': '⏳' };

/** Every badge shows HOW it is known (icon + word, never colour alone). Self-reported = outline. */
export function VerificationBadge({ label }: { label: string }) {
  const t = useTheme();
  const outline = label === 'Self-reported' || label === 'Checked after sync';
  return (
    <View
      accessibilityLabel={`Verification: ${label}`}
      style={{ flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: space.s, paddingVertical: 2, borderRadius: 999, borderWidth: 1, borderStyle: label === 'Checked after sync' ? 'dashed' : 'solid', borderColor: t.primary, backgroundColor: outline ? 'transparent' : t.okBg, alignSelf: 'flex-start' }}
    >
      <Text style={{ fontSize: font.small }}>{LABEL_ICON[label] ?? '•'}</Text>
      <Text style={{ fontSize: font.small, color: t.text, fontWeight: '600' }}>{label}</Text>
    </View>
  );
}

const TIER_ICON: Record<string, string> = { unlock: '🌱', bronze: '🥉', silver: '🥈', gold: '🥇' };
export const tierIcon = (tier: string | null | undefined) => (tier ? (TIER_ICON[tier] ?? '•') : '○');

export function ProgressBar({ value, max, label }: { value: number; max: number; label?: string }) {
  const t = useTheme();
  const pct = Math.max(0, Math.min(1, max > 0 ? value / max : 0));
  return (
    <View accessibilityRole="progressbar" accessibilityValue={{ min: 0, max, now: Math.min(value, max) }} accessibilityLabel={label} style={{ height: 12, borderRadius: 6, backgroundColor: t.surfaceAlt, overflow: 'hidden' }}>
      <View style={{ width: `${Math.round(pct * 100)}%`, height: '100%', backgroundColor: t.primary }} />
    </View>
  );
}

/* ------------------------------ quote carousel ------------------------------ */

/** Original lines (no copyrighted quotes). Order rotates daily, no AI, works offline (design §7.7). */
export const QUOTES = [
  'Use the phone for two minutes, spend sixty outside.',
  'The grass is greener where you water it.',
  'Offline is where the good stuff happens.',
  'Your feet know the way. Let them.',
  'Fresh air is free. Take a deep breath of it.',
  'Ten minutes outside beats an hour of scrolling.',
  'The sky has been waiting for you to look up.',
  'Rest days are part of it.',
  'Small steps still count as steps.',
  'Every tree you water remembers.',
  'Leave the park cleaner than you found it.',
  'Touch grass. Literally.',
  'Your best notifications are birdsong.',
  'Go slow enough to notice something new.',
  'Sunlight is the original screen.',
  'The field is calling, and it is not a phone call.',
  'You do not need a reason to go outside.',
  'A walk is a meeting with yourself.',
  'Phone in pocket, eyes on the horizon.',
  'Make today the day you found a new path.',
  'Kindness is a team sport.',
  'The best view comes after the walk.',
  'Breathe in, look around, carry on.',
  'Mud washes off. Memories stay.',
  'Play like nobody is keeping score. Then check the score.',
  'Your neighbourhood looks different on foot.',
  'Good days start outside.',
  'Water a tree, grow a habit.',
  'Every quest begins with turning the Wi-Fi off.',
  'The ground under your feet is real. So are you.',
  'Laugh outside. It carries further.',
  'Clouds move slowly on purpose.',
  'Go outside and let your mind wander too.',
  'You are allowed to be bored outdoors.',
  'One more lap is optional. Feeling good is not.',
  'Your streak can rest. Your curiosity cannot.',
  'Collect moments, not notifications.',
  'Walk with someone and the minutes fly.',
  'A clean street is a love letter to your neighbours.',
  'The weather is just the outside saying hello.',
  'There is a whole world between your door and the park.',
  'Breaks under trees are the best kind of breaks.',
  'Look for three colours on your next walk.',
  'Count steps, not likes.',
  'Grass grows one blade at a time. So do you.',
  'Games are better in the open air.',
  'Show up. The rest follows.',
  'Golden hour is free for everyone.',
  'Be the friend who says "let us go outside".',
  'You can always come back to the screen later.',
  'Plant something today, even an idea.',
  'Quiet is a kind of music.',
  'Your phone will still be here. The sunset will not.',
  'Shoes on. Doubts off.',
  'A little outside every day adds up to a lot.',
  'Choose the stairs, the park, the long way round.',
  'The best map is the one you walk.',
  'Pause, notice, smile, continue.',
  'Your meadow grows with every offline minute.',
  'Go outside. Tell no one. Feel great.',
];

/** Deterministic daily order: same for everyone on a given day, fresh tomorrow. */
export function quotesForDay(dayKey: string, n = 8): string[] {
  let h = 0;
  for (const ch of dayKey) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const start = h % QUOTES.length;
  return Array.from({ length: Math.min(n, QUOTES.length) }, (_, i) => QUOTES[(start + i * 7) % QUOTES.length]!);
}

/**
 * Auto-sliding card row (marquee style). Slides every 6 s, pauses while touched, swipeable.
 * Respects "reduce motion": no auto-slide, the cards are still swipeable.
 */
export function QuoteCarousel({ cards, intervalMs = 6000 }: { cards: Array<{ key: string; text: string; tone?: 'quote' | 'personal' }>; intervalMs?: number }) {
  const t = useTheme();
  const { width } = useWindowDimensions();
  const cardW = Math.max(220, width - space.l * 2);
  const ref = useRef<ScrollView>(null);
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const [reduce, setReduce] = useState(false);
  useEffect(() => {
    let alive = true;
    void AccessibilityInfo.isReduceMotionEnabled?.().then((v) => alive && setReduce(!!v)).catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);
  useEffect(() => {
    if (reduce || paused || cards.length < 2) return;
    const id = setInterval(() => {
      setIndex((i) => {
        const next = (i + 1) % cards.length;
        ref.current?.scrollTo?.({ x: next * (cardW + space.s), animated: true });
        return next;
      });
    }, intervalMs);
    return () => clearInterval(id);
  }, [reduce, paused, cards.length, cardW, intervalMs]);
  const onEnd = (e: NativeSyntheticEvent<NativeScrollEvent>) => setIndex(Math.round(e.nativeEvent.contentOffset.x / (cardW + space.s)));
  return (
    <View accessibilityLabel="Motivation" style={{ gap: space.xs }}>
      <ScrollView
        ref={ref}
        horizontal
        pagingEnabled={false}
        snapToInterval={cardW + space.s}
        decelerationRate="fast"
        showsHorizontalScrollIndicator={false}
        onTouchStart={() => setPaused(true)}
        onTouchEnd={() => setPaused(false)}
        onMomentumScrollEnd={onEnd}
        contentContainerStyle={{ gap: space.s }}
      >
        {cards.map((c) => (
          <View key={c.key} style={{ width: cardW, minHeight: 92, borderRadius: radius.l, padding: space.l, justifyContent: 'center', backgroundColor: c.tone === 'personal' ? t.infoBg : t.okBg }}>
            <Text style={{ color: t.text, fontSize: font.big, fontWeight: c.tone === 'personal' ? '700' : '600', lineHeight: font.big * 1.3 }}>
              {c.tone === 'personal' ? '' : '“'}{c.text}{c.tone === 'personal' ? '' : '”'}
            </Text>
          </View>
        ))}
      </ScrollView>
      <Row style={{ justifyContent: 'center' }}>
        {cards.map((c, i) => (
          <View key={c.key} style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: i === index ? t.primary : t.border }} />
        ))}
      </Row>
    </View>
  );
}

/* ------------------------------ meadow ------------------------------ */

/** "Your meadow": a blade of grass per 10 verified offline minutes this week, flowers on 90-min days. Static SVG. */
export function Meadow({ offlineMinutes, flowers, height = 90 }: { offlineMinutes: number; flowers: number; height?: number }) {
  const t = useTheme();
  const blades = Math.min(60, Math.floor(offlineMinutes / 10));
  const shapes = useMemo(() => {
    const out: Array<{ d: string; color: string }> = [];
    for (let i = 0; i < blades; i++) {
      const x = 6 + ((i * 37) % 288);
      const h = 18 + ((i * 53) % 40);
      const lean = ((i * 17) % 11) - 5;
      out.push({ d: `M${x} ${height} Q${x + lean} ${height - h / 2} ${x + lean * 1.6} ${height - h} Q${x + 2} ${height - h / 2} ${x + 4} ${height} Z`, color: i % 3 === 0 ? t.ok : t.primary });
    }
    return out;
  }, [blades, height, t.ok, t.primary]);
  return (
    <View accessibilityLabel={`Your meadow: ${blades} blades of grass and ${flowers} flowers this week`}>
      <Svg width="100%" height={height} viewBox={`0 0 300 ${height}`}>
        <Rect x={0} y={height - 6} width={300} height={6} fill={t.surfaceAlt} />
        {shapes.map((s, i) => (
          <Path key={i} d={s.d} fill={s.color} />
        ))}
        {Array.from({ length: Math.min(7, flowers) }, (_, i) => (
          <Path key={`f${i}`} d={`M${30 + i * 40} ${height - 34} a6 6 0 1 0 0.1 0 Z`} fill={t.accent} />
        ))}
      </Svg>
      {blades === 0 ? <T v="small" muted center>Your meadow grows with every offline minute 🌱</T> : null}
    </View>
  );
}

/* ------------------------------ QR code ------------------------------ */

/** Renders a QR code as SVG squares (no native module; works on Android and iOS). */
export function QrCode({ value, size = 240, label = 'Confirmation QR code' }: { value: string; size?: number; label?: string }) {
  const t = useTheme();
  const cells = useMemo(() => {
    const qr = qrcode(0, 'M');
    qr.addData(value, 'Byte');
    qr.make();
    const n = qr.getModuleCount();
    const on: Array<[number, number]> = [];
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) on.push([r, c]);
    return { n, on };
  }, [value]);
  const quiet = 4;
  const total = cells.n + quiet * 2;
  return (
    <View accessibilityLabel={label} style={{ alignSelf: 'center', backgroundColor: '#fff', padding: space.s, borderRadius: radius.m }}>
      <Svg width={size} height={size} viewBox={`0 0 ${total} ${total}`}>
        <Rect x={0} y={0} width={total} height={total} fill="#ffffff" />
        {cells.on.map(([r, c]) => (
          <Rect key={`${r}-${c}`} x={c + quiet} y={r + quiet} width={1.02} height={1.02} fill="#000000" />
        ))}
      </Svg>
      <Text style={{ fontSize: font.small, textAlign: 'center', color: '#333' }}>{t ? 'Hold steady for the other phone' : ''}</Text>
    </View>
  );
}

/* ------------------------------ stats ------------------------------ */

export const STAT_INFO: Record<string, { icon: string; name: string }> = {
  VIT: { icon: '💚', name: 'Vitality' },
  AGI: { icon: '⚡', name: 'Agility' },
  STR: { icon: '💪', name: 'Strength' },
  SENSE: { icon: '👁', name: 'Sense' },
  AURA: { icon: '✨', name: 'Aura' },
};

export function StatBars({ xpByStat }: { xpByStat: Record<string, number> }) {
  const max = Math.max(50, ...Object.values(xpByStat));
  return (
    <View style={{ gap: space.s }}>
      {Object.entries(STAT_INFO).map(([k, info]) => (
        <View key={k} style={{ gap: 2 }}>
          <Row style={{ justifyContent: 'space-between' }}>
            <T>{info.icon} {info.name}</T>
            <T muted>{xpByStat[k] ?? 0} XP</T>
          </Row>
          <ProgressBar value={xpByStat[k] ?? 0} max={max} label={`${info.name} ${xpByStat[k] ?? 0} XP`} />
        </View>
      ))}
    </View>
  );
}

export function PressableRow({ children, onPress, label }: { children: React.ReactNode; onPress: () => void; label: string }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} style={({ pressed }) => ({ opacity: pressed ? 0.8 : 1, minHeight: 48, justifyContent: 'center' })}>
      {children}
    </Pressable>
  );
}
