import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import React from 'react';
import { NetworkError, ApiError } from '../src/core/api-client';
import { counts, fakeServices, compiled } from './fakes';

let mockServices = fakeServices();
jest.mock('../src/app/services', () => ({ getServices: async () => mockServices, apiBaseUrl: () => 'http://test' }));

import { LoginScreen, RegisterScreen } from '../src/screens/auth';
import { useApp } from '../src/app/store';
import { syncPill } from '../src/core/sync-status';
import { Btn, MoodPicker, StatusLine, SyncPillView } from '../src/components/ui';
import { RouteMap } from '../src/components/RouteMap';

const nav = (globalThis as any).mockNav;
const props = (name: string) => ({ navigation: nav, route: { key: name, name, params: undefined } }) as any;

beforeEach(() => {
  mockServices = fakeServices();
  jest.clearAllMocks();
  useApp.getState().set({ me: null, online: true, syncing: false, counts, lastReport: null, awaitingVerdict: 0 });
});

describe('LoginScreen', () => {
  it('disables Sign in until both fields are filled', async () => {
    await render(<LoginScreen {...props('Login')} />);
    const button = screen.getByRole('button', { name: 'Sign in' });
    expect(button).toBeDisabled();
    const [email, password] = screen.getAllByDisplayValue('');
    await fireEvent.changeText(email!, 'arjun@trina.dev');
    await fireEvent.changeText(password!, 'touch-grass-2026');
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeEnabled();
  });

  it('explains that the first sign-in needs internet', async () => {
    mockServices.api.login.mockRejectedValue(new NetworkError());
    await render(<LoginScreen {...props('Login')} />);
    const [email, password] = screen.getAllByDisplayValue('');
    await fireEvent.changeText(email!, 'a@b.dev');
    await fireEvent.changeText(password!, 'x');
    await fireEvent.press(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText(/need internet to sign in the first time/)).toBeTruthy();
  });

  it('shows a generic message for wrong credentials and signs in on success', async () => {
    mockServices.api.login.mockRejectedValueOnce(new ApiError(401, { code: 'INVALID_CREDENTIALS' }));
    await render(<LoginScreen {...props('Login')} />);
    const [email, password] = screen.getAllByDisplayValue('');
    await fireEvent.changeText(email!, 'a@b.dev');
    await fireEvent.changeText(password!, 'wrong');
    await fireEvent.press(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('Email or password is incorrect.')).toBeTruthy();

    mockServices.api.login.mockResolvedValueOnce({ user: { id: 'u1', email: 'a@b.dev', displayName: 'Arjun', role: 'user', shareWellbeing: false, createdAt: '' }, accessToken: 'a', refreshToken: 'r', expiresIn: 900 });
    await fireEvent.press(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(useApp.getState().me?.displayName).toBe('Arjun'));
    expect(mockServices.setMe).toHaveBeenCalled();
  });
});

describe('RegisterScreen', () => {
  it('requires the 16+ confirmation and a 10+ char password', async () => {
    await render(<RegisterScreen {...props('Register')} />);
    const [name, email, password] = screen.getAllByDisplayValue('');
    await fireEvent.changeText(name!, 'Meera');
    await fireEvent.changeText(email!, 'meera@trina.dev');
    await fireEvent.changeText(password!, 'short');
    expect(screen.getByText(/Too short/)).toBeTruthy();
    await fireEvent.changeText(password!, 'long enough password');
    expect(screen.getByRole('button', { name: 'Create account' })).toBeDisabled();
    await fireEvent.press(screen.getByRole('button', { name: /I am 16 or older/ }));
    expect(screen.getByRole('button', { name: 'Create account' })).toBeEnabled();
    expect(screen.getByText(/never store your home address/)).toBeTruthy();
  });
});

describe('Sync pill (offline UX copy)', () => {
  it.each([
    [{ online: false }, "You're offline. Your progress is safe on this device."],
    [{ syncing: true, counts: { ...counts, pendingEvents: 12 } }, 'Syncing 12 activities…'],
    [{ counts: { ...counts, failed: 3 } }, "3 items couldn't sync. We'll retry automatically."],
    [{}, 'Everything is synced.'],
  ])('%j → %s', async (patch, text) => {
    useApp.getState().set(patch as never);
    await render(<SyncPillView />);
    expect(screen.getByText(text)).toBeTruthy();
    await fireEvent.press(screen.getByRole('button'));
    expect(nav.navigate).toHaveBeenCalledWith('SyncStatus');
  });

  it('is never colour-only: every state has an icon + text', () => {
    for (const online of [true, false]) {
      const p = syncPill({ online, syncing: false, counts, lastReport: null, awaitingVerdict: 0 });
      expect(p.icon.length).toBeGreaterThan(0);
      expect(p.text.length).toBeGreaterThan(5);
    }
  });
});

describe('UI kit', () => {
  it('MoodPicker toggles a value and exposes accessible labels', async () => {
    const onChange = jest.fn();
    await render(<MoodPicker label="How do you feel?" value={null} onChange={onChange} />);
    await fireEvent.press(screen.getByLabelText('Mood 4 of 5'));
    expect(onChange).toHaveBeenCalledWith(4);
  });

  it('disabled buttons do not fire', async () => {
    const onPress = jest.fn();
    await render(<Btn title="Go" disabled onPress={onPress} />);
    await fireEvent.press(screen.getByRole('button', { name: 'Go' }));
    expect(onPress).not.toHaveBeenCalled();
  });

  it('StatusLine renders icon + label + detail', async () => {
    await render(<StatusLine status="fail" label="GPS signal" detail="±120 m" />);
    expect(screen.getByText('⛔')).toBeTruthy();
    expect(screen.getByText('±120 m')).toBeTruthy();
  });

  it('RouteMap draws the start and every checkpoint offline', async () => {
    await render(<RouteMap def={compiled.definition} reached={{ cp1: true }} />);
    // SVG labels render as TSpan `content` props, not text nodes.
    const tree = JSON.stringify(screen.toJSON());
    const labels = [...tree.matchAll(/"content":"([^"]+)"/g)].map((m) => m[1]);
    expect(labels).toEqual(expect.arrayContaining(['S', '✓', '2', '3', '4']));
  });
});
