import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import React from 'react';
import { compileOrThrow } from '@trina/engine';
import { greenSprintDefinition } from '@trina/engine/fixtures';
import { NetworkError } from '../src/core/api-client';
import { CHALLENGE_ID, P, counts, fakeServices, midRunSnapshot, storedChallenge } from './fakes';

let mockServices = fakeServices();
let mockFix = { coords: { latitude: P.start[1], longitude: P.start[0], accuracy: 8 }, timestamp: Date.now(), mocked: false };
let mockLocationGranted = true;
jest.mock('../src/app/services', () => ({ getServices: async () => mockServices, apiBaseUrl: () => 'http://test' }));
jest.mock('../src/app/ai-service', () => ({
  draftChallenge: jest.fn(),
  adjustDraft: jest.fn((v, dir) => ({ ...v, intent: { ...v.intent, difficulty: dir === 'easier' ? 'easy' : 'hard' } })),
  placeDraft: jest.fn((v) => v),
  releaseDeviceModel: jest.fn(),
  recapFor: jest.fn(async () => 'You walked 4,212 steps 🌱'),
}));
jest.mock('expo-location', () => ({
  Accuracy: { Low: 1, Balanced: 3, High: 4, BestForNavigation: 6 },
  getForegroundPermissionsAsync: jest.fn(async () => ({ granted: mockLocationGranted, status: mockLocationGranted ? 'granted' : 'denied' })),
  requestForegroundPermissionsAsync: jest.fn(async () => ({ granted: true, status: 'granted' })),
  getCurrentPositionAsync: jest.fn(async () => mockFix),
  getLastKnownPositionAsync: jest.fn(async () => mockFix),
  watchPositionAsync: jest.fn(async (_o: unknown, cb: (l: unknown) => void) => {
    cb(mockFix);
    return { remove: jest.fn() };
  }),
}));
jest.mock('expo-camera', () => ({
  Camera: { getCameraPermissionsAsync: jest.fn(async () => ({ granted: true, status: 'granted' })), requestCameraPermissionsAsync: jest.fn() },
  CameraView: () => null,
  useCameraPermissions: () => [{ granted: true }, jest.fn()],
}));
jest.mock('expo-sensors', () => ({ Pedometer: { isAvailableAsync: jest.fn(async () => true), getPermissionsAsync: jest.fn(async () => ({ granted: false, status: 'denied' })), requestPermissionsAsync: jest.fn() } }));
jest.mock('expo-battery', () => ({ getBatteryLevelAsync: jest.fn(async () => 0.15) }));

import { draftChallenge } from '../src/app/ai-service';
import { useApp } from '../src/app/store';
import { AIBuilderScreen, CustomizeScreen } from '../src/screens/create';
import { DetailsScreen, JoinScreen, LeaderboardScreen } from '../src/screens/challenge';
import { HomeScreen } from '../src/screens/home';
import { PreflightScreen, StartScreen } from '../src/screens/prepare';
import { HistoryScreen, ResultsScreen, SyncStatusScreen } from '../src/screens/results';
import { ProfileScreen } from '../src/screens/profile';

const nav = (globalThis as any).mockNav;
const props = (name: string, params: Record<string, unknown> = {}) => ({ navigation: nav, route: { key: name, name, params } }) as any;
const def = compileOrThrow(greenSprintDefinition()).definition;

beforeEach(() => {
  mockServices = fakeServices();
  mockFix = { coords: { latitude: P.start[1], longitude: P.start[0], accuracy: 8 }, timestamp: Date.now(), mocked: false };
  mockLocationGranted = true;
  jest.clearAllMocks();
  useApp.getState().set({ me: { userId: 'u1', email: 'a@b.dev', displayName: 'Arjun Das', role: 'user', shareWellbeing: true }, online: true, syncing: false, counts, lastReport: null, awaitingVerdict: 0 });
});

describe('Home', () => {
  it('greets, shows the next offline-ready challenge and real impact numbers', async () => {
    await render(<HomeScreen />);
    expect(await screen.findByText('Hi Arjun 🌱')).toBeTruthy();
    expect(screen.getByText(/Ready offline/)).toBeTruthy();
    expect(screen.getByText('Green Sprint 60')).toBeTruthy();
    expect(await screen.findByText('4')).toBeTruthy(); // trees watered
    expect(screen.getByText('4.4')).toBeTruthy(); // km outside
    await fireEvent.press(screen.getByRole('button', { name: 'Prepare to start' }));
    expect(nav.navigate).toHaveBeenCalledWith('Preflight', { challengeId: CHALLENGE_ID, version: 1 });
  });
});

describe('AI Builder', () => {
  it('shows where the model ran, the structured draft, and saves it for customization', async () => {
    (draftChallenge as jest.Mock).mockResolvedValue({
      intent: { durationMin: 60, participants: { count: 5, mode: 'team' }, activities: [{ module: 'cycling' }], tasks: [{ module: 'cleanup', type: 'collect_items', quantity: 10 }], checkpoints: { count: 4, layout: 'loop' }, difficulty: 'medium', mindful: false, unresolved: [] },
      definition: def,
      issues: [],
      notes: ['No AI model available right now. The built-in rule-based builder made this draft.'],
      where: 'rules',
      modelLabel: 'Rule-based builder (works offline)',
    });
    await render(<AIBuilderScreen {...props('AIBuilder')} />);
    await fireEvent.press(screen.getByText(/Create a 60-minute challenge for 5/));
    await fireEvent.press(screen.getByRole('button', { name: 'Build my challenge' }));
    expect(await screen.findByText(/Rule-based builder \(works offline\)/)).toBeTruthy();
    expect(screen.getByText(/60 min · 👥 5 \(team\)/)).toBeTruthy();
    expect(screen.getByText(/cleanup: collect items × 10/)).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Easier' }));
    expect(screen.getByText(/💪 easy/)).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Use this draft' }));
    await waitFor(() => expect(nav.navigate).toHaveBeenCalledWith('Customize', expect.objectContaining({ draftId: expect.any(String) })));
    expect(mockServices.db.run).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO ai_drafts'), expect.any(Array));
  });
});

describe('Customize', () => {
  beforeEach(() => {
    mockServices.db.get.mockResolvedValue({ definition_json: JSON.stringify(def), generation_id: 'gen-1' } as never);
  });
  it('validates live and publishes (with the AI generation id)', async () => {
    await render(<CustomizeScreen {...props('Customize', { draftId: 'd1' })} />);
    expect(await screen.findByText('Looks good')).toBeTruthy();
    expect(screen.getByText('Max score 310')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Publish' }));
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith('Details', { challengeId: 'new-challenge' }));
    expect(mockServices.api.createChallenge).toHaveBeenCalledWith(expect.objectContaining({ schemaVersion: '1.0' }), expect.any(String), 'gen-1');
  });
  it('shows validator errors and blocks publishing when a duration is impossible', async () => {
    await render(<CustomizeScreen {...props('Customize', { draftId: 'd1' })} />);
    await screen.findByText('Looks good');
    await fireEvent.changeText(screen.getByDisplayValue('60'), '5');
    expect(await screen.findByText(/likely needs/)).toBeTruthy(); // warning: route too long
    await fireEvent.changeText(screen.getByDisplayValue('Green Sprint 60'), 'X');
    expect(await screen.findByText(/at least 3|>=3/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Publish' })).toBeDisabled();
  });
  it('explains that publishing needs internet but the draft is safe', async () => {
    mockServices.api.createChallenge.mockRejectedValue(new NetworkError());
    await render(<CustomizeScreen {...props('Customize', { draftId: 'd1' })} />);
    await screen.findByText('Looks good');
    await fireEvent.press(screen.getByRole('button', { name: 'Publish' }));
    expect(await screen.findByText(/Publishing needs internet/)).toBeTruthy();
  });
});

describe('Pre-flight', () => {
  it('lets you start when blocking checks pass; battery and steps are warnings only', async () => {
    await render(<PreflightScreen {...props('Preflight', { challengeId: CHALLENGE_ID, version: 1 })} />);
    expect(await screen.findByText('In the start zone')).toBeTruthy();
    await waitFor(() => expect(screen.getByRole('button', { name: "I'm ready" })).toBeEnabled());
    expect(screen.getByText(/Steps won't be counted/)).toBeTruthy();
    expect(screen.getByText('15%')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: "I'm ready" }));
    expect(nav.navigate).toHaveBeenCalledWith('Start', { challengeId: CHALLENGE_ID, version: 1 });
  });
  it('blocks when you are far from the start zone and says how far', async () => {
    mockFix = { ...mockFix, coords: { latitude: P.cp3[1], longitude: P.cp3[0], accuracy: 8 } };
    await render(<PreflightScreen {...props('Preflight', { challengeId: CHALLENGE_ID, version: 1 })} />);
    expect(await screen.findByText(/The start zone is \d+ m away/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Not ready yet' })).toBeDisabled();
  });
  it('blocks without location permission and links to the permission screen', async () => {
    mockLocationGranted = false;
    await render(<PreflightScreen {...props('Preflight', { challengeId: CHALLENGE_ID, version: 1 })} />);
    await fireEvent.press(await screen.findByText('Location (while using the app)'));
    expect(nav.navigate).toHaveBeenCalledWith('Permissions', expect.objectContaining({ next: 'Preflight' }));
  });
});

describe('Start', () => {
  it('hold-to-start counts down, starts the session offline and enters Activity Mode', async () => {
    jest.useFakeTimers();
    await render(<StartScreen {...props('Start', { challengeId: CHALLENGE_ID, version: 1 })} />);
    await fireEvent.press(screen.getByLabelText('Mood 3 of 5'));
    const hold = screen.getByLabelText('Hold to start the challenge');
    await act(async () => {
      fireEvent(hold, 'longPress');
    });
    await act(async () => {
      await jest.advanceTimersByTimeAsync(3000);
    });
    jest.useRealTimers();
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith('Live', expect.objectContaining({ sessionId: 'session-1' })));
    expect(mockServices.sm.start).toHaveBeenCalledWith(expect.objectContaining({ challengeId: CHALLENGE_ID, version: 1 }));
    expect(mockServices.sm.setMood).toHaveBeenCalledWith('session-1', 'before', 3);
  });
});

describe('Challenge details, join and leaderboard', () => {
  it('works offline from the downloaded copy', async () => {
    mockServices.api = { ...mockServices.api, getChallenge: jest.fn(async () => { throw new NetworkError(); }) } as never;
    await render(<DetailsScreen {...props('Details', { challengeId: CHALLENGE_ID })} />);
    expect(await screen.findByText(/Offline: showing the downloaded copy/)).toBeTruthy();
    expect(screen.getByText(/Reach the checkpoints in order: Lake Gate → Boat Club/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Prepare to start' })).toBeTruthy();
  });
  it('queues a join in the outbox when offline', async () => {
    mockServices.api = { ...mockServices.api, getChallenge: jest.fn(async () => ({ definition: def, teams: [] })), join: jest.fn(async () => { throw new NetworkError(); }) } as never;
    await render(<JoinScreen {...props('Join', { challengeId: CHALLENGE_ID })} />);
    await fireEvent.press(await screen.findByRole('button', { name: /read the rules/ }));
    await fireEvent.press(screen.getByRole('button', { name: /stay safe/ }));
    await fireEvent.press(screen.getByRole('button', { name: 'Join' }));
    expect(await screen.findByText(/We'll join for you as soon as you're back online/)).toBeTruthy();
    expect(mockServices.sync.enqueue).toHaveBeenCalledWith('join', 'POST', `/v1/challenges/${CHALLENGE_ID}/join`, {});
  });
  it('leaderboard falls back to the cached copy offline', async () => {
    mockServices.api = { ...mockServices.api, leaderboard: jest.fn(async () => { throw new NetworkError(); }) } as never;
    mockServices.store.cachedLeaderboard.mockResolvedValue({ data: { challengeId: CHALLENGE_ID, scope: 'individual', entries: [{ rank: 1, subjectId: 'u1', name: 'Arjun', points: 281, timeS: 2700, verification: 'verified' }], pending: 1, updatedAt: '' }, fetchedAt: new Date().toISOString() } as never);
    await render(<LeaderboardScreen {...props('Leaderboard', { challengeId: CHALLENGE_ID })} />);
    expect(await screen.findByText('Arjun')).toBeTruthy();
    expect(screen.getByText('281')).toBeTruthy();
    expect(screen.getByText(/Offline: showing the last saved leaderboard/)).toBeTruthy();
    expect(screen.getByText(/1 result pending review/)).toBeTruthy();
  });
});

describe('Results, history and sync status', () => {
  it('Results offline shows the provisional score and the breakdown', async () => {
    const snap = midRunSnapshot('finished');
    mockServices.sm.snapshot.mockResolvedValue(snap);
    await render(<ResultsScreen {...props('Results', { sessionId: snap.sessionId })} />);
    expect(await screen.findByText(/Provisional: will verify when synced/)).toBeTruthy();
    expect(screen.getByText(/✅ Checkpoint: Lake Gate: \+25/)).toBeTruthy();
    expect(screen.getByText(/○ Task: Water the Old Banyan: 0 \(Checkpoint not reached\)|○ Task: Water the Old Banyan: 0/)).toBeTruthy();
  });
  it('Results online shows the verdict, neutral flag wording and the AI recap', async () => {
    const snap = midRunSnapshot('finished');
    mockServices.sm.snapshot.mockResolvedValue(snap);
    mockServices.api.session.mockResolvedValue({
      id: snap.sessionId, challengeId: CHALLENGE_ID, challengeTitle: 'Green Sprint 60', challengeVersion: 1, status: 'completed', verdict: 'verified_with_notes', startedAt: null, endedAt: null,
      score: { totalPoints: 150, completed: false, durationS: 1800, distanceM: 1500, breakdown: snap.score.breakdown, status: 'final' },
      flags: [{ code: 'CP_MANUAL', severity: 'info', message: 'A checkpoint was confirmed manually because GPS was weak.' }],
      wellness: { steps: 4212, avgCadenceSpm: 100, activeMinutes: 30, phoneFreeMinutes: 20, kcalEstimate: 150, kcalApprox: true },
    } as never);
    await render(<ResultsScreen {...props('Results', { sessionId: snap.sessionId })} />);
    expect(await screen.findByText('150 pts')).toBeTruthy();
    expect(screen.getByText('✅ Verified with notes')).toBeTruthy();
    expect(screen.getByText(/confirmed manually because GPS was weak/)).toBeTruthy();
    expect(await screen.findByText(/You walked 4,212 steps/)).toBeTruthy();
  });
  it('History lists sessions with sync state', async () => {
    mockServices.sm.history.mockResolvedValue([{ id: 's1', challengeId: CHALLENGE_ID, title: 'Green Sprint 60', status: 'completed', startedAt: new Date().toISOString(), verdict: null, provisional: 260, final: null, pending: 12 }] as never);
    await render(<HistoryScreen />);
    expect(await screen.findByText(/260 pts · ⏳ Waiting to verify · ⬆️ 12 to sync/)).toBeTruthy();
  });
  it('Sync status lists failed items and retries them', async () => {
    useApp.getState().set({ counts: { ...counts, pendingPhotos: 2, failed: 1 } });
    mockServices.db.all.mockImplementation((async (sql: string) => (sql.includes('FROM evidence') ? [{ task_id: 'tree1', last_error: 'Photo changed after capture' }] : [])) as never);
    await render(<SyncStatusScreen />);
    expect(await screen.findByText('Photo (tree1)')).toBeTruthy();
    expect(screen.getByText('Photo changed after capture')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Retry failed items' }));
    await waitFor(() => expect(mockServices.sync.retryFailed).toHaveBeenCalled());
  });
});

describe('Profile', () => {
  it('shows wellness totals and warns before signing out with unsynced data', async () => {
    mockServices.api.wellness.mockResolvedValue({ totals: { steps: 12000, activeMinutes: 90, phoneFreeMinutes: 70, kcalEstimate: 600 } } as never);
    useApp.getState().set({ counts: { ...counts, pendingEvents: 4 } });
    const alert = jest.spyOn(require('react-native').Alert, 'alert');
    await render(<ProfileScreen />);
    expect(await screen.findByText('12000')).toBeTruthy();
    expect(screen.getByText(/not a medical or mental-health app/)).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Sign out' }));
    expect(alert).toHaveBeenCalledWith('Unsynced data', expect.stringContaining('4 unsynced items'), expect.any(Array));
  });
});

void storedChallenge;
