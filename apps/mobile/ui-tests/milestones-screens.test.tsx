/**
 * UI tests for the milestone, quest, module, confirmation and guild screens (Jest + jest-expo +
 * Testing Library), including offline states. Real engine snapshots; services are fakes.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import React from 'react';
import { Alert, Linking } from 'react-native';
import { definitionHash, encodeQr, uuidv7 } from '@trina/contracts';
import { buildQuestDefinition, challengeFromModule, compileOrThrow, defaultRegistry, evaluate, fold, wellness } from '@trina/engine';
import { DEMO_CENTER, SessionBuilder } from '@trina/engine/fixtures';
import { ApiError, NetworkError } from '../src/core/api-client';
import { counts, fakeServices, midRunSnapshot } from './fakes';

let mockServices = fakeServices();
let mockSnap: any = midRunSnapshot();
let mockOnline = true;
let mockScan: string | null = null;
jest.mock('../src/app/services', () => ({ getServices: async () => mockServices, apiBaseUrl: () => 'http://test' }));
jest.mock('../src/app/live-monitor', () => ({ checkLive: jest.fn(async () => mockSnap), onLiveSnapshot: () => () => undefined }));
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
  getLastKnownPositionAsync: jest.fn(async () => ({ coords: { latitude: 22.5115, longitude: 88.35, accuracy: 7 }, timestamp: Date.now() })),
}));
jest.mock('expo-camera', () => {
  const R = jest.requireActual('react');
  return {
    useCameraPermissions: () => [{ granted: true }, jest.fn()],
    CameraView: (p: { onBarcodeScanned?: (e: { data: string }) => void }) => {
      (globalThis as any).mockScanAgain = p.onBarcodeScanned; // later frames: scan another code
      R.useEffect(() => {
        if (mockScan && p.onBarcodeScanned) p.onBarcodeScanned({ data: mockScan });
      }, []);
      return null;
    },
  };
});

import { useApp } from '../src/app/store';
import { unlockText } from '../src/app/milestone-notify';
import { QUEST_GRACE_MS, toConnectivity } from '../src/app/quest-runtime';
import { QUOTES, quotesForDay } from '../src/components/progress';
import { LiveScreen, TasksScreen } from '../src/screens/activity';
import { ConfirmScreen } from '../src/screens/confirm';
import { GuildsScreen } from '../src/screens/guilds';
import { HomeScreen } from '../src/screens/home';
import { MilestoneDetailScreen, MilestoneHistoryScreen, StatusScreen } from '../src/screens/milestones';
import { ModuleBuilderScreen, ModuleDetailScreen } from '../src/screens/modules';
import { QuestStartScreen, TodayScreen } from '../src/screens/quests';
import { startRuntime } from '../src/platform/session-runtime';

const nav = (globalThis as any).mockNav;
const props = (name: string, params: Record<string, unknown> = {}) => ({ navigation: nav, route: { key: name, name, params } }) as any;

/** A real engine snapshot of a cricket session (counters + confirmation task). */
function cricketSnap(opts: { counts?: number } = {}) {
  const def = challengeFromModule(defaultRegistry.get('cricket')!, { start: DEMO_CENTER, durationMin: 90, difficulty: 'hard', team: false });
  const compiled = compileOrThrow(def);
  const b = new SessionBuilder({ challengeId: uuidv7(), definitionHash: definitionHash(compiled.definition), userId: uuidv7(), deviceId: uuidv7(), start: DEMO_CENTER });
  b.start().wait(600, 20);
  for (let i = 0; i < (opts.counts ?? 3); i++) b.emit('CountReported', { counterId: 'cricket.catches', delta: 1 });
  const state = fold(compiled, b.build());
  const bundle = { ...midRunSnapshot().challenge.bundle, definition: compiled.definition, participantKeys: [] };
  return { sessionId: b.sessionId, challenge: { ...midRunSnapshot().challenge, title: 'Cricket', bundle }, compiled, state, score: evaluate(compiled, state), wellness: wellness(compiled, state), nowMono: state.lastMono, remainingMs: 60 * 60_000 };
}

/** A real engine snapshot of a running offline quest. */
function questSnap() {
  const compiled = compileOrThrow(buildQuestDefinition({ templateId: 'outside_v1', targetMinutes: 30, levelTier: 'easy' }, DEMO_CENTER));
  const b = new SessionBuilder({ challengeId: uuidv7(), definitionHash: definitionHash(compiled.definition), userId: uuidv7(), deviceId: uuidv7(), start: DEMO_CENTER });
  b.emit('SessionStarted', {
    challengeId: uuidv7(), challengeVersion: 1, definitionHash: definitionHash(compiled.definition), deviceId: uuidv7(), userId: uuidv7(), teamId: null, bootId: 'b', clockOffsetMsAtDownload: 0,
    startFix: { lat: DEMO_CENTER[1], lng: DEMO_CENTER[0], acc: 6, ts: new Date().toISOString() }, quest: { templateId: 'outside_v1', targetMinutes: 30, levelTier: 'easy' }, tzOffsetMin: 330,
  });
  b.wait(600, 20);
  const state = fold(compiled, b.build());
  return { sessionId: b.sessionId, challenge: { ...midRunSnapshot().challenge, title: 'Daily Quest' }, compiled, state, score: evaluate(compiled, state), wellness: wellness(compiled, state), nowMono: state.lastMono, remainingMs: 35 * 60_000 };
}

beforeEach(() => {
  mockServices = fakeServices();
  mockSnap = midRunSnapshot();
  mockOnline = true;
  mockScan = null;
  jest.clearAllMocks();
  useApp.getState().set({ me: { userId: 'u1', email: 'a@b.dev', displayName: 'Arjun', role: 'user', shareWellbeing: false }, online: true, counts, lastReport: null, awaitingVerdict: 0 });
});

describe('Today: Daily Quests and milestones (offline-capable)', () => {
  it('lists 3 quests with progress, the weekly bonus, in-progress milestones with honest labels', async () => {
    await render(<TodayScreen />);
    expect(await screen.findByText(/DAILY QUESTS · 1\/3 done/)).toBeTruthy();
    expect(screen.getByText(/Finish a 30-min offline quest/)).toBeTruthy();
    expect(screen.getByText('800 / 2000')).toBeTruthy();
    expect(screen.getByText('20 min / 45 min')).toBeTruthy();
    expect(screen.getByText(/Offline 3 × 90: 1\/3 days/)).toBeTruthy();
    expect(screen.getByText(/3 or more costs 10 XP; safety stops never count/)).toBeTruthy();
    expect(screen.getByText(/Steps outside/)).toBeTruthy();
    expect(screen.getByLabelText('Verification: Checked after sync')).toBeTruthy(); // co-presence waits for the server
    await fireEvent.press(screen.getByRole('button', { name: /Start a 30-min offline quest/ }));
    expect(nav.navigate).toHaveBeenCalledWith('QuestStart', { targetMinutes: 30 });
  });
});

describe('Quest start: sync first, then go offline (mobile data AND Wi-Fi)', () => {
  it('locks Start while online, syncs own data first and offers the internet settings shortcut', async () => {
    const open = jest.spyOn(Linking, 'openSettings').mockResolvedValue(undefined as never);
    await render(<QuestStartScreen {...props('QuestStart', { targetMinutes: 45 })} />);
    expect(await screen.findByText('Your data is synced')).toBeTruthy();
    expect(mockServices.sync.runOnce).toHaveBeenCalled();
    expect(screen.getByText('Turn off mobile data and Wi-Fi')).toBeTruthy();
    const start = screen.getByRole('button', { name: /Turn the internet off to start/ });
    expect(start.props.accessibilityState.disabled).toBe(true);
    await fireEvent.press(screen.getByRole('button', { name: 'Open internet settings' }));
    await waitFor(() => expect(open).toHaveBeenCalled());
  });
  it('offline: starts the quest on the phone, arms the guard and opens Activity Mode', async () => {
    mockOnline = false;
    (mockServices.sm as any).startQuest = jest.fn(async () => 'quest-1');
    await render(<QuestStartScreen {...props('QuestStart', { targetMinutes: 30 })} />);
    expect(await screen.findByText('Already offline: your data will sync after the quest')).toBeTruthy();
    expect(mockServices.sync.runOnce).not.toHaveBeenCalled();
    await fireEvent.press(await screen.findByRole('button', { name: /Start quest/ }));
    await waitFor(() => expect((mockServices.sm as any).startQuest).toHaveBeenCalledWith(expect.objectContaining({ spec: { templateId: 'outside_v1', targetMinutes: 30, levelTier: 'easy' }, online: false })));
    expect(mockServices.quest).toEqual({ active: true, sessionId: 'quest-1' });
    expect(startRuntime).toHaveBeenCalledWith('quest-1');
    expect(nav.replace).toHaveBeenCalledWith('Live', { sessionId: 'quest-1' });
  });
  it("a longer quest keeps the player's level tier (difficulty comes from rank, not length; design §5A.2)", async () => {
    mockOnline = false;
    (mockServices.sm as any).startQuest = jest.fn(async () => 'quest-2');
    await render(<QuestStartScreen {...props('QuestStart', { targetMinutes: 30 })} />);
    await fireEvent.press(await screen.findByRole('button', { name: '90 min' }));
    await fireEvent.press(await screen.findByRole('button', { name: /Start quest/ }));
    await waitFor(() => expect((mockServices.sm as any).startQuest).toHaveBeenCalledWith(expect.objectContaining({ spec: { templateId: 'outside_v1', targetMinutes: 90, levelTier: 'easy' } })));
  });
  it('NetInfo states map to offline only when BOTH data and Wi-Fi are off; grace is 60 s', () => {
    expect(toConnectivity({ isConnected: true, isInternetReachable: true, type: 'wifi' })).toEqual({ online: true, transport: 'wifi' });
    expect(toConnectivity({ isConnected: true, isInternetReachable: false, type: 'cellular' })).toEqual({ online: false, transport: 'none' });
    expect(toConnectivity({ isConnected: false, type: 'none' }).online).toBe(false);
    expect(QUEST_GRACE_MS).toBe(60_000);
  });
});

describe('Activity Mode additions', () => {
  it('quest: online banner, no checkpoints card, and stop with safety reasons (never penalised)', async () => {
    mockSnap = questSnap();
    (mockServices.sm as any).stopQuest = jest.fn(async () => undefined);
    const alert = jest.spyOn(Alert, 'alert');
    await render(<LiveScreen {...props('Live', { sessionId: mockSnap.sessionId })} />);
    expect(await screen.findByText(/OFFLINE QUEST · 30 MIN/)).toBeTruthy();
    expect(screen.getByText(/You're online/)).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Challenge menu' }));
    const stop = alert.mock.calls[0]![2]!.find((b) => b.text === 'Stop quest')!;
    await act(async () => stop.onPress!());
    const buttons = alert.mock.calls[1]![2]!;
    expect(alert.mock.calls[1]![1]).toMatch(/Stopping for safety never costs points/);
    await act(async () => buttons.find((b) => b.text === 'Safety: Bad weather')!.onPress!());
    expect((mockServices.sm as any).stopQuest).toHaveBeenCalledWith(mockSnap.sessionId, 'safety', 'weather');
    expect(nav.replace).toHaveBeenCalledWith('Completion', { sessionId: mockSnap.sessionId });
  });
  it('data module: counter pad (+1 / −1) and confirm buttons; confirmation tasks ask a teammate', async () => {
    mockSnap = cricketSnap();
    (mockServices.sm as any).reportCount = jest.fn(async () => ({}));
    useApp.getState().set({ online: false });
    await render(<LiveScreen {...props('Live', { sessionId: mockSnap.sessionId })} />);
    expect(await screen.findByText('Catches taken: 3')).toBeTruthy();
    expect(screen.getByText('Balls faced: 0')).toBeTruthy();
    await fireEvent.press(screen.getByLabelText('Plus one Balls faced'));
    expect((mockServices.sm as any).reportCount).toHaveBeenCalledWith(mockSnap.sessionId, 'cricket.balls_faced', 1);
    await fireEvent.press(screen.getByRole('button', { name: /Ask to confirm/ }));
    expect(nav.navigate).toHaveBeenCalledWith('Confirm', { sessionId: mockSnap.sessionId, mode: 'ask' });
    await render(<TasksScreen {...props('Tasks', { sessionId: mockSnap.sessionId })} />);
    expect(await screen.findByRole('button', { name: /Ask a teammate to confirm/ })).toBeTruthy();
  });
});

describe('Confirmation handshake screens (offline QR)', () => {
  it('ask: picks claims, shows QR-A, then scans the signed QR-B', async () => {
    mockSnap = cricketSnap({ counts: 2 });
    mockServices.sm.snapshot = jest.fn(async () => mockSnap);
    await render(<ConfirmScreen {...props('Confirm', { sessionId: mockSnap.sessionId, mode: 'ask' })} />);
    expect(await screen.findByText(/Catches taken: 2/)).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Show my code' }));
    expect(mockServices.confirm.request).toHaveBeenCalledWith(mockSnap.sessionId, [{ kind: 'counter', ref: 'cricket.catches', value: 2 }]);
    expect(await screen.findByLabelText('Confirmation QR code')).toBeTruthy();
    mockScan = 'TRINA1:token';
    await fireEvent.press(screen.getByRole('button', { name: 'Scan their answer' }));
    expect(await screen.findByText(/Confirmed by Meera/)).toBeTruthy();
    expect(mockServices.confirm.accept).toHaveBeenCalledWith('TRINA1:token', mockSnap.sessionId, []);
  });
  it('ask: after a rejected code the camera keeps scanning (same bad code ignored, the right one accepted)', async () => {
    mockSnap = cricketSnap({ counts: 2 });
    mockServices.sm.snapshot = jest.fn(async () => mockSnap);
    mockServices.confirm.accept.mockClear();
    mockServices.confirm.accept.mockImplementationOnce(async () => {
      throw new Error('This confirmation is for someone else');
    });
    await render(<ConfirmScreen {...props('Confirm', { sessionId: mockSnap.sessionId, mode: 'ask' })} />);
    await fireEvent.press(await screen.findByRole('button', { name: 'Show my code' }));
    mockScan = 'TRINA1:wrong';
    await fireEvent.press(await screen.findByRole('button', { name: 'Scan their answer' }));
    expect(await screen.findByText(/for someone else/)).toBeTruthy();
    await act(async () => (globalThis as any).mockScanAgain({ data: 'TRINA1:wrong' }));
    expect(mockServices.confirm.accept).toHaveBeenCalledTimes(1);
    await act(async () => (globalThis as any).mockScanAgain({ data: 'TRINA1:token' }));
    expect(await screen.findByText(/Confirmed by Meera/)).toBeTruthy();
    expect(mockServices.confirm.accept).toHaveBeenCalledTimes(2);
  });
  it('scan: reviews a request, lets the confirmer LOWER values, signs and shows QR-B', async () => {
    mockSnap = cricketSnap({ counts: 0 });
    mockServices.sm.snapshot = jest.fn(async () => mockSnap);
    mockScan = encodeQr({ t: 'req', challengeId: uuidv7(), subjectUserId: uuidv7(), subjectSessionId: uuidv7(), subjectName: 'Arjun', claims: [{ kind: 'counter', ref: 'cricket.catches', value: 2 }] });
    await render(<ConfirmScreen {...props('Confirm', { sessionId: mockSnap.sessionId, mode: 'scan' })} />);
    expect(await screen.findByText(/Arjun asks you to confirm/)).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: '−' }));
    expect(screen.getByText('catches: 1')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Confirm and sign' }));
    await waitFor(() => expect(mockServices.confirm.approve).toHaveBeenCalledWith(mockScan, mockSnap.sessionId, { approved: [{ kind: 'counter', ref: 'cricket.catches', value: 1 }] }));
    expect(await screen.findByLabelText('Confirmation QR code')).toBeTruthy();
  });
});

describe('Status, history and detail', () => {
  it('Status shows rank, XP, stats and the meadow; provisional while offline', async () => {
    await render(<StatusScreen />);
    expect(await screen.findByText('D')).toBeTruthy();
    expect(screen.getByText('120')).toBeTruthy();
    expect(screen.getByText(/640 \/ 1800 rank points to C/)).toBeTruthy();
    expect(screen.getByText(/Provisional: final numbers arrive after sync/)).toBeTruthy();
    expect(screen.getByText('💚 Vitality')).toBeTruthy();
    expect(screen.getByLabelText(/Your meadow: 9 blades of grass and 1 flowers/)).toBeTruthy();
  });
  it('History groups by day, labels verification honestly and filters', async () => {
    await render(<MilestoneHistoryScreen />);
    expect(await screen.findByText(/Took a catch/)).toBeTruthy();
    expect(screen.getByLabelText('Verification: Confirmed')).toBeTruthy();
    expect(screen.getByLabelText('Verification: Self-reported')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Self-reported' }));
    await waitFor(() => expect(screen.queryByText(/Took a catch/)).toBeNull());
    expect(screen.getByText(/Trickster/)).toBeTruthy();
  });
  it('Detail explains how a milestone was verified', async () => {
    await render(<MilestoneDetailScreen {...props('MilestoneDetail', { key: 'u_kite_flying_7f3a@1:trickster', windowKey: '2026-10-12' })} />);
    expect(await screen.findByText(/earn titles, not XP or rank/)).toBeTruthy();
  });
});

describe('AI Module Builder and module detail', () => {
  const kiteDraft = () => {
    const def = { ...defaultRegistry.get('cricket')!.descriptor!, id: 'u_kite_flying_7f3a', origin: 'community', meta: { displayName: 'Kite flying', description: 'Fly kites with friends.', icon: 'kite', tags: [], language: 'en' }, safety: { checklist: [], daylightOnly: true, notes: ['no_glass_coated_string'] } };
    return { generationId: uuidv7(), status: 'ok', refusal: null, intent: {}, definition: def, issues: [], risk: { level: 'note', findings: [], notes: [], concerns: [] }, notes: [], usedFallback: true, provider: { id: 'template', modelId: 'rules-v1', locality: 'none' } };
  };
  it('drafts a structured card with honest labels and safety notes, then saves it', async () => {
    (mockServices.api as any).moduleDraft = jest.fn(async () => kiteDraft());
    (mockServices.api as any).createModule = jest.fn(async () => ({ id: 'u_kite_flying_7f3a', version: 1, definition: kiteDraft().definition, definitionHash: 'a'.repeat(64) }));
    await render(<ModuleBuilderScreen {...props('ModuleBuilder')} />);
    await fireEvent.changeText(screen.getByPlaceholderText(/kite flying with friends in the field/), 'kite flying with friends');
    await fireEvent.press(screen.getByRole('button', { name: /Draft it/ }));
    expect(await screen.findByText(/Safety: No glass-coated string/)).toBeTruthy();
    expect(screen.getAllByLabelText('Verification: Confirmed').length).toBeGreaterThan(0);
    expect(screen.getByText(/Points and thresholds are set by Trina, never by the AI/)).toBeTruthy();
    expect(screen.getByText(/Started from a template/)).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Save module' }));
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith('ModuleDetail', { id: 'u_kite_flying_7f3a', version: 1 }));
    expect(mockServices.store.saveModule).toHaveBeenCalled();
  });
  it('shows refusals with a reason, the English-only note, and the offline message', async () => {
    (mockServices.api as any).moduleDraft = jest.fn(async () => ({ ...kiteDraft(), status: 'refused', refusal: "This activity isn't safe to turn into a challenge: heights have a high fall risk.", definition: null }));
    await render(<ModuleBuilderScreen {...props('ModuleBuilder')} />);
    await fireEvent.press(screen.getByText('badminton in the park after college'));
    expect(await screen.findByText(/high fall risk\. Try something at ground level, in daylight\./)).toBeTruthy();
    (mockServices.api as any).moduleDraft = jest.fn(async () => ({ ...kiteDraft(), status: 'english_only', refusal: 'The module builder understands English for now.', definition: null }));
    await fireEvent.press(screen.getByText('bird walk at the lake at dawn'));
    expect(await screen.findByText(/understands English for now/)).toBeTruthy();
    (mockServices.api as any).moduleDraft = jest.fn(async () => { throw new NetworkError(); });
    await fireEvent.press(screen.getByText('frisbee with 6 friends'));
    expect(await screen.findByText(/Building a module needs the internet \(playing never does\)/)).toBeTruthy();
  });
  it('module detail: private-only modules cannot be shared by link; others can be forked and reported', async () => {
    const dto = { id: 'u_x_1a2b', version: 1, status: 'active', visibility: 'private', definition: kiteDraft().definition, definitionHash: 'a'.repeat(64), risk: { level: 'private_only', findings: [], notes: [], concerns: ['water'] }, owner: { displayName: 'Arjun' }, forkedFrom: null, publishedAt: null, mine: true };
    (mockServices.api as any).moduleVersion = jest.fn(async () => dto);
    await render(<ModuleDetailScreen {...props('ModuleDetail', { id: 'u_x_1a2b', version: 1 })} />);
    expect(await screen.findByText(/Private only because of a safety concern/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Share by link/ }).props.accessibilityState.disabled).toBe(true);
    (mockServices.api as any).moduleVersion = jest.fn(async () => ({ ...dto, mine: false, risk: { level: 'ok', findings: [], notes: [], concerns: [] }, owner: { displayName: 'Priya' } }));
    (mockServices.api as any).forkModule = jest.fn(async () => ({ id: 'u_kite_flying_9c9c', version: 1 }));
    await render(<ModuleDetailScreen {...props('ModuleDetail', { id: 'u_x_1a2b', version: 1 })} />);
    expect(await screen.findByText(/Community · by Priya/)).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Make my own version' }));
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith('ModuleDetail', { id: 'u_kite_flying_9c9c', version: 1 }));
  });
  it('module detail offline explains it needs the internet', async () => {
    (mockServices.api as any).moduleVersion = jest.fn(async () => { throw new NetworkError(); });
    await render(<ModuleDetailScreen {...props('ModuleDetail', { id: 'u_x_1a2b', version: 1 })} />);
    expect(await screen.findByText(/Module details load when you are online/)).toBeTruthy();
  });
});

describe('Guilds', () => {
  const board = { guildId: 'g1', period: 'week', weekKey: '2026-W42', entries: [{ userId: 'u1', displayName: 'Arjun', xp: 90, offlineMinutes: 95 }, { userId: 'u2', displayName: 'Meera', xp: 40, offlineMinutes: 30 }], guildQuest: { title: 'Guild reaches 600 offline minutes together', target: 600, value: 125 } };
  it('shows the weekly board and Guild Quest, creates and joins', async () => {
    (mockServices.api as any).myGuilds = jest.fn(async () => ({ items: [{ id: 'g1', name: 'Lake Walkers', icon: 'leaf', role: 'leader', members: 2 }] }));
    (mockServices.api as any).guildBoard = jest.fn(async () => board);
    (mockServices.api as any).guildInvite = jest.fn(async () => ({ code: 'ABCD2345', expiresAt: '' }));
    await render(<GuildsScreen />);
    expect(await screen.findByText('Lake Walkers')).toBeTruthy();
    expect(screen.getByText('125 / 600 offline minutes')).toBeTruthy();
    expect(screen.getByText('1. Arjun')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Invite friends' }));
    expect(await screen.findByText('Invite code: ABCD2345')).toBeTruthy();
    await fireEvent.changeText(screen.getByPlaceholderText('ABCD2345'), 'wxyz2345');
    await fireEvent.press(screen.getByRole('button', { name: 'Join' }));
    expect((mockServices.api as any).joinGuild).toHaveBeenCalledWith('WXYZ2345');
  });
  it('offline: shows the last saved boards', async () => {
    (mockServices.api as any).myGuilds = jest.fn(async () => { throw new NetworkError(); });
    mockServices.db.all = jest.fn(async () => [{ json: JSON.stringify({ guild: { id: 'g1', name: 'Lake Walkers', icon: 'leaf', role: 'member', members: 2 }, board }) }]) as never;
    await render(<GuildsScreen />);
    expect(await screen.findByText(/Offline: showing your last saved boards/)).toBeTruthy();
    expect(screen.getByText('Lake Walkers')).toBeTruthy();
  });
  it('shows server errors (e.g. names that are not allowed)', async () => {
    (mockServices.api as any).createGuild = jest.fn(async () => { throw new ApiError(422, { detail: "That guild name isn't allowed" }); });
    await render(<GuildsScreen />);
    await fireEvent.changeText(await screen.findByPlaceholderText('Lake Walkers'), 'Rooftop racers');
    await fireEvent.press(screen.getByRole('button', { name: 'Create guild' }));
    expect(await screen.findByText(/That guild name isn't allowed/)).toBeTruthy();
  });
});

describe('Home: quote carousel and Daily Quest card', () => {
  it('auto-slides motivational lines with personal cards, and starts a quest', async () => {
    jest.useFakeTimers();
    await render(<HomeScreen />);
    expect(await screen.findByText(/Today's quests: 1\/3 done/)).toBeTruthy();
    expect(screen.getByText(/2 more 90-min days for the \+15 weekly bonus/)).toBeTruthy();
    expect(screen.getByLabelText('Motivation')).toBeTruthy();
    act(() => jest.advanceTimersByTime(6500));
    await fireEvent.press(screen.getByRole('button', { name: 'Start Daily Quest' }));
    expect(nav.navigate).toHaveBeenCalledWith('QuestStart', { targetMinutes: 30 });
    jest.useRealTimers();
  });
  it('quotes: 60 original lines, deterministic per day', () => {
    expect(QUOTES.length).toBe(60);
    expect(new Set(QUOTES).size).toBe(60);
    expect(quotesForDay('2026-10-12')).toEqual(quotesForDay('2026-10-12'));
    expect(quotesForDay('2026-10-12')).not.toEqual(quotesForDay('2026-10-13'));
  });
});

describe('notification copy', () => {
  it('announces unlocks with their verification, and confirmations separately', () => {
    const m = { key: 'cricket@1:took_catch', windowKey: 'w', tier: 'unlock', title: 'Took a catch', value: 1, verification: 'peer' as const, label: 'Confirmed' as const, stat: 'AGI', dayKey: 'd', status: 'provisional' as const, unlockedAt: '', sources: [] };
    expect(unlockText([m], 'unlocked')).toEqual({ title: 'Milestone unlocked: Took a catch 🏏', body: "Confirmed by another player · Final check when you're back online" });
    expect(unlockText([m, { ...m, title: 'x' }], 'confirmed')!.title).toBe('Confirmed: Took a catch 🏏 (+1 more)');
    expect(unlockText([], 'unlocked')).toBeNull();
  });
});

describe('quest runtime: connectivity during a quest (60 s grace → pause → resume)', () => {
  it('records changes, warns, pauses after the grace period only if still online, resumes when offline', async () => {
    jest.useFakeTimers();
    const { onQuestConnectivity, setQuestActive } = jest.requireActual('../src/app/quest-runtime') as typeof import('../src/app/quest-runtime');
    const Notifications = jest.requireMock('expo-notifications');
    (mockServices.sm as any).setConnectivity = jest.fn(async () => true);
    expect(await onQuestConnectivity({ online: true, transport: 'wifi' })).toBe('none'); // no quest → nothing recorded
    await setQuestActive('quest-1');
    mockOnline = true;
    expect(await onQuestConnectivity({ online: true, transport: 'cellular' })).toBe('grace');
    expect((mockServices.sm as any).setConnectivity).toHaveBeenCalledWith('quest-1', true, 'cellular');
    expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledWith(expect.objectContaining({ content: expect.objectContaining({ title: "You're online" }) }));
    await act(async () => {
      jest.advanceTimersByTime(QUEST_GRACE_MS + 10);
    });
    await waitFor(() => expect(mockServices.sm.append).toHaveBeenCalledWith('quest-1', 'SessionPaused', {}));
    mockOnline = false;
    expect(await onQuestConnectivity({ online: false, transport: 'none' })).toBe('resumed');
    expect(mockServices.sm.append).toHaveBeenCalledWith('quest-1', 'SessionResumed', {});
    // Back online briefly, then offline within the grace: no pause at all.
    mockOnline = true;
    (mockServices.sm.append as jest.Mock).mockClear();
    await onQuestConnectivity({ online: true, transport: 'wifi' });
    mockOnline = false;
    expect(await onQuestConnectivity({ online: false, transport: 'none' })).toBe('recorded');
    await act(async () => {
      jest.advanceTimersByTime(QUEST_GRACE_MS + 10);
    });
    expect(mockServices.sm.append).not.toHaveBeenCalledWith('quest-1', 'SessionPaused', {});
    await setQuestActive(null);
    expect(mockServices.quest).toEqual({ active: false, sessionId: null });
    jest.useRealTimers();
  });

  it('openInternetSettings uses the Android internet panel and falls back to Settings', async () => {
    const { openInternetSettings } = jest.requireActual('../src/app/quest-runtime') as typeof import('../src/app/quest-runtime');
    const send = jest.spyOn(Linking, 'sendIntent').mockRejectedValue(new Error('old android'));
    const open = jest.spyOn(Linking, 'openSettings').mockResolvedValue(undefined as never);
    await openInternetSettings();
    expect(open).toHaveBeenCalled();
    send.mockRestore();
  });
});

describe('announceMilestones: exactly-once notifications with haptics', () => {
  it('announces fresh unlocks once, confirmed ones separately, and marks both', async () => {
    const { announceMilestones } = jest.requireActual('../src/app/milestone-notify') as typeof import('../src/app/milestone-notify');
    const Notifications = jest.requireMock('expo-notifications');
    const Haptics = jest.requireMock('expo-haptics');
    const ms = mockServices.ms as any;
    const fresh = { key: '*@1:q_offline_30', windowKey: 'd', tier: 'unlock', title: 'Finish a 30-min offline quest', label: 'Measured' };
    const fin = { key: 'cricket@1:took_catch', windowKey: 'd', tier: 'unlock', title: 'Took a catch', label: 'Confirmed' };
    ms.evaluateLocal = jest.fn(async () => [fresh]);
    ms.newlyFinal = jest.fn(async () => [fin]);
    const out = await announceMilestones(ms);
    expect(out.unlocked).toEqual([fresh]);
    expect(out.confirmed).toEqual([fin]);
    expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledTimes(2);
    expect(Haptics.notificationAsync).toHaveBeenCalled();
    expect(ms.markNotified).toHaveBeenCalledWith([fresh]);
    expect(ms.markFinalNotified).toHaveBeenCalledWith([fin]);
    ms.evaluateLocal = jest.fn(async () => []);
    ms.newlyFinal = jest.fn(async () => []);
    (Notifications.scheduleNotificationAsync as jest.Mock).mockClear();
    await announceMilestones(ms);
    expect(Notifications.scheduleNotificationAsync).not.toHaveBeenCalled();
  });
});
