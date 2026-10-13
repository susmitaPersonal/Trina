import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import React, { useState } from 'react';
import type { AuthResponse } from '@trina/contracts';
import { ApiError, NetworkError } from '../core/api-client';
import type { RootParams } from '../app/navigation';
import { getServices } from '../app/services';
import { syncNow, useApp } from '../app/store';
import { Banner, Btn, Card, Field, Screen, T } from '../components/ui';

export function authErrorText(e: unknown): string {
  if (e instanceof NetworkError) return 'You need internet to sign in the first time. After that, Trina works offline.';
  if (e instanceof ApiError) {
    if (e.code === 'INVALID_CREDENTIALS') return 'Email or password is incorrect.';
    if (e.code === 'EMAIL_TAKEN') return 'An account with this email already exists. Try signing in.';
    if (e.code === 'RATE_LIMITED') return 'Too many attempts. Please wait a minute.';
    if (e.problem.errors?.length) return e.problem.errors.map((x) => x.message).join('\n');
    return e.message;
  }
  return 'Something went wrong. Please try again.';
}

async function onSignedIn(auth: AuthResponse) {
  const s = await getServices();
  const me = { userId: auth.user.id, email: auth.user.email, displayName: auth.user.displayName, role: auth.user.role, shareWellbeing: auth.user.shareWellbeing };
  // A different user signing in must never upload the previous user's queued data under their account.
  const prev = await s.store.getMeta('last_user_id');
  if (prev && prev !== me.userId) {
    await s.store.setMeta('quarantined_user_id', prev);
    await s.store.setMeta('device_key_registered', '0'); // the new account registers this phone's key too
  }
  await s.store.setMeta('last_user_id', me.userId);
  await s.setMe(me);
  useApp.getState().set({ me });
  void syncNow();
  // Signing key for confirmations and offline parties: register it now, while online (not only on the next app start).
  void s.ensureDeviceKey();
}

export function LoginScreen({ navigation }: NativeStackScreenProps<RootParams, 'Login'>) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const s = await getServices();
      await onSignedIn(await s.api.login({ email: email.trim(), password }));
    } catch (e) {
      setError(authErrorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Screen pill={false}>
      <T v="huge">🌱</T>
      <T v="h1">Trina</T>
      <T muted>তৃণ means grass. Use the phone for two minutes, spend sixty outside.</T>
      <Field label="Email" autoCapitalize="none" keyboardType="email-address" autoComplete="email" value={email} onChangeText={setEmail} />
      <Field label="Password" secureTextEntry autoComplete="password" value={password} onChangeText={setPassword} />
      {error ? <Banner tone="warn" text={error} /> : null}
      <Btn title="Sign in" onPress={submit} busy={busy} disabled={!email || !password} />
      <Btn title="Create an account" kind="ghost" onPress={() => navigation.navigate('Register')} />
    </Screen>
  );
}

export function RegisterScreen({ navigation }: NativeStackScreenProps<RootParams, 'Register'>) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [age, setAge] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const strength = password.length >= 14 ? 'Strong' : password.length >= 10 ? 'OK' : 'Too short (min 10)';
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const s = await getServices();
      await onSignedIn(await s.api.register({ email: email.trim(), password, displayName: name.trim() }));
    } catch (e) {
      setError(authErrorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Screen title="Create account" pill={false} back>
      <Field label="Display name" value={name} onChangeText={setName} autoComplete="name" />
      <Field label="Email" autoCapitalize="none" keyboardType="email-address" value={email} onChangeText={setEmail} />
      <Field label={`Password · ${strength}`} secureTextEntry value={password} onChangeText={setPassword} />
      <Card tone="info">
        <T v="small">🔒 Privacy: we never store your home address. Location is recorded only during a challenge, starting at its public start zone. Raw GPS is deleted after 30 days.</T>
      </Card>
      <Btn title={age ? '☑ I am 16 or older' : '☐ I am 16 or older'} kind="secondary" onPress={() => setAge(!age)} />
      {error ? <Banner tone="warn" text={error} /> : null}
      <Btn title="Create account" onPress={submit} busy={busy} disabled={!age || name.trim().length < 2 || password.length < 10 || !email.includes('@')} />
      <Btn title="I already have an account" kind="ghost" onPress={() => navigation.goBack()} />
    </Screen>
  );
}
