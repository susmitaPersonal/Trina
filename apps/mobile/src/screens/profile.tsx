import { useFocusEffect, useNavigation } from '@react-navigation/native';
import { ON_DEVICE_MODELS } from '@trina/ai';
import * as FS from 'expo-file-system/legacy';
import React, { useCallback, useState } from 'react';
import { Alert } from 'react-native';
import { getServices } from '../app/services';
import { refreshSyncState, useApp } from '../app/store';
import { stopRuntime } from '../platform/session-runtime';
import { deviceRamGb, llamaAvailable } from '../platform/llama';
import { getWeightKg, setWeightKg } from '../platform/secure';
import { Banner, Btn, Card, Field, Row, Screen, Stat, StatusLine, T } from '../components/ui';

export function ProfileScreen() {
  const nav = useNavigation<any>();
  const me = useApp((s) => s.me);
  const counts = useApp((s) => s.counts);
  const [weight, setWeight] = useState('');
  const [totals, setTotals] = useState<Record<string, number> | null>(null);
  const [period, setPeriod] = useState<'week' | 'month'>('week');

  useFocusEffect(
    useCallback(() => {
      (async () => {
        const w = await getWeightKg();
        setWeight(w ? String(w) : '');
        try {
          setTotals((await (await getServices()).api.wellness(period)).totals);
        } catch {
          setTotals(null);
        }
      })();
    }, [period]),
  );

  const toggleShare = async () => {
    const s = await getServices();
    const next = !me?.shareWellbeing;
    try {
      await s.api.patchMe({ shareWellbeing: next });
    } catch {
      await s.sync.enqueue('profile', 'PATCH', '/v1/me', { shareWellbeing: next });
    }
    const updated = { ...me!, shareWellbeing: next };
    await s.setMe(updated);
    useApp.getState().set({ me: updated });
  };

  const logout = async () => {
    const pending = counts.pendingEvents + counts.pendingPhotos + counts.pendingOutbox;
    const doIt = async () => {
      const s = await getServices();
      await stopRuntime();
      await s.api.logout();
      await s.setMe(null);
      useApp.getState().set({ me: null });
    };
    if (pending > 0) {
      Alert.alert('Unsynced data', `You have ${pending} unsynced items. They stay on this phone and sync after you sign in again as the same user.`, [
        { text: 'Sync first', onPress: () => nav.navigate('SyncStatus') },
        { text: 'Sign out anyway', style: 'destructive', onPress: doIt },
      ]);
    } else await doIt();
  };

  return (
    <Screen title={`🙂 ${me?.displayName ?? ''}`}>
      <Row>
        <Btn title="Status" icon="🏅" kind="secondary" onPress={() => nav.navigate('Status')} style={{ flex: 1 }} />
        <Btn title="Milestones" icon="📜" kind="secondary" onPress={() => nav.navigate('MilestoneHistory')} style={{ flex: 1 }} />
        <Btn title="Guilds" icon="🛡" kind="secondary" onPress={() => nav.navigate('Guilds')} style={{ flex: 1 }} />
      </Row>
      <Card>
        <Row>
          <T v="big" style={{ flex: 1 }}>Wellness</T>
          <Btn title={period === 'week' ? 'This week' : 'This month'} kind="ghost" onPress={() => setPeriod(period === 'week' ? 'month' : 'week')} />
        </Row>
        {totals ? (
          <Row>
            <Stat label="steps" value={String(totals.steps ?? 0)} />
            <Stat label="active min" value={String(totals.activeMinutes ?? 0)} />
            <Stat label="phone-free min" value={String(totals.phoneFreeMinutes ?? 0)} />
            <Stat label="kcal (est.)" value={`~${totals.kcalEstimate ?? 0}`} />
          </Row>
        ) : (
          <T muted>Totals load when online.</T>
        )}
        <T v="small" muted>Estimates, not medical advice. Trina is not a medical or mental-health app.</T>
      </Card>
      <Card>
        <T v="big">Privacy & wellbeing</T>
        <Field label="Weight in kg (optional, stays on this phone, used for calorie estimates)" keyboardType="number-pad" value={weight} onChangeText={setWeight} onEndEditing={() => void setWeightKg(weight ? Number(weight) : null)} />
        <Btn kind="secondary" title={`${me?.shareWellbeing ? '☑' : '☐'} Share mood check-ins with Trina`} onPress={toggleShare} />
        <T v="small" muted>Off by default. Organisers only ever see averages from 5+ people.</T>
      </Card>
      <Btn title="AI model (on-device)" icon="🤖" kind="secondary" onPress={() => nav.navigate('AIModel')} />
      <Btn title="Challenge history" icon="📜" kind="secondary" onPress={() => nav.navigate('History')} />
      <Btn title="Sync status" icon="🔄" kind="secondary" onPress={() => nav.navigate('SyncStatus')} />
      <Btn title="Sign out" kind="ghost" onPress={logout} />
    </Screen>
  );
}

export function AIModelScreen() {
  const [installed, setInstalled] = useState<{ id: string; bytes: number; status: string } | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [url, setUrl] = useState('');
  const ram = deviceRamGb();
  const native = llamaAvailable();

  const load = useCallback(async () => {
    const s = await getServices();
    setInstalled(await s.db.get('SELECT id, bytes, status FROM ai_models LIMIT 1'));
  }, []);
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const download = async (m: (typeof ON_DEVICE_MODELS)[number], url: string) => {
    setError(null);
    const s = await getServices();
    const dir = `${FS.documentDirectory}models/`;
    await FS.makeDirectoryAsync(dir, { intermediates: true }).catch(() => undefined);
    const target = `${dir}${m.id}.gguf`;
    const task = FS.createDownloadResumable(url, target, {}, (p) => setProgress(p.totalBytesWritten / Math.max(1, p.totalBytesExpectedToWrite)));
    try {
      const r = await task.downloadAsync();
      if (!r) throw new Error('Download cancelled');
      const info = await FS.getInfoAsync(target);
      await s.db.run('INSERT OR REPLACE INTO ai_models (id, file_uri, sha256, bytes, status) VALUES (?, ?, ?, ?, ?)', [m.id, target, m.sha256, info.exists ? info.size : 0, 'ready']);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setProgress(null);
      await refreshSyncState();
    }
  };

  return (
    <Screen title="🤖 On-device AI" back>
      <T>Run an open-weight model directly on this phone so the AI Challenge Builder works in airplane mode. Optional: without it, Trina uses our self-hosted open model or the built-in rule-based builder.</T>
      <Card>
        <StatusLine status={native ? 'pass' : 'warn'} label="llama.cpp runtime in this build" detail={native ? undefined : 'Not included in this build (see apps/mobile/README.md)'} />
        <StatusLine status={ram >= 6 ? 'pass' : ram >= 4 ? 'warn' : 'fail'} label={`Device memory: ${ram.toFixed(1)} GB`} />
        {installed ? <StatusLine status="pass" label={`Installed: ${installed.id}`} detail={`${(installed.bytes / 1e9).toFixed(2)} GB`} /> : null}
      </Card>
      {ON_DEVICE_MODELS.map((m) => (
        <Card key={m.id}>
          <T v="big">{m.family} · {m.id}</T>
          <T muted>{(m.bytes / 1e9).toFixed(1)} GB · {m.quant} · needs {m.minRamGb} GB RAM · {m.license}</T>
          <T v="small" muted>Get the {m.quant} .gguf link from {m.url}</T>
          <Btn
            title="Download (Wi-Fi recommended)"
            kind="secondary"
            disabled={!native || ram < m.minRamGb - 0.5 || progress !== null || !url.endsWith('.gguf')}
            onPress={() => void download(m, url)}
          />
        </Card>
      ))}
      <Field label="Direct .gguf URL" autoCapitalize="none" value={url} onChangeText={setUrl} placeholder="https://…/model-Q4_K_M.gguf" />
      {progress !== null ? <Banner tone="info" text={`Downloading… ${Math.round(progress * 100)}%`} /> : null}
      {error ? <Banner tone="warn" text={error} /> : null}
      {installed ? (
        <Btn
          title="Delete model"
          kind="ghost"
          onPress={async () => {
            const s = await getServices();
            const r = await s.db.get<{ file_uri: string }>('SELECT file_uri FROM ai_models LIMIT 1');
            if (r) await FS.deleteAsync(r.file_uri, { idempotent: true });
            await s.db.run('DELETE FROM ai_models');
            await load();
          }}
        />
      ) : null}
    </Screen>
  );
}
