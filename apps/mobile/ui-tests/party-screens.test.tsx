/**
 * UI tests for the Offline Party screens (Jest + jest-expo + Testing Library). Real contracts and engine:
 * invites are really signed and encoded, the camera "scans" real QR strings, check words are computed
 * from the real rebuilt definition. Only storage-bound PartyService calls are fakes.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import React from 'react';
import { encodePartyQr, generateDeviceKeyPair, newNonce, signParty, uuidv7, type PartySpec } from '@trina/contracts';
import { counts, fakeServices } from './fakes';

let mockServices: any = fakeServices();
let mockOnline = true;
let mockScan: string | null = null;
jest.mock('../src/app/services', () => ({ getServices: async () => mockServices, apiBaseUrl: () => 'http://test' }));
jest.mock('../src/app/ai-service', () => ({
  // The real rule-based theme picker (no device model in tests).
  partyTheme: jest.fn(async (text: string, templateId: any) => ({ ...jest.requireActual('@trina/ai').templateTheme(text, templateId), provider: 'template' })),
}));
jest.mock('@react-native-community/netinfo', () => ({
  addEventListener: jest.fn(() => () => undefined),
  fetch: jest.fn(async () => ({ isConnected: mockOnline, isInternetReachable: mockOnline, type: mockOnline ? 'cellular' : 'none' })),
}));
jest.mock('expo-location', () => ({
  Accuracy: { BestForNavigation: 6 },
  getForegroundPermissionsAsync: jest.fn(async () => ({ granted: true, status: 'granted' })),
  watchPositionAsync: jest.fn(async (_o: unknown, cb: (l: unknown) => void) => {
    cb({ coords: { latitude: 22.5115, longitude: 88.35, accuracy: 7 }, timestamp: Date.now(), mocked: false });
    return { remove: jest.fn() };
  }),
}));
jest.mock('expo-camera', () => {
  const R = jest.requireActual('react');
  return {
    useCameraPermissions: () => [{ granted: true }, jest.fn()],
    CameraView: (p: { onBarcodeScanned?: (e: { data: string }) => void }) => {
      R.useEffect(() => {
        if (mockScan && p.onBarcodeScanned) for (const f of mockScan.split('\n')) p.onBarcodeScanned({ data: f });
      }, []);
      return null;
    },
  };
});

import { useApp } from '../src/app/store';
import { PartyService } from '../src/core/party';
import { PartyHostScreen, PartyJoinScreen, PartyPlayScreen, PartyScreen } from '../src/screens/party';
import { QuestStartScreen } from '../src/screens/quests';

const nav = (globalThis as any).mockNav;
const props = (name: string, params: Record<string, unknown> = {}) => ({ navigation: nav, route: { key: name, name, params } }) as any;

const hostKeys = generateDeviceKeyPair();
const memKeys = (k = hostKeys) => ({ get: async () => k, set: async () => undefined });
/** Real invite/preview logic (pure); storage-bound calls are fakes. */
function partyFake(ids = { userId: 'u1', deviceId: 'd1', displayName: 'Arjun' }) {
  const real = new PartyService(null as never, null as never, memKeys(), { ...ids, userId: uuidv7(), deviceId: uuidv7() }, () => Date.parse('2026-10-12T07:00:00Z'));
  return {
    real,
    createInvite: jest.fn((a: Parameters<PartyService['createInvite']>[0]) => real.createInvite(a)),
    preview: jest.fn((p: Parameters<PartyService['preview']>[0]) => real.preview(p)),
    start: jest.fn(async () => 'party-session-1'),
    offer: jest.fn(async () => ['TRINAP1:1/1:AAAA']),
    scan: jest.fn(async () => ({ kind: 'answer', frames: ['TRINAP1:1/1:BBBB'], peerName: 'Mia' })),
    shareFrames: jest.fn(async () => ['TRINAP1:1/2:AAAA', 'TRINAP1:2/2:BBBB']),
    progress: jest.fn(async () => ({
      title: 'Litter Hunters · 30 min', checkWords: ['tiger', 'mango', 'river', 'star'], members: 3, total: 27, target: 24, reached: true, membersDone: 3, label: 'litter items',
      perMember: [{ userId: 'a', name: 'Mia', goalValue: 9, done: true }, { userId: 'b', name: 'Arif', goalValue: 8, done: true }, { userId: 'c', name: 'Sara', goalValue: 10, done: true }],
    })),
    sightings: jest.fn(async () => [{ name: 'Mia', kind: 'join', at: '2026-10-12T07:01:00Z' }]),
  };
}

const SPEC: PartySpec = { v: 1, templateId: 'party_cleanup_v1', targetMinutes: 30, levelTier: 'easy', themeId: 'litter_hunters' };

beforeEach(() => {
  nav.navigate.mockClear(); nav.replace.mockClear();
  mockOnline = true;
  mockScan = null;
  mockServices = fakeServices();
  mockServices.party = jest.fn(async () => mockServices.pf);
  mockServices.pf = partyFake();
  useApp.getState().set({ me: { userId: 'u1', email: 'a@b.dev', displayName: 'Arjun', role: 'user', shareWellbeing: false }, online: true, syncing: false, counts, lastReport: null, awaitingVerdict: 0 });
});

describe('Party hub', () => {
  it('offers host and join', async () => {
    await render(<PartyScreen {...props('Party')} />);
    await fireEvent.press(screen.getByRole('button', { name: /Host a party/ }));
    await fireEvent.press(screen.getByRole('button', { name: /Join a party/ }));
    expect(nav.navigate).toHaveBeenCalledWith('PartyHost');
    expect(nav.navigate).toHaveBeenCalledWith('PartyJoin');
    expect(screen.getByText(/never score or rank/)).toBeTruthy();
  });
});

describe('Host a party', () => {
  it('rank E caps the length at 45 min; creates a signed invite with check words; Start needs the phone offline', async () => {
    await render(<PartyHostScreen {...props('PartyHost')} />);
    expect(await screen.findByText(/GPS ready/)).toBeTruthy();
    // Online: the party signing key is registered BEFORE the phone goes offline (fresh sign-ups had none).
    await waitFor(() => expect(mockServices.ensureDeviceKey).toHaveBeenCalled());
    expect(screen.queryByText('60 min')).toBeNull();
    expect(screen.getByText('45 min')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: /Create invite/ }));
    expect(await screen.findByLabelText('Party invite QR code')).toBeTruthy();
    const created = await mockServices.pf.createInvite.mock.results[0].value;
    expect(created.invite.body.spec).toMatchObject({ templateId: 'party_cleanup_v1', targetMinutes: 30, themeId: 'litter_hunters' });
    expect(screen.getByText(created.preview.checkWords.join(' · '))).toBeTruthy();
    const start = await screen.findByRole('button', { name: /Turn the internet off to start/ });
    expect(start.props.accessibilityState.disabled).toBe(true);
  });

  it('a vibe becomes a theme NAME only (rules/AI); numbers still come from the mission + length', async () => {
    await render(<PartyHostScreen {...props('PartyHost')} />);
    await screen.findByText(/GPS ready/);
    await fireEvent.changeText(screen.getByPlaceholderText('e.g. sunrise by the lake'), 'sunrise walk, then tea');
    await fireEvent.press(screen.getByRole('button', { name: /Create invite/ }));
    await screen.findByLabelText('Party invite QR code');
    const created = await mockServices.pf.createInvite.mock.results[0].value;
    expect(created.invite.body.spec).toEqual({ v: 1, templateId: 'party_cleanup_v1', targetMinutes: 30, levelTier: 'easy', themeId: 'sunrise_squad' });
    expect(screen.getByText(/Sunrise Squad · 30 min/)).toBeTruthy();
  });

  it('offline: starts the party, arms the QuestGuard and opens the party screen', async () => {
    mockOnline = false;
    await render(<PartyHostScreen {...props('PartyHost')} />);
    await screen.findByText(/GPS ready/);
    await fireEvent.press(screen.getByRole('button', { name: /Create invite/ }));
    const go = await screen.findByRole('button', { name: /Start the party/ });
    await waitFor(() => expect(go.props.accessibilityState.disabled).toBe(false));
    await fireEvent.press(go);
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith('PartyPlay', { sessionId: 'party-session-1' }));
    expect(mockServices.pf.start).toHaveBeenCalledWith(expect.objectContaining({ online: false }));
    expect(mockServices.quest).toMatchObject({ active: true, sessionId: 'party-session-1' });
  });
});

describe('Join a party', () => {
  it('scans a real invite, shows the host, goal and the SAME check words, then joins offline', async () => {
    mockOnline = false;
    const host = partyFake({ userId: 'h', deviceId: 'hd', displayName: 'Mia' });
    const created = await host.real.createInvite({ spec: SPEC, startFix: { lat: 22.5115, lng: 88.35, acc: 5, ts: '2026-10-12T07:00:00Z' } });
    mockScan = created.frames.join('\n');
    await render(<PartyJoinScreen {...props('PartyJoin')} />);
    expect(await screen.findByText(/Host: Mia · 30 min · together: 5 litter items each/)).toBeTruthy();
    expect(screen.getByText(created.preview.checkWords.join(' · '))).toBeTruthy();
    const join = await screen.findByRole('button', { name: /Join and start/ });
    await waitFor(() => expect(join.props.accessibilityState.disabled).toBe(false));
    await fireEvent.press(join);
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith('PartyPlay', { sessionId: 'party-session-1', meetFirst: true }));
  });

  it('a forged invite is refused with a clear message', async () => {
    const host = partyFake({ userId: 'h', deviceId: 'hd', displayName: 'Mia' });
    const { invite } = await host.real.createInvite({ spec: SPEC, startFix: { lat: 22.5115, lng: 88.35, acc: 5, ts: '2026-10-12T07:00:00Z' } });
    const forged = { ...invite, body: { ...invite.body, spec: { ...invite.body.spec, targetMinutes: 90 as const } } };
    mockScan = encodePartyQr(forged).join('\n');
    await render(<PartyJoinScreen {...props('PartyJoin')} />);
    expect(await screen.findByText(/can't be verified/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Join and start/ })).toBeNull();
  });
});

describe('In the party', () => {
  it('shows the shared goal per player, the meeting code, and progress sharing (multi-frame)', async () => {
    await render(<PartyPlayScreen {...props('PartyPlay', { sessionId: 'party-session-1', meetFirst: true })} />);
    expect(await screen.findByText('🎉 Goal reached!')).toBeTruthy();
    expect(screen.getByText(/27 \/ 24 litter items · 3 players/)).toBeTruthy();
    expect(screen.getByText('Sara: 10 ✓')).toBeTruthy();
    expect(screen.getByText(/Now meet the host/)).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: /Show my code/ }));
    expect(await screen.findByLabelText('Your meeting code')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: /Done/ }));
    await fireEvent.press(await screen.findByRole('button', { name: /Share progress/ }));
    expect(await screen.findByText(/Part 1 of 2/)).toBeTruthy();
  });

  it("scanning a teammate's code records the meeting and shows the answer code back", async () => {
    const k = generateDeviceKeyPair();
    const body = { partyId: uuidv7(), userId: uuidv7(), deviceId: uuidv7(), sessionId: uuidv7(), name: 'Mia', publicKey: k.publicKeyHex, seq: 3, chainHead: 'a'.repeat(64), nonce: newNonce(), replyTo: null };
    mockScan = encodePartyQr({ t: 'psig', body, sig: signParty('sighting', body, k.secretKeyHex) }).join('\n');
    await render(<PartyPlayScreen {...props('PartyPlay', { sessionId: 'party-session-1' })} />);
    await fireEvent.press(await screen.findByRole('button', { name: /^📷 Scan$|Scan/ }));
    expect(await screen.findByText(/Met Mia\. Show them this code/)).toBeTruthy();
    expect(screen.getByLabelText('Your answer code')).toBeTruthy();
    expect(mockServices.pf.scan).toHaveBeenCalledWith('party-session-1', expect.objectContaining({ t: 'psig' }), 'checkpoint');
  });

  it('a refused code shows why and keeps the scanner open', async () => {
    mockServices.pf.scan = jest.fn(async () => {
      throw new Error('That player is in another party');
    });
    const k = generateDeviceKeyPair();
    const body = { partyId: uuidv7(), userId: uuidv7(), deviceId: uuidv7(), sessionId: uuidv7(), name: 'X', publicKey: k.publicKeyHex, seq: 1, chainHead: 'a'.repeat(64), nonce: newNonce(), replyTo: null };
    mockScan = encodePartyQr({ t: 'psig', body, sig: signParty('sighting', body, k.secretKeyHex) }).join('\n');
    await render(<PartyPlayScreen {...props('PartyPlay', { sessionId: 'party-session-1' })} />);
    await fireEvent.press(await screen.findByRole('button', { name: /Scan/ }));
    expect(await screen.findByText('That player is in another party')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Cancel/ })).toBeTruthy();
  });
});

describe('Adaptive quest length (ADR-032)', () => {
  it('offers only lengths up to the rank cap, preselecting the suggested one', async () => {
    await render(<QuestStartScreen {...props('QuestStart', { targetMinutes: 45, maxMinutes: 45 })} />);
    expect(await screen.findByText(/45-minute offline quest/)).toBeTruthy();
    expect(screen.getByText('30 min')).toBeTruthy();
    expect(screen.queryByText('60 min')).toBeNull();
    expect(screen.queryByText('90 min')).toBeNull();
  });
});
