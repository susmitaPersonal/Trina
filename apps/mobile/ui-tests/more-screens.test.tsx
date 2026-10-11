import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import React from 'react';
import { Linking } from 'react-native';
import { compileOrThrow } from '@trina/engine';
import { greenSprintDefinition } from '@trina/engine/fixtures';
import { NetworkError } from '../src/core/api-client';
import { CHALLENGE_ID, counts, fakeServices, midRunSnapshot } from './fakes';

let mockServices = fakeServices();
let mockSnap = midRunSnapshot();
let mockPerm: 'granted' | 'denied' | 'undetermined' = 'granted';
jest.mock('../src/app/services', () => ({ getServices: async () => mockServices, apiBaseUrl: () => 'http://test' }));
jest.mock('../src/app/live-monitor', () => ({ checkLive: jest.fn(async () => mockSnap), onLiveSnapshot: () => () => undefined }));
jest.mock('expo-location', () => ({
  Accuracy: { Low: 1, Balanced: 3, High: 4, BestForNavigation: 6 },
  getForegroundPermissionsAsync: jest.fn(async () => ({ granted: mockPerm === 'granted', status: mockPerm })),
  requestForegroundPermissionsAsync: jest.fn(async () => ({ granted: true, status: 'granted' })),
  getLastKnownPositionAsync: jest.fn(async () => ({ coords: { latitude: 22.5115, longitude: 88.35, accuracy: 8 }, timestamp: Date.now() })),
  getCurrentPositionAsync: jest.fn(async () => ({ coords: { latitude: 22.5115, longitude: 88.35, accuracy: 8 }, timestamp: Date.now() })),
}));
jest.mock('expo-camera', () => {
  const R = jest.requireActual('react');
  return {
    Camera: { getCameraPermissionsAsync: jest.fn(async () => ({ granted: mockPerm === 'granted', status: mockPerm })), requestCameraPermissionsAsync: jest.fn(async () => ({ granted: true })) },
    CameraView: R.forwardRef((_p: unknown, ref: unknown) => {
      R.useImperativeHandle(ref, () => ({ takePictureAsync: async () => ({ uri: 'file:///tmp/raw.jpg' }) }));
      return null;
    }),
    useCameraPermissions: () => [{ granted: mockPerm === 'granted' }, jest.fn()],
  };
});
jest.mock('expo-sensors', () => ({ Pedometer: { getPermissionsAsync: jest.fn(async () => ({ granted: false, status: 'undetermined' })), requestPermissionsAsync: jest.fn(async () => ({ granted: true })) } }));
jest.mock('expo-file-system/legacy', () => ({ documentDirectory: 'file:///docs/', makeDirectoryAsync: jest.fn(), createDownloadResumable: jest.fn(), getInfoAsync: jest.fn(), deleteAsync: jest.fn() }));

import { useApp } from '../src/app/store';
import { CameraScreen, CheckpointScreen, MapScreen } from '../src/screens/activity';
import { RegisterScreen } from '../src/screens/auth';
import { JoinScreen } from '../src/screens/challenge';
import { CreateScreen } from '../src/screens/create';
import { DiscoverScreen } from '../src/screens/home';
import { PermissionsScreen } from '../src/screens/prepare';
import { AIModelScreen } from '../src/screens/profile';
import { storeEvidencePhoto } from '../src/platform/files';

const nav = (globalThis as any).mockNav;
const props = (name: string, params: Record<string, unknown> = {}) => ({ navigation: nav, route: { key: name, name, params } }) as any;
const def = compileOrThrow(greenSprintDefinition()).definition;
const summary = { id: CHALLENGE_ID, title: 'Green Sprint 60', status: 'published', visibility: 'public', difficulty: 'easy', moduleIds: ['walking', 'cleanup'], durationMin: 60, startPoint: [88.35, 22.5115], distanceKm: 0.3, opensAt: null, closesAt: null, participants: 3, maxParticipants: 50, creatorName: 'Priya', currentVersion: 1 };

beforeEach(() => {
  mockServices = fakeServices();
  mockSnap = midRunSnapshot();
  mockPerm = 'granted';
  jest.clearAllMocks();
  useApp.getState().set({ me: { userId: 'u1', email: 'a@b.dev', displayName: 'Arjun', role: 'user', shareWellbeing: false }, online: true, counts, lastReport: null, awaitingVerdict: 0 });
});

describe('Discover', () => {
  it('lists nearby challenges with distance and opens one', async () => {
    (mockServices.api as any).listChallenges = jest.fn(async () => ({ items: [summary], nextCursor: null }));
    await render(<DiscoverScreen />);
    expect(await screen.findByText(/60 min · easy · 3\/50 joined · 0.3 km away/)).toBeTruthy();
    expect((mockServices.api as any).listChallenges).toHaveBeenCalledWith(expect.objectContaining({ near: [88.35, 22.5115] }));
    await fireEvent.press(screen.getByText(/Green Sprint 60/));
    expect(nav.navigate).toHaveBeenCalledWith('Details', { challengeId: CHALLENGE_ID });
  });
  it('filters by module and duration', async () => {
    (mockServices.api as any).listChallenges = jest.fn(async () => ({ items: [], nextCursor: null }));
    await render(<DiscoverScreen />);
    await screen.findByText(/No challenges here yet/);
    await fireEvent.press(screen.getByText('🌳 tree care'));
    await waitFor(() => expect((mockServices.api as any).listChallenges).toHaveBeenLastCalledWith(expect.objectContaining({ module: 'tree_care' })));
    await fireEvent.press(screen.getByText('≤ 45 min'));
    await waitFor(() => expect((mockServices.api as any).listChallenges).toHaveBeenLastCalledWith(expect.objectContaining({ maxDuration: 45 })));
  });
  it('explains that discovery needs internet when offline, without location when denied', async () => {
    mockPerm = 'denied';
    (mockServices.api as any).listChallenges = jest.fn(async () => { throw new NetworkError(); });
    await render(<DiscoverScreen />);
    expect(await screen.findByText(/Discover needs internet/)).toBeTruthy();
    expect((mockServices.api as any).listChallenges).toHaveBeenCalledWith(expect.objectContaining({ near: undefined }));
  });
});

describe('Permissions', () => {
  it('explains why before asking; denied permissions open system settings', async () => {
    mockPerm = 'denied';
    const open = jest.spyOn(Linking, 'openSettings').mockResolvedValue(undefined as never);
    await render(<PermissionsScreen {...props('Permissions')} />);
    expect(await screen.findByText(/never at home/)).toBeTruthy();
    expect(screen.getByText(/We never ask for "Always"/)).toBeTruthy();
    const buttons = await screen.findAllByRole('button', { name: 'Open settings' });
    await fireEvent.press(buttons[0]!);
    expect(open).toHaveBeenCalled();
  });
  it('shows "Allowed" when granted and returns to pre-flight', async () => {
    await render(<PermissionsScreen {...props('Permissions', { next: 'Preflight', challengeId: CHALLENGE_ID, version: 1 })} />);
    expect((await screen.findAllByText('Allowed')).length).toBeGreaterThanOrEqual(2);
    await fireEvent.press(screen.getByRole('button', { name: 'Done' }));
    expect(nav.navigate).toHaveBeenCalledWith('Preflight', { challengeId: CHALLENGE_ID, version: 1 });
  });
});

describe('Camera (in-app evidence only)', () => {
  it('capture → preview → use → stored with hash + location → mark done with quantity', async () => {
    await render(<CameraScreen {...props('Camera', { sessionId: mockSnap.sessionId, taskId: 'litter' })} />);
    expect(await screen.findByText(/Show the full bag of litter · Please avoid photographing people/)).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: /Capture/ }));
    await fireEvent.press(await screen.findByRole('button', { name: 'Use photo' }));
    expect(await screen.findByText('Saved on device · will upload later')).toBeTruthy();
    expect(storeEvidencePhoto).toHaveBeenCalledWith('file:///tmp/raw.jpg', mockSnap.sessionId, expect.stringContaining('litter-'));
    expect(mockServices.sm.captureEvidence).toHaveBeenCalledWith(expect.objectContaining({ taskId: 'litter', checkpointId: 'cp2', sha256: 'a'.repeat(64), fix: expect.objectContaining({ lat: 22.5115 }) }));
    await fireEvent.changeText(screen.getByPlaceholderText('10'), '12');
    await fireEvent.press(screen.getByRole('button', { name: 'Mark task done' }));
    expect(mockServices.sm.append).toHaveBeenCalledWith(mockSnap.sessionId, 'TaskCompleted', { taskId: 'litter', quantity: 12 });
    expect(nav.goBack).toHaveBeenCalled();
  });
  it('retake discards the preview; no camera permission → explains and asks', async () => {
    await render(<CameraScreen {...props('Camera', { sessionId: mockSnap.sessionId, taskId: 'litter' })} />);
    await fireEvent.press(await screen.findByRole('button', { name: /Capture/ }));
    await fireEvent.press(await screen.findByRole('button', { name: 'Retake' }));
    expect(screen.getByRole('button', { name: /Capture/ })).toBeTruthy();
    expect(mockServices.sm.captureEvidence).not.toHaveBeenCalled();
  });
  it('asks for camera access when not granted', async () => {
    mockPerm = 'denied';
    await render(<CameraScreen {...props('Camera', { sessionId: mockSnap.sessionId, taskId: 'litter' })} />);
    expect(await screen.findByText(/taken inside Trina so they can be verified/)).toBeTruthy();
  });
});

describe('Map and Checkpoint', () => {
  it('Map draws the route offline with your track', async () => {
    await render(<MapScreen {...props('Map', { sessionId: mockSnap.sessionId })} />);
    expect(await screen.findByText(/No map tiles needed/)).toBeTruthy();
    const tree = JSON.stringify(screen.toJSON());
    expect(tree).toContain('"content":"S"');
    expect(tree).toContain('"content":"✓"');
  });
  it('a checkpoint with no tasks only offers Continue', async () => {
    await render(<CheckpointScreen {...props('Checkpoint', { sessionId: mockSnap.sessionId, checkpointId: 'cp1' })} />);
    expect(await screen.findByText('Lake Gate reached')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Do it now/ })).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: 'Continue' }));
    expect(nav.goBack).toHaveBeenCalled();
  });
});

describe('Create hub and AI model', () => {
  it('Create lists templates and drafts', async () => {
    mockServices.api.templates.mockResolvedValue({ items: [{ id: 't1', title: 'Mindful Park Walk', description: 'Easy 30 minutes', moduleIds: ['walking', 'mindful'], definition: def }] } as never);
    mockServices.db.all.mockResolvedValue([{ id: 'd1', prompt: 'walk and water trees', created_at: new Date().toISOString() }] as never);
    await render(<CreateScreen />);
    expect(await screen.findByText(/Mindful Park Walk/)).toBeTruthy();
    expect(screen.getByText('“walk and water trees”')).toBeTruthy();
    await fireEvent.press(screen.getByText(/Describe it/));
    expect(nav.navigate).toHaveBeenCalledWith('AIBuilder');
    await fireEvent.press(screen.getByText('“walk and water trees”'));
    expect(nav.navigate).toHaveBeenCalledWith('Customize', { draftId: 'd1' });
  });
  it('AI model screen says when the runtime is missing and disables download', async () => {
    await render(<AIModelScreen />);
    expect(await screen.findByText(/Not included in this build/)).toBeTruthy();
    expect(screen.getByText(/Device memory: 8.0 GB/)).toBeTruthy();
    for (const b of screen.getAllByRole('button', { name: /Download/ })) expect(b).toBeDisabled();
  });
});

describe('Register and Join (teams)', () => {
  it('registration signs you in', async () => {
    mockServices.api.register.mockResolvedValue({ user: { id: 'u9', email: 'm@t.dev', displayName: 'Meera', role: 'user', shareWellbeing: false, createdAt: '' }, accessToken: 'a', refreshToken: 'r', expiresIn: 900 } as never);
    useApp.getState().set({ me: null });
    await render(<RegisterScreen {...props('Register')} />);
    const [name, email, password] = screen.getAllByDisplayValue('');
    await fireEvent.changeText(name!, 'Meera');
    await fireEvent.changeText(email!, 'm@t.dev');
    await fireEvent.changeText(password!, 'long enough password');
    await fireEvent.press(screen.getByRole('button', { name: /I am 16 or older/ }));
    await fireEvent.press(screen.getByRole('button', { name: 'Create account' }));
    await waitFor(() => expect(useApp.getState().me?.displayName).toBe('Meera'));
  });
  it('team challenges: pick an existing team or name a new one; downloads after joining', async () => {
    const teamDef = { ...def, mode: 'team' };
    (mockServices.api as any).getChallenge = jest.fn(async () => ({ definition: teamDef, teams: [{ id: 'team-1', name: 'Neem Squad', members: 2 }] }));
    (mockServices.api as any).join = jest.fn(async () => ({ participation: { teamId: 'team-1' }, joinedVersion: 1 }));
    (mockServices.api as any).bundle = jest.fn(async () => ({}));
    await render(<JoinScreen {...props('Join', { challengeId: CHALLENGE_ID })} />);
    await fireEvent.press(await screen.findByText('Neem Squad (2)'));
    await fireEvent.press(screen.getByRole('button', { name: /read the rules/ }));
    await fireEvent.press(screen.getByRole('button', { name: /stay safe/ }));
    await fireEvent.press(screen.getByRole('button', { name: 'Join' }));
    await waitFor(() => expect(nav.goBack).toHaveBeenCalled());
    expect((mockServices.api as any).join).toHaveBeenCalledWith(CHALLENGE_ID, { teamId: 'team-1' });
    expect(mockServices.store.saveBundle).toHaveBeenCalled();
  });
  it('Join stays disabled until both acknowledgements are ticked', async () => {
    (mockServices.api as any).getChallenge = jest.fn(async () => ({ definition: def, teams: [] }));
    await render(<JoinScreen {...props('Join', { challengeId: CHALLENGE_ID })} />);
    await screen.findByRole('button', { name: /read the rules/ });
    expect(screen.getByRole('button', { name: 'Join' })).toBeDisabled();
    await fireEvent.press(screen.getByRole('button', { name: /read the rules/ }));
    expect(screen.getByRole('button', { name: 'Join' })).toBeDisabled();
  });
});
