import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { isPartyQr, type Fix, type PartyQrPayload, type PartySpec, type PartyTemplateId, type Rank, type ThemeId } from '@trina/contracts';
import { RANK_MAX_MINUTES, THEME_TITLES, TIER_FOR_MINUTES, type PartyGoalResult } from '@trina/engine';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Haptics from 'expo-haptics';
import * as Location from 'expo-location';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Platform, View } from 'react-native';
import { partyCollector, type InvitePreview, type SightingKind } from '../core/party';
import { partyTheme } from '../app/ai-service';
import type { RootParams } from '../app/navigation';
import { currentConnectivity, GO_OFFLINE_COPY, openInternetSettings, setQuestActive } from '../app/quest-runtime';
import { getServices } from '../app/services';
import { syncNow, useApp } from '../app/store';
import { startRuntime } from '../platform/session-runtime';
import { ProgressBar, QrCode } from '../components/progress';
import { Banner, Btn, Card, Chip, Field, Row, Screen, StatusLine, T } from '../components/ui';

/**
 * Offline Party Mode screens (docs/architecture/offline-party-mode.md). Everything here works with the
 * internet off: invites, meetings and progress all travel as QR codes between phones.
 */

const TEMPLATES: Array<{ id: PartyTemplateId; label: string; icon: string; theme: ThemeId }> = [
  { id: 'party_outside_v1', label: 'Time outside', icon: '🌳', theme: 'park_explorers' },
  { id: 'party_cleanup_v1', label: 'Litter clean-up', icon: '🧹', theme: 'litter_hunters' },
  { id: 'party_trees_v1', label: 'Water trees', icon: '💧', theme: 'tree_patrol' },
];
const LENGTHS = [30, 45, 60, 90] as const;

/** Shows one or more frames; multi-frame codes cycle so the other phone can collect them in any order. */
function FramesQr({ frames, label }: { frames: string[]; label: string }) {
  const [i, setI] = useState(0);
  useEffect(() => {
    setI(0);
    if (frames.length < 2) return;
    const h = setInterval(() => setI((x) => (x + 1) % frames.length), 1200);
    return () => clearInterval(h);
  }, [frames]);
  return (
    <View>
      <QrCode value={frames[i]!} label={label} />
      {frames.length > 1 ? <T v="small" muted center>Part {i + 1} of {frames.length}: keep the camera on it</T> : null}
    </View>
  );
}

/** Scans party codes (single or multi-frame). `onPayload` resolves false when refused: scanning resumes. */
function PartyScanner({ onPayload, label }: { onPayload: (p: PartyQrPayload) => Promise<boolean>; label: string }) {
  const [perm, ask] = useCameraPermissions();
  const collector = useRef(partyCollector());
  const busy = useRef(false);
  const [progress, setProgress] = useState<{ have: number; total: number }>({ have: 0, total: 0 });
  if (!perm) return <T muted>…</T>;
  if (!perm.granted) return <Btn title="Allow camera to scan" onPress={ask} />;
  return (
    <View style={{ height: 300, borderRadius: 16, overflow: 'hidden' }}>
      <CameraView
        style={{ flex: 1 }}
        facing="back"
        barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
        onBarcodeScanned={({ data }) => {
          if (busy.current || !isPartyQr(data)) return;
          try {
            const payload = collector.current.add(data);
            setProgress(collector.current.progress());
            if (!payload) return;
            busy.current = true;
            void onPayload(payload).then((ok) => {
              if (!ok) busy.current = false;
            });
          } catch {
            /* a damaged frame: keep scanning */
          }
        }}
      />
      <T v="small" muted center>{progress.total > 1 ? `Got ${progress.have} of ${progress.total} parts` : label}</T>
    </View>
  );
}

/** Online check, GPS fix and own-data pre-sync, shared by host and join (Offline Quest Mode rules). */
function useOfflineReady() {
  const [online, setOnline] = useState<boolean | null>(null);
  const [fix, setFix] = useState<Location.LocationObject | null>(null);
  const [presynced, setPresynced] = useState(false);
  useEffect(() => {
    void (async () => {
      const c = await currentConnectivity();
      if (c.online) {
        await syncNow(); // own data syncs BEFORE going offline
        await (await getServices()).ensureDeviceKey(); // the party key must be registered while online
      }
      setPresynced(true);
      setOnline(c.online);
    })();
    const poll = setInterval(async () => setOnline((await currentConnectivity()).online), 2000);
    let sub: Location.LocationSubscription | null = null;
    void Location.getForegroundPermissionsAsync().then(async (p) => {
      if (!p.granted) return;
      sub = await Location.watchPositionAsync({ accuracy: Location.Accuracy.BestForNavigation, timeInterval: 2000, distanceInterval: 0 }, setFix);
    });
    return () => {
      clearInterval(poll);
      sub?.remove();
    };
  }, []);
  const startFix = (): Fix | null =>
    fix ? { lat: fix.coords.latitude, lng: fix.coords.longitude, acc: fix.coords.accuracy ?? 999, ts: new Date(fix.timestamp).toISOString(), mocked: fix.mocked === true } : null;
  return { online, fix, presynced, startFix };
}

function OfflineChecklist({ online, fix, presynced }: { online: boolean | null; fix: Location.LocationObject | null; presynced: boolean }) {
  return (
    <>
      <StatusLine status={presynced ? 'pass' : 'pending'} label={presynced ? 'Your data is synced' : 'Syncing your data first…'} />
      <StatusLine status={online === false ? 'pass' : online === null ? 'pending' : 'fail'} label={online === false ? 'Offline: ready' : GO_OFFLINE_COPY.title} detail={online ? (Platform.OS === 'ios' ? GO_OFFLINE_COPY.ios : GO_OFFLINE_COPY.body) : undefined} />
      <StatusLine status={fix ? 'pass' : 'pending'} label={fix ? 'GPS ready' : 'Getting a GPS fix…'} detail={fix ? `±${Math.round(fix.coords.accuracy ?? 0)} m` : 'Do this before turning the internet off'} />
      {online ? <Btn title="Open internet settings" kind="secondary" onPress={openInternetSettings} /> : null}
    </>
  );
}

async function enterParty(sessionId: string) {
  await setQuestActive(sessionId); // QuestGuard: no network calls until the party ends
  await startRuntime(sessionId);
  useApp.getState().set({ activeSessionId: sessionId });
  await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
}

/** Host or join. */
export function PartyScreen({ navigation }: NativeStackScreenProps<RootParams, 'Party'>) {
  return (
    <Screen title="Offline party" back pill={false}>
      <Card tone="ok">
        <T v="h2">🎉 Play together, internet off</T>
        <T>One phone hosts the mission; friends scan its code. Meet up by scanning each other's codes. Up to 11 players.</T>
      </Card>
      <Btn title="Host a party" icon="📣" onPress={() => navigation.navigate('PartyHost')} />
      <Btn title="Join a party" icon="📷" kind="secondary" onPress={() => navigation.navigate('PartyJoin')} />
      <T v="small" muted>Only display names are shared. Party goals earn milestone XP, never score or rank.</T>
    </Screen>
  );
}

/** Host: pick the mission, show the invite, start. */
export function PartyHostScreen({ navigation }: NativeStackScreenProps<RootParams, 'PartyHost'>) {
  const me = useApp((s) => s.me);
  const ready = useOfflineReady();
  const [template, setTemplate] = useState(TEMPLATES[1]!);
  const [minutes, setMinutes] = useState<(typeof LENGTHS)[number]>(30);
  const [rank, setRank] = useState<Rank>('E');
  const [vibe, setVibe] = useState('');
  const [invite, setInvite] = useState<{ frames: string[]; preview: InvitePreview } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const p = await (await (await getServices()).milestones()).progress().catch(() => null);
      if (p) setRank(p.server?.rank ?? p.provisional.rank);
    })();
  }, []);
  const maxMinutes = RANK_MAX_MINUTES[rank];

  const create = async () => {
    const startFix = ready.startFix();
    if (!startFix) return setError('Waiting for GPS…');
    setBusy(true);
    setError(null);
    try {
      // The AI (or rules) picks only a theme name from the vibe; numbers come from the template + length.
      const themeId = vibe.trim() ? (await partyTheme(vibe, template.id)).themeId : template.theme;
      const spec: PartySpec = { v: 1, templateId: template.id, targetMinutes: minutes, levelTier: TIER_FOR_MINUTES[minutes], themeId };
      setInvite(await (await (await getServices()).party()).createInvite({ spec, startFix }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const start = async () => {
    const startFix = ready.startFix();
    if (!invite || !startFix) return;
    setBusy(true);
    setError(null);
    try {
      const sessionId = await (await (await getServices()).party()).start({ invite: invite.preview.invite, startFix, online: !!ready.online });
      await enterParty(sessionId);
      navigation.replace('PartyPlay', { sessionId });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (invite) {
    return (
      <Screen title="Your party invite" back pill={false}>
        <Card tone="ok">
          <T v="h2">{invite.preview.title}</T>
          <T>Together: {invite.preview.goalText}</T>
        </Card>
        <FramesQr frames={invite.frames} label="Party invite QR code" />
        <Card>
          <T v="small" muted>Check words: friends should see the same four</T>
          <T v="h2" center>{invite.preview.checkWords.join(' · ')}</T>
        </Card>
        <OfflineChecklist {...ready} />
        {error ? <Banner tone="warn" text={error} /> : null}
        <Btn title={ready.online ? 'Turn the internet off to start' : 'Start the party'} icon={ready.online ? '📴' : '▶'} disabled={ready.online !== false || !ready.fix} busy={busy} onPress={start} />
      </Screen>
    );
  }

  return (
    <Screen title="Host a party" back pill={false}>
      <T v="h2">Mission</T>
      <Row>
        {TEMPLATES.map((t) => (
          <Chip key={t.id} label={`${t.icon} ${t.label}`} selected={template.id === t.id} onPress={() => setTemplate(t)} />
        ))}
      </Row>
      <Field label="Vibe (optional): the AI picks a theme name" placeholder="e.g. sunrise by the lake" value={vibe} onChangeText={setVibe} maxLength={120} />
      {!vibe.trim() ? <T v="small" muted>Theme: {THEME_TITLES[template.theme]}</T> : null}
      <T v="h2">Length</T>
      <Row>
        {LENGTHS.filter((m) => m <= maxMinutes).map((m) => (
          <Chip key={m} label={`${m} min`} selected={minutes === m} onPress={() => setMinutes(m)} />
        ))}
      </Row>
      {maxMinutes < 90 ? <T v="small" muted>Longer parties unlock as your rank grows.</T> : null}
      <StatusLine status={ready.fix ? 'pass' : 'pending'} label={ready.fix ? 'GPS ready: the party starts where you stand' : 'Getting a GPS fix…'} />
      {error ? <Banner tone="warn" text={error} /> : null}
      <Btn title="Create invite" icon="📣" disabled={!ready.fix || !me} busy={busy} onPress={create} />
    </Screen>
  );
}

/** Member: scan the invite, check the words, start next to the host. */
export function PartyJoinScreen({ navigation }: NativeStackScreenProps<RootParams, 'PartyJoin'>) {
  const ready = useOfflineReady();
  const [preview, setPreview] = useState<InvitePreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const scanned = async (p: PartyQrPayload) => {
    try {
      setPreview((await (await getServices()).party()).preview(p));
      setError(null);
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    }
  };

  const start = async () => {
    const startFix = ready.startFix();
    if (!preview || !startFix) return;
    setBusy(true);
    setError(null);
    try {
      const sessionId = await (await (await getServices()).party()).start({ invite: preview.invite, startFix, online: !!ready.online });
      await enterParty(sessionId);
      navigation.replace('PartyPlay', { sessionId, meetFirst: true });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen title="Join a party" back pill={false}>
      {!preview ? (
        <PartyScanner onPayload={scanned} label="Scan the host's invite" />
      ) : (
        <>
          <Card tone="ok">
            <T v="h2">{preview.title}</T>
            <T>Host: {preview.hostName} · {preview.minutes} min · together: {preview.goalText}</T>
          </Card>
          <Card>
            <T v="small" muted>Check words: these must match the host's screen</T>
            <T v="h2" center>{preview.checkWords.join(' · ')}</T>
          </Card>
          <OfflineChecklist {...ready} />
          <Btn title={ready.online ? 'Turn the internet off to join' : 'Join and start'} icon={ready.online ? '📴' : '▶'} disabled={ready.online !== false || !ready.fix} busy={busy} onPress={start} />
          <Btn title="Scan a different invite" kind="ghost" onPress={() => setPreview(null)} />
        </>
      )}
      {error ? <Banner tone="warn" text={error} /> : null}
    </Screen>
  );
}

type Mode = { k: 'home' } | { k: 'show'; frames: string[]; label: string; then: 'scan_answer' | 'done' } | { k: 'scan' } | { k: 'share'; frames: string[] };

/** In the party: the shared goal, meetings and progress sharing. "Back to activity" returns to the live screen. */
export function PartyPlayScreen({ route, navigation }: NativeStackScreenProps<RootParams, 'PartyPlay'>) {
  const { sessionId, meetFirst } = route.params;
  const [goal, setGoal] = useState<(PartyGoalResult & { title: string; checkWords: string[] }) | null>(null);
  const [meetings, setMeetings] = useState<Array<{ name: string; kind: SightingKind }>>([]);
  const [mode, setMode] = useState<Mode>({ k: 'home' });
  const [kind, setKind] = useState<SightingKind>(meetFirst ? 'join' : 'checkpoint');
  const [msg, setMsg] = useState<string | null>(meetFirst ? 'Now meet the host: show them your code, then scan theirs.' : null);

  const refresh = useCallback(async () => {
    const party = await (await getServices()).party();
    setGoal(await party.progress(sessionId));
    setMeetings(await party.sightings(sessionId));
  }, [sessionId]);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const showMine = async () => {
    try {
      setMode({ k: 'show', frames: await (await (await getServices()).party()).offer(sessionId), label: 'Your meeting code', then: 'scan_answer' });
    } catch (e) {
      setMsg((e as Error).message);
    }
  };

  const scanned = async (p: PartyQrPayload): Promise<boolean> => {
    try {
      const r = await (await (await getServices()).party()).scan(sessionId, p, kind);
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
      if (r.kind === 'answer') {
        setMsg(`Met ${r.peerName}. Show them this code so their phone records it too.`);
        setMode({ k: 'show', frames: r.frames, label: 'Your answer code', then: 'done' });
      } else if (r.kind === 'recorded') {
        setMsg(`Meeting with ${r.peerName} recorded on both phones.`);
        setMode({ k: 'home' });
      } else {
        setMsg(`Progress updated: ${r.members} players.`);
        setMode({ k: 'home' });
      }
      void refresh();
      return true;
    } catch (e) {
      setMsg((e as Error).message);
      return false;
    }
  };

  const share = async () => setMode({ k: 'share', frames: await (await (await getServices()).party()).shareFrames(sessionId) });

  return (
    <Screen title={goal?.title ?? 'Party'} back pill={false}>
      {goal ? (
        <Card tone={goal.reached ? 'ok' : 'info'}>
          <T v="h2">{goal.reached ? '🎉 Goal reached!' : 'Party goal'}</T>
          <T>{goal.total} / {goal.target} {goal.label} · {goal.members} {goal.members === 1 ? 'player' : 'players'}</T>
          <ProgressBar value={goal.total} max={Math.max(1, goal.target)} label="Party goal progress" />
          {goal.perMember.map((m) => (
            <T key={m.userId} v="small" muted>{m.name}: {m.goalValue}{m.done ? ' ✓' : ''}</T>
          ))}
          <T v="small" muted>On this phone, until the server checks it after sync.</T>
        </Card>
      ) : null}
      {msg ? <Banner tone="info" text={msg} /> : null}

      {mode.k === 'show' ? (
        <>
          <FramesQr frames={mode.frames} label={mode.label} />
          {mode.then === 'scan_answer' ? <Btn title="Scan their answer" icon="📷" onPress={() => setMode({ k: 'scan' })} /> : null}
          <Btn title="Done" kind="ghost" onPress={() => setMode({ k: 'home' })} />
        </>
      ) : mode.k === 'scan' ? (
        <>
          <PartyScanner onPayload={scanned} label="Scan a teammate's code" />
          <Btn title="Cancel" kind="ghost" onPress={() => setMode({ k: 'home' })} />
        </>
      ) : mode.k === 'share' ? (
        <>
          <FramesQr frames={mode.frames} label="Party progress QR code" />
          <T v="small" muted center>Teammates scan this to see everyone's progress you know about.</T>
          <Btn title="Done" kind="ghost" onPress={() => setMode({ k: 'home' })} />
        </>
      ) : (
        <>
          <T v="h2">Meet a teammate</T>
          <Row>
            {(['join', 'checkpoint', 'wrapup'] as const).map((k) => (
              <Chip key={k} label={k === 'join' ? 'Joining' : k === 'checkpoint' ? 'On the way' : 'Wrap-up'} selected={kind === k} onPress={() => setKind(k)} />
            ))}
          </Row>
          <Row>
            <Btn title="Show my code" icon="🔳" onPress={showMine} style={{ flex: 1 }} />
            <Btn title="Scan" icon="📷" kind="secondary" onPress={() => setMode({ k: 'scan' })} style={{ flex: 1 }} />
          </Row>
          <Btn title="Share progress" icon="🔁" kind="secondary" onPress={share} />
          <Btn title="Back to activity" kind="ghost" onPress={() => navigation.navigate('Live', { sessionId })} />
          <T v="small" muted>Meetings recorded: {meetings.length ? meetings.map((m) => m.name).join(', ') : 'none yet'}. Do a wrap-up scan before you finish.</T>
        </>
      )}
    </Screen>
  );
}
