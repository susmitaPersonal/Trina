import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { bearingDeg, haversineM, type BreakdownItem, type CompiledChallenge } from '@trina/engine';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Haptics from 'expo-haptics';
import * as Location from 'expo-location';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Image, Pressable, Text, View } from 'react-native';
import type { LiveSnapshot } from '../core/session-manager';
import { checkLive, onLiveSnapshot } from '../app/live-monitor';
import { announceMilestones } from '../app/milestone-notify';
import { openInternetSettings, setQuestActive } from '../app/quest-runtime';
import type { LocalMilestone } from '../core/milestones';
import { tierIcon, VerificationBadge } from '../components/progress';
import { confirmableClaims } from './confirm';
import type { RootParams } from '../app/navigation';
import { getServices } from '../app/services';
import { syncNow, useApp } from '../app/store';
import { getWeightKg } from '../platform/secure';
import { storeEvidencePhoto } from '../platform/files';
import { adaptSampling, distanceToNext, stopRuntime, trackingMode } from '../platform/session-runtime';
import { RouteMap } from '../components/RouteMap';
import { font, radius, space, TOUCH, useTheme } from '../components/theme';
import { Banner, Btn, Card, CompassArrow, Field, fmtDuration, fmtKm, MoodPicker, Row, Screen, Stat, StatusLine, T } from '../components/ui';

function useLive(sessionId: string, intervalMs = 5000) {
  const [snap, setSnap] = useState<LiveSnapshot | null>(null);
  const refresh = useCallback(async () => {
    try {
      setSnap(await checkLive(sessionId));
    } catch {
      /* ignore transient */
    }
  }, [sessionId]);
  useEffect(() => {
    void refresh();
    const off = onLiveSnapshot((s) => s.sessionId === sessionId && setSnap(s));
    const t = setInterval(refresh, intervalMs);
    return () => {
      off();
      clearInterval(t);
    };
  }, [refresh, sessionId, intervalMs]);
  return { snap, refresh };
}

/** Task type of a challenge task from the challenge's OWN modules (custom modules aren't in the default registry). */
export function taskTypeIn(compiled: CompiledChallenge, type: string) {
  for (const m of compiled.modules) for (const tt of m.taskTypes) if (`${m.id}.${tt.id}` === type) return tt;
  return undefined;
}

/** Counter pad for data modules (big +1 / −1; corrections stay append-only). */
function CounterPad({ snap, sessionId, onChange }: { snap: LiveSnapshot; sessionId: string; onChange: () => void }) {
  const counters = snap.compiled.modules.flatMap((m) => (m.counters ?? []).map((c) => ({ id: `${m.id}.${c.id}`, c })));
  if (!counters.length) return null;
  const tap = async (id: string, delta: number) => {
    await (await (await getServices()).sessions()).reportCount(sessionId, id, delta);
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
    onChange();
  };
  return (
    <Card>
      <T v="small" muted>COUNT AS YOU PLAY</T>
      {counters.map(({ id, c }) => (
        <Row key={id} style={{ justifyContent: 'space-between' }}>
          <View style={{ flex: 1 }}>
            <T v="big">{c.label}: {snap.state.counters[id] ?? 0}</T>
            <T v="small" muted>{c.verification === 'self_report' ? 'Self-reported (titles only)' : `Confirmed: ${snap.state.confirmed[id] ?? 0}`}</T>
          </View>
          <Btn title="−" kind="secondary" accessibilityLabel={`Minus one ${c.label}`} onPress={() => tap(id, -1)} disabled={(snap.state.counters[id] ?? 0) <= 0} />
          <Btn title="+1" accessibilityLabel={`Plus one ${c.label}`} onPress={() => tap(id, 1)} />
        </Row>
      ))}
    </Card>
  );
}

function currentTask(snap: LiveSnapshot) {
  for (const t of snap.compiled.tasks.values()) {
    const st = snap.state.tasks[t.id]!;
    if (st.status === 'available' || st.status === 'started') return t;
  }
  return null;
}

export function LiveScreen({ route, navigation }: NativeStackScreenProps<RootParams, 'Live'>) {
  const { sessionId } = route.params;
  const t = useTheme();
  const online = useApp((s) => s.online);
  const { snap, refresh } = useLive(sessionId);
  const [now, setNow] = useState(Date.now());
  const [showAway, setShowAway] = useState(true);
  const seen = useRef<Set<string> | null>(null);

  useEffect(() => {
    const a = setTimeout(() => setShowAway(false), 5000);
    const c = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      clearTimeout(a);
      clearInterval(c);
    };
  }, []);

  useEffect(() => {
    if (!snap) return;
    if (snap.state.status === 'completed' || snap.state.status === 'abandoned') {
      navigation.replace('Completion', { sessionId });
      return;
    }
    const reached = Object.entries(snap.state.checkpoints).filter(([, c]) => c.reached).map(([id]) => id);
    if (seen.current === null) seen.current = new Set(reached);
    const fresh = reached.find((id) => !seen.current!.has(id));
    if (fresh) {
      seen.current.add(fresh);
      navigation.navigate('Checkpoint', { sessionId, checkpointId: fresh });
    }
    void adaptSampling(distanceToNext(snap));
  }, [snap, navigation, sessionId]);

  if (!snap) return <Screen title="Starting…" pill={false}><T muted>Loading your challenge…</T></Screen>;

  const { compiled, state } = snap;
  const nextId = compiled.routeOrder.find((id) => !state.checkpoints[id]!.reached);
  const next = nextId ? compiled.checkpoints.get(nextId)! : null;
  const last = state.lastSample;
  const dist = next && last ? haversineM([last.lng, last.lat], next.geometry.center) : null;
  const brg = next && last ? bearingDeg([last.lng, last.lat], next.geometry.center) : 0;
  const task = currentTask(snap);
  const elapsedSinceSnap = state.status === 'paused' ? 0 : Math.max(0, now - Date.now());
  const remaining = Math.max(0, snap.remainingMs - elapsedSinceSnap);
  const total = compiled.checkpoints.size;
  const reachedN = Object.values(state.checkpoints).filter((c) => c.reached).length;
  const needsPhoto = task && task.evidence.length > 0;
  const canManual = next && dist !== null && dist <= next.geometry.radiusM + 75 && dist > next.geometry.radiusM;

  const isQuest = !!state.quest;
  const stopQuest = () =>
    Alert.alert('Stop quest?', 'Stopping for safety never costs points. Take care of yourself first.', [
      { text: 'Keep going', style: 'cancel' },
      ...(['unwell', 'weather', 'emergency', 'need_phone'] as const).map((r) => ({
        text: `Safety: ${r === 'need_phone' ? 'I need my phone' : r === 'unwell' ? "I don't feel well" : r === 'weather' ? 'Bad weather' : 'Emergency'}`,
        onPress: async () => {
          await stopRuntime(sessionId);
          await (await (await getServices()).sessions()).stopQuest(sessionId, 'safety', r);
          await setQuestActive(null);
          navigation.replace('Completion', { sessionId });
        },
      })),
      {
        text: 'I just want to stop',
        style: 'destructive' as const,
        onPress: async () => {
          await stopRuntime(sessionId);
          await (await (await getServices()).sessions()).stopQuest(sessionId, 'force', null);
          await setQuestActive(null);
          navigation.replace('Completion', { sessionId });
        },
      },
    ]);
  const menu = () =>
    Alert.alert(isQuest ? 'Quest' : 'Challenge', undefined, [
      state.status === 'paused'
        ? { text: 'Resume', onPress: async () => { await (await (await getServices()).sessions()).append(sessionId, 'SessionResumed', {}); void refresh(); } }
        : { text: 'Pause', onPress: async () => { await (await (await getServices()).sessions()).append(sessionId, 'SessionPaused', {}); void refresh(); } },
      {
        text: 'Finish now',
        onPress: () =>
          Alert.alert('Finish the challenge?', 'Your progress so far will be scored.', [
            { text: 'Keep going', style: 'cancel' },
            {
              text: 'Finish',
              onPress: async () => {
                const s = await getServices();
                await stopRuntime(sessionId);
                await (await s.sessions()).finish(sessionId, 'manual', { shareWellbeing: (await s.me())?.shareWellbeing ?? false, weightKg: await getWeightKg() });
                if (isQuest) await setQuestActive(null);
                navigation.replace('Completion', { sessionId });
              },
            },
          ]),
      },
      isQuest
        ? { text: 'Stop quest', style: 'destructive', onPress: stopQuest }
        : {
            text: 'Abandon',
            style: 'destructive',
            onPress: async () => {
              await stopRuntime(sessionId);
              await (await (await getServices()).sessions()).abandon(sessionId, 'user abandoned');
              navigation.replace('Completion', { sessionId });
            },
          },
      { text: 'Cancel', style: 'cancel' },
    ]);

  return (
    <Screen pill={false} scroll={false}>
      <Row style={{ justifyContent: 'space-between' }}>
        <T v="h1">⏱ {fmtDuration(remaining)}</T>
        <Row>
          <T v="small" muted>{online ? '🟢' : '📴 offline'}</T>
          <Pressable accessibilityRole="button" accessibilityLabel="Challenge menu" onPress={menu} style={{ minWidth: TOUCH, minHeight: TOUCH, alignItems: 'center', justifyContent: 'center' }}>
            <T v="h2">⋯</T>
          </Pressable>
        </Row>
      </Row>
      {isQuest && online ? (
        <Card tone="warn">
          <T v="big">📶 You're online</T>
          <T>Turn mobile data and Wi-Fi off within 60 seconds to keep your quest going. Calls keep working.</T>
          <Btn title="Open internet settings" kind="secondary" onPress={openInternetSettings} />
        </Card>
      ) : null}
      {state.status === 'paused' ? <Banner tone="warn" text={isQuest ? '⏸ Quest paused while online. Go offline to continue.' : '⏸ Paused. The clock is stopped.'} /> : null}
      {showAway ? <Banner tone="ok" text="📵 Put your phone away. We'll buzz you at the next checkpoint." /> : null}
      {trackingMode() === 'foreground_only' ? <Banner tone="warn" text="Keep Trina open: this phone doesn't allow tracking with the screen off." /> : null}

      {isQuest ? (
        <Card tone="ok">
          <T v="small" muted>OFFLINE QUEST · {state.quest!.targetMinutes} MIN</T>
          <T v="h2">🌱 {Math.floor(Number(snap.score.facts.zone_dwell_s ?? 0) / 60)} min outside</T>
          <T muted>Phone in pocket. We'll buzz you when the quest is done.</T>
        </Card>
      ) : next ? (
        <Card>
          <T v="small" muted>NEXT CHECKPOINT</T>
          <Row style={{ justifyContent: 'space-between' }}>
            <View style={{ flex: 1 }}>
              <T v="h2">{next.name}</T>
              <T v="big">{dist !== null ? fmtKm(dist) : 'Waiting for GPS…'}</T>
            </View>
            {dist !== null ? <CompassArrow bearing={brg} size={96} /> : null}
          </Row>
          {canManual ? (
            <Btn
              title="I'm here (weak GPS)"
              kind="secondary"
              onPress={async () => {
                const l = await Location.getLastKnownPositionAsync();
                await (await (await getServices()).sessions()).append(sessionId, 'CheckpointManualConfirm', {
                  checkpointId: next.id,
                  fix: l ? { lat: l.coords.latitude, lng: l.coords.longitude, acc: l.coords.accuracy ?? 999, ts: new Date(l.timestamp).toISOString() } : null,
                });
                void refresh();
              }}
            />
          ) : null}
        </Card>
      ) : (
        <Card tone="ok">
          <T v="big">🏁 All checkpoints done{compiled.definition.completion.endZoneRequired ? ': head back to the finish' : ''}</T>
        </Card>
      )}

      <CounterPad snap={snap} sessionId={sessionId} onChange={() => void refresh()} />
      {!isQuest && (confirmableClaims(snap).length || snap.compiled.modules.some((m) => (m.counters ?? []).some((c) => c.verification !== 'self_report'))) ? (
        <Row>
          <Btn title="Ask to confirm" icon="🤝" kind="secondary" onPress={() => navigation.navigate('Confirm', { sessionId, mode: 'ask' })} style={{ flex: 1 }} />
          <Btn title="Confirm a friend" icon="📷" kind="secondary" onPress={() => navigation.navigate('Confirm', { sessionId, mode: 'scan' })} style={{ flex: 1 }} />
        </Row>
      ) : null}
      <Card>
        <T v="small" muted>CURRENT TASK</T>
        <T v="big">{task ? task.title : 'Reach the next checkpoint to unlock tasks'}</T>
        {task?.evidence[0]?.hint ? <T muted>📷 {task.evidence[0].hint}</T> : null}
      </Card>

      <Row style={{ justifyContent: 'center' }}>
        {compiled.routeOrder.map((id) => (
          <Text key={id} style={{ fontSize: font.big, color: state.checkpoints[id]!.reached ? t.primary : t.textMuted }}>{state.checkpoints[id]!.reached ? '●' : '○'}</Text>
        ))}
        <T muted>  {reachedN}/{total} checkpoints</T>
      </Row>
      <Row>
        <Stat label="distance" value={fmtKm(state.distanceM)} />
        <Stat label="steps" value={snap.wellness.steps !== null ? String(snap.wellness.steps) : '–'} />
        <Stat label="pts (provisional)" value={String(snap.score.total)} />
      </Row>

      <Row>
        {needsPhoto ? <Btn title="Evidence" icon="📷" onPress={() => navigation.navigate('Camera', { sessionId, taskId: task!.id })} style={{ flex: 1 }} /> : null}
        <Btn title="Map" icon="🗺" kind="secondary" onPress={() => navigation.navigate('Map', { sessionId })} style={{ flex: 1 }} />
        <Btn title="Tasks" icon="☰" kind="secondary" onPress={() => navigation.navigate('Tasks', { sessionId })} style={{ flex: 1 }} />
      </Row>
      <T v="small" muted center>🔒 You can lock your phone now. Progress is saved on this device.</T>
    </Screen>
  );
}

export function MapScreen({ route, navigation }: NativeStackScreenProps<RootParams, 'Map'>) {
  const { snap } = useLive(route.params.sessionId, 4000);
  if (!snap) return <Screen title="Map" pill={false}><T muted>Loading…</T></Screen>;
  const reached = Object.fromEntries(Object.entries(snap.state.checkpoints).map(([k, v]) => [k, v.reached]));
  const last = snap.state.lastSample;
  return (
    <Screen title="🗺 Map" pill={false}>
      <RouteMap def={snap.compiled.definition} reached={reached} track={snap.state.track.map((p) => [p.lng, p.lat])} me={last ? { lng: last.lng, lat: last.lat, acc: last.acc } : null} height={420} />
      <T v="small" muted>Offline vector view: S = start, numbers = checkpoints, blue = your route. No map tiles needed.</T>
      <Btn title="Back" onPress={() => navigation.goBack()} />
    </Screen>
  );
}

export function TasksScreen({ route, navigation }: NativeStackScreenProps<RootParams, 'Tasks'>) {
  const { sessionId } = route.params;
  const { snap, refresh } = useLive(sessionId, 3000);
  const [timer, setTimer] = useState<{ taskId: string; until: number } | null>(null);
  const [, force] = useState(0);
  useEffect(() => {
    const i = setInterval(() => force((x) => x + 1), 1000);
    return () => clearInterval(i);
  }, []);
  if (!snap) return <Screen title="Tasks" pill={false}><T muted>Loading…</T></Screen>;
  return (
    <Screen title="☰ Tasks" pill={false}>
      {[...snap.compiled.tasks.values()].map((task) => {
        const st = snap.state.tasks[task.id]!;
        const tt = taskTypeIn(snap.compiled, task.type);
        const needsConfirm = tt?.completion === 'confirmation';
        const needsPhoto = task.evidence.length > 0;
        const photos = st.evidenceIds.filter((id) => !snap.state.evidence[id]?.invalidReason).length;
        const status = st.status === 'done' ? 'pass' : st.status === 'locked' ? 'pending' : 'warn';
        const where = task.location.kind === 'checkpoint' ? `🔒 at ${snap.compiled.checkpoints.get(task.location.ref!)?.name}` : 'anywhere';
        const waiting = timer?.taskId === task.id && Date.now() < timer.until;
        return (
          <Card key={task.id}>
            <StatusLine status={status} label={task.title ?? task.type} detail={st.status === 'locked' ? where : st.status === 'done' ? 'Done (pending verification)' : needsPhoto ? `${photos}/${task.evidence[0]!.count} photo` : 'Self-report'} />
            {st.status !== 'locked' && st.status !== 'done' ? (
              needsConfirm ? (
                <Btn title="Ask a teammate to confirm" icon="🤝" onPress={() => navigation.navigate('Confirm', { sessionId, mode: 'ask' })} />
              ) : needsPhoto ? (
                <Btn title="Take photo" icon="📷" onPress={() => navigation.navigate('Camera', { sessionId, taskId: task.id })} />
              ) : (
                <Btn
                  title={waiting ? `Take your time… ${Math.ceil((timer!.until - Date.now()) / 1000)}s` : timer?.taskId === task.id ? 'I did it ✓' : 'Start'}
                  disabled={waiting}
                  onPress={async () => {
                    const sm = await (await getServices()).sessions();
                    if (timer?.taskId !== task.id) {
                      if (st.status === 'available') await sm.append(sessionId, 'TaskStarted', { taskId: task.id });
                      setTimer({ taskId: task.id, until: Date.now() + (tt?.minTaskSeconds ?? 0) * 1000 });
                    } else {
                      await sm.append(sessionId, 'TaskCompleted', { taskId: task.id });
                      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
                      setTimer(null);
                    }
                    void refresh();
                  }}
                />
              )
            ) : null}
          </Card>
        );
      })}
      <Btn title="Back" kind="secondary" onPress={() => navigation.goBack()} />
    </Screen>
  );
}

export function CameraScreen({ route, navigation }: NativeStackScreenProps<RootParams, 'Camera'>) {
  const { sessionId, taskId } = route.params;
  const t = useTheme();
  const cam = useRef<CameraView>(null);
  const [permission, requestPermission] = useCameraPermissions();
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [quantity, setQuantity] = useState('');
  const { snap, refresh } = useLive(sessionId, 10_000);
  const task = snap?.compiled.tasks.get(taskId);
  const isCleanup = task?.type === 'cleanup.collect_items';

  if (!permission) return <Screen pill={false}><T muted>…</T></Screen>;
  if (!permission.granted) {
    return (
      <Screen title="Camera" pill={false}>
        <T>Evidence photos are taken inside Trina so they can be verified.</T>
        <Btn title="Allow camera" onPress={requestPermission} />
        <Btn title="Back" kind="ghost" onPress={() => navigation.goBack()} />
      </Screen>
    );
  }

  const shoot = async () => {
    const pic = await cam.current?.takePictureAsync({ quality: 0.9, exif: false });
    if (pic) setPreview(pic.uri);
  };

  const use = async () => {
    if (!preview || !task) return;
    setBusy(true);
    try {
      const s = await getServices();
      const sm = await s.sessions();
      const stored = await storeEvidencePhoto(preview, sessionId, `${taskId}-${Date.now()}`);
      const l = await Location.getLastKnownPositionAsync({ maxAge: 10_000 });
      await sm.captureEvidence({
        sessionId,
        taskId,
        checkpointId: task.location.kind === 'checkpoint' ? task.location.ref ?? null : null,
        fileUri: stored.uri,
        sha256: stored.sha256,
        bytes: stored.bytes,
        fix: l ? { lat: l.coords.latitude, lng: l.coords.longitude, acc: l.coords.accuracy ?? 999, ts: new Date(l.timestamp).toISOString(), mocked: l.mocked === true } : null,
      });
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
      setSaved(true);
      void refresh();
    } catch (e) {
      Alert.alert('Could not save photo', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const complete = async () => {
    const sm = await (await getServices()).sessions();
    const q = Number(quantity);
    await sm.append(sessionId, 'TaskCompleted', isCleanup && q > 0 ? { taskId, quantity: Math.min(10_000, Math.round(q)) } : { taskId });
    navigation.goBack();
  };

  if (saved) {
    return (
      <Screen title="📷 Saved" pill={false}>
        <Banner tone="ok" text="Saved on device · will upload later" />
        {isCleanup ? <Field label="How many pieces did you collect?" keyboardType="number-pad" value={quantity} onChangeText={setQuantity} placeholder={String(task?.params.quantity ?? 10)} /> : null}
        <Btn title="Mark task done" onPress={complete} />
        <Btn title="Back to challenge" kind="ghost" onPress={() => navigation.goBack()} />
      </Screen>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: '#000' }}>
      {preview ? (
        <Image source={{ uri: preview }} style={{ flex: 1 }} resizeMode="contain" />
      ) : (
        <CameraView ref={cam} style={{ flex: 1 }} facing="back" />
      )}
      <View style={{ position: 'absolute', top: 48, left: space.l, right: space.l, backgroundColor: 'rgba(0,0,0,0.55)', borderRadius: radius.m, padding: space.m }}>
        <Text style={{ color: '#fff', fontSize: font.body, fontWeight: '700' }}>{task?.title}</Text>
        <Text style={{ color: '#fff', fontSize: font.small }}>{task?.evidence[0]?.hint || 'Frame the task clearly'} · Please avoid photographing people.</Text>
      </View>
      <View style={{ padding: space.l, gap: space.s, backgroundColor: t.bg }}>
        {preview ? (
          <Row>
            <Btn title="Retake" kind="secondary" onPress={() => setPreview(null)} style={{ flex: 1 }} />
            <Btn title="Use photo" onPress={use} busy={busy} style={{ flex: 1 }} />
          </Row>
        ) : (
          <Row>
            <Btn title="Cancel" kind="secondary" onPress={() => navigation.goBack()} style={{ flex: 1 }} />
            <Btn title="Capture" icon="📸" onPress={shoot} style={{ flex: 2 }} />
          </Row>
        )}
      </View>
    </View>
  );
}

export function CheckpointScreen({ route, navigation }: NativeStackScreenProps<RootParams, 'Checkpoint'>) {
  const { sessionId, checkpointId } = route.params;
  const { snap } = useLive(sessionId, 60_000);
  const t = useTheme();
  useEffect(() => {
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
  }, []);
  const cp = snap?.compiled.checkpoints.get(checkpointId);
  const unlocked = snap ? [...snap.compiled.tasks.values()].filter((x) => x.location.kind === 'checkpoint' && x.location.ref === checkpointId) : [];
  return (
    <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', padding: space.l }}>
      <View style={{ backgroundColor: t.surface, borderRadius: radius.l, padding: space.xl, gap: space.m }}>
        <T v="h1" center>✅</T>
        <T v="h2" center>{cp?.name ?? 'Checkpoint'} reached</T>
        {unlocked.map((u) => (
          <T key={u.id} center>🔓 {u.title}</T>
        ))}
        {unlocked[0]?.evidence.length ? <Btn title="Do it now" icon="📷" onPress={() => navigation.replace('Camera', { sessionId, taskId: unlocked[0]!.id })} /> : null}
        <Btn title="Continue" kind={unlocked.length ? 'secondary' : 'primary'} onPress={() => navigation.goBack()} />
      </View>
    </View>
  );
}

export function breakdownLines(items: BreakdownItem[]) {
  return items.map((b) => `${b.status === 'awarded' ? '✅' : b.status === 'penalty' ? '➖' : b.status === 'invalidated' ? '⚠️' : '○'} ${b.label}: ${b.points > 0 ? '+' : ''}${b.points}${b.reason ? ` (${b.reason})` : ''}`);
}

export function CompletionScreen({ route, navigation }: NativeStackScreenProps<RootParams, 'Completion'>) {
  const { sessionId } = route.params;
  const [snap, setSnap] = useState<LiveSnapshot | null>(null);
  const [mood, setMood] = useState<number | null>(null);
  const [unlocks, setUnlocks] = useState<LocalMilestone[]>([]);
  const online = useApp((s) => s.online);

  useEffect(() => {
    (async () => {
      await stopRuntime(sessionId);
      const s = await getServices();
      const sm = await s.sessions();
      const sn = await sm.snapshot(sessionId, { weightKg: await getWeightKg() });
      setSnap(sn);
      if (sn.state.quest) await setQuestActive(null);
      try {
        const ms = await s.milestones();
        await announceMilestones(ms).catch(() => undefined);
        setUnlocks(await ms.forSession(sessionId));
      } catch {
        /* milestones never block finishing a session */
      }
      useApp.getState().set({ activeSessionId: null });
      void syncNow();
    })();
  }, [sessionId]);

  if (!snap) return <Screen pill={false}><T muted>Saving…</T></Screen>;
  const w = snap.wellness;
  const abandoned = snap.state.status === 'abandoned';
  return (
    <Screen pill={false}>
      <T v="huge" center>{abandoned ? '🌿' : snap.state.quest ? '🌱' : '🎉'}</T>
      <T v="h1" center>{abandoned ? (snap.state.questStop === 'safety' ? 'Stopped for safety: no points lost' : 'Session ended') : snap.state.quest ? 'Quest complete!' : snap.score.completed ? 'Challenge complete!' : 'Well done!'}</T>
      {snap.state.quest && !abandoned ? <Banner tone="ok" text="Turn the internet back on whenever you like: your quest syncs then." /> : null}
      {unlocks.length ? (
        <Card tone="ok">
          <T v="small" muted>UNLOCKED {online ? '' : 'OFFLINE '}· final check when synced</T>
          {unlocks.map((u) => (
            <Row key={`${u.key}|${u.windowKey}|${u.tier}`} style={{ justifyContent: 'space-between' }}>
              <T v="big" style={{ flex: 1 }}>{tierIcon(u.tier)} {u.title}</T>
              <VerificationBadge label={u.label} />
            </Row>
          ))}
        </Card>
      ) : null}
      <Card tone="info">
        <T v="h2" center>{snap.score.total} pts</T>
        <T center muted>{online ? 'Provisional · verifying now…' : 'Offline · will verify when online'}</T>
      </Card>
      {!abandoned ? (
        <MoodPicker
          label="How do you feel now?"
          value={mood}
          onChange={async (v) => {
            setMood(v);
            const s = await getServices();
            await (await s.sessions()).setMood(sessionId, 'after', v);
            // Mood is not part of the hash chain; it syncs separately and only if the user opted in.
            if ((await s.me())?.shareWellbeing) {
              await s.sync.enqueue('mood', 'PUT', `/v1/sessions/${sessionId}/mood`, { moodAfter: v });
              void syncNow();
            }
          }}
        />
      ) : null}
      <Card>
        <T v="small" muted>WELLNESS (estimates, not medical advice)</T>
        <Row>
          <Stat label="steps" value={w.steps !== null ? String(w.steps) : '–'} />
          <Stat label={w.kcalApprox ? 'kcal (approx.)' : 'kcal (est.)'} value={w.kcalEstimate !== null ? `~${w.kcalEstimate}` : '–'} />
          <Stat label="phone-free min" value={String(w.phoneFreeMinutes)} />
          <Stat label="distance" value={fmtKm(snap.state.distanceM)} />
        </Row>
      </Card>
      <Btn title="See results" onPress={() => navigation.replace('Results', { sessionId })} />
      <Btn title="Home" kind="secondary" onPress={() => navigation.reset({ index: 0, routes: [{ name: 'Tabs' as never }] })} />
    </Screen>
  );
}
