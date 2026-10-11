import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { decodeQr, isTrinaQr, type ConfirmationClaim } from '@trina/contracts';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Haptics from 'expo-haptics';
import React, { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import type { LiveSnapshot } from '../core/session-manager';
import type { RootParams } from '../app/navigation';
import { getServices } from '../app/services';
import { QrCode } from '../components/progress';
import { space } from '../components/theme';
import { Banner, Btn, Card, Row, Screen, T } from '../components/ui';

/** What can be confirmed in this session: confirmable counters (value > 0) and confirmation tasks. */
export function confirmableClaims(snap: LiveSnapshot): Array<{ claim: ConfirmationClaim; label: string }> {
  const out: Array<{ claim: ConfirmationClaim; label: string }> = [];
  for (const m of snap.compiled.modules) {
    for (const c of m.counters ?? []) {
      if (c.verification === 'self_report') continue;
      const ref = `${m.id}.${c.id}`;
      const v = Math.min(c.maxPerSession, snap.state.counters[ref] ?? 0) - (snap.state.confirmed[ref] ?? 0);
      if (v > 0) out.push({ claim: { kind: 'counter', ref, value: v }, label: c.label });
    }
    for (const tt of m.taskTypes) {
      if (tt.completion !== 'confirmation') continue;
      for (const t of snap.compiled.tasks.values()) {
        if (t.type === `${m.id}.${tt.id}` && snap.state.tasks[t.id]?.status !== 'done') out.push({ claim: { kind: 'task', ref: t.id, value: 1 }, label: t.title ?? tt.displayName });
      }
    }
  }
  return out;
}

/** Scans one code at a time. `onCode` resolves false when the code was refused: scanning resumes, ignoring that same code. */
function Scanner({ onCode, label }: { onCode: (text: string) => Promise<boolean>; label: string }) {
  const [perm, ask] = useCameraPermissions();
  const busy = useRef(false);
  const refused = useRef<string | null>(null);
  if (!perm) return <T muted>…</T>;
  if (!perm.granted) return <Btn title="Allow camera to scan" onPress={ask} />;
  return (
    <View style={{ height: 280, borderRadius: 16, overflow: 'hidden' }}>
      <CameraView
        style={{ flex: 1 }}
        facing="back"
        barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
        onBarcodeScanned={({ data }) => {
          if (busy.current || data === refused.current || !isTrinaQr(data)) return;
          busy.current = true;
          void onCode(data).then((ok) => {
            if (ok) return;
            refused.current = data;
            busy.current = false;
          });
        }}
      />
      <T v="small" muted center>{label}</T>
    </View>
  );
}

/**
 * The offline confirmation handshake (ADR-026). "ask": show my claims as QR-A, then scan their
 * signed QR-B. "scan": scan their QR-A, lower anything that's too high, sign, and show QR-B.
 * No internet needed; values can only go down, never up.
 */
export function ConfirmScreen({ route, navigation }: NativeStackScreenProps<RootParams, 'Confirm'>) {
  const { sessionId, mode } = route.params;
  const [snap, setSnap] = useState<LiveSnapshot | null>(null);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [qr, setQr] = useState<string | null>(null);
  const [step, setStep] = useState<'pick' | 'show' | 'scan' | 'review' | 'done'>(mode === 'ask' ? 'pick' : 'scan');
  const [incoming, setIncoming] = useState<{ text: string; claims: ConfirmationClaim[]; name: string } | null>(null);
  const [lowered, setLowered] = useState<Record<string, number>>({});
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    void (async () => setSnap(await (await (await getServices()).sessions()).snapshot(sessionId)))();
  }, [sessionId]);

  if (!snap) return <Screen title="Confirm" pill={false}><T muted>Loading…</T></Screen>;
  const claims = confirmableClaims(snap);
  // Counters you tapped are pre-selected; tasks (e.g. "Kept the score") are opt-in so nobody asks by accident.
  const isOn = (c: ConfirmationClaim) => selected[c.ref] ?? c.kind === 'counter';
  const fail = (e: unknown) => setMsg((e as Error).message);

  const showRequest = async () => {
    try {
      const c = await (await getServices()).confirmations();
      const chosen = claims.filter((x) => isOn(x.claim)).map((x) => x.claim);
      setQr(await c.request(sessionId, chosen));
      setStep('show');
    } catch (e) {
      fail(e);
    }
  };

  const received = async (text: string): Promise<boolean> => {
    try {
      const c = await (await getServices()).confirmations();
      const r = await c.accept(text, sessionId, snap.challenge.bundle.participantKeys ?? []);
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
      setMsg(`Confirmed by ${r.issuerName}${r.keyChecked ? '' : ' (their key is checked by the server after sync)'}. It counts once the server matches both phones.`);
      setStep('done');
      return true;
    } catch (e) {
      fail(e);
      return false;
    }
  };

  const scannedRequest = async (text: string): Promise<boolean> => {
    try {
      const req = decodeQr(text);
      if (req.t !== 'req') throw new Error('That is not a confirmation request');
      setIncoming({ text, claims: req.claims, name: req.subjectName });
      setLowered(Object.fromEntries(req.claims.map((c) => [c.ref, c.value])));
      setMsg(null);
      setStep('review');
      return true;
    } catch (e) {
      fail(e);
      return false;
    }
  };

  const approve = async () => {
    if (!incoming) return;
    try {
      const c = await (await getServices()).confirmations();
      const approved = incoming.claims.map((x) => ({ ...x, value: lowered[x.ref] ?? x.value })).filter((x) => x.value > 0);
      const out = await c.approve(incoming.text, sessionId, { approved });
      setQr(out.qr);
      setStep('show');
    } catch (e) {
      fail(e);
    }
  };

  return (
    <Screen title={mode === 'ask' ? 'Ask to confirm' : 'Confirm a friend'} pill={false}>
      {msg ? <Banner tone={step === 'done' ? 'ok' : 'warn'} text={msg} /> : null}
      {step === 'pick' ? (
        <>
          <T>Pick what a teammate saw. They scan your code, check it, and show you theirs.</T>
          {!claims.length ? <Banner tone="info" text="Nothing to confirm yet: count things with the + buttons first." /> : null}
          {claims.map((x) => (
            <Card key={x.claim.ref} onPress={() => setSelected({ ...selected, [x.claim.ref]: !isOn(x.claim) })}>
              <T v="big">{isOn(x.claim) ? '✅' : '○'} {x.label}{x.claim.kind === 'counter' ? `: ${x.claim.value}` : ''}</T>
            </Card>
          ))}
          <Btn title="Show my code" disabled={!claims.some((x) => isOn(x.claim))} onPress={showRequest} />
        </>
      ) : null}
      {step === 'show' && qr ? (
        <>
          <QrCode value={qr} />
          <T center>{mode === 'ask' ? 'Let your teammate scan this.' : 'Let them scan this to finish.'}</T>
          {mode === 'ask' ? <Btn title="Scan their answer" onPress={() => setStep('scan')} /> : <Btn title="Done" onPress={() => navigation.goBack()} />}
        </>
      ) : null}
      {step === 'scan' ? <Scanner label={mode === 'ask' ? "Scan your teammate's signed code" : "Scan your teammate's request"} onCode={mode === 'ask' ? received : scannedRequest} /> : null}
      {step === 'review' && incoming ? (
        <>
          <T v="big">{incoming.name} asks you to confirm:</T>
          {incoming.claims.map((x) => (
            <Card key={x.ref}>
              <Row style={{ justifyContent: 'space-between' }}>
                <T style={{ flex: 1 }}>{x.ref.split('.').pop()!.replace(/_/g, ' ')}: {lowered[x.ref]}</T>
                <Btn title="−" kind="secondary" onPress={() => setLowered({ ...lowered, [x.ref]: Math.max(0, (lowered[x.ref] ?? x.value) - 1) })} />
              </Row>
            </Card>
          ))}
          <T v="small" muted>Only confirm what you saw. You can lower numbers, not raise them.</T>
          <Btn title="Confirm and sign" onPress={approve} />
        </>
      ) : null}
      {step === 'done' ? <Btn title="Back to the game" onPress={() => navigation.goBack()} /> : null}
      <View style={{ height: space.l }} />
    </Screen>
  );
}
