import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import React from 'react';
import { Alert } from 'react-native';
import { counts, fakeServices, midRunSnapshot } from './fakes';

let mockServices = fakeServices();
let mockSnap = midRunSnapshot();
const mockListeners = new Set<(s: unknown) => void>();
jest.mock('../src/app/services', () => ({ getServices: async () => mockServices, apiBaseUrl: () => 'http://test' }));
jest.mock('../src/app/live-monitor', () => ({
  checkLive: jest.fn(async () => mockSnap),
  onLiveSnapshot: (fn: (s: unknown) => void) => {
    mockListeners.add(fn);
    return () => mockListeners.delete(fn);
  },
}));

import { CheckpointScreen, CompletionScreen, LiveScreen, TasksScreen } from '../src/screens/activity';
import { useApp } from '../src/app/store';
import { stopRuntime } from '../src/platform/session-runtime';

const nav = (globalThis as any).mockNav;
const props = (name: string, params: Record<string, unknown>) => ({ navigation: nav, route: { key: name, name, params } }) as any;

beforeEach(() => {
  mockServices = fakeServices();
  mockSnap = midRunSnapshot();
  jest.clearAllMocks();
  useApp.getState().set({ online: false, syncing: false, counts, lastReport: null, awaitingVerdict: 0 });
});

describe('LiveScreen (minimal, glanceable, pocket-first)', () => {
  it('shows time left, the next checkpoint, the current task and provisional points while offline', async () => {
    await render(<LiveScreen {...props('Live', { sessionId: mockSnap.sessionId })} />);
    expect(await screen.findByText('Old Banyan')).toBeTruthy(); // cp1 + cp2 reached → cp3 is next
    expect(screen.getByText(/35:00|34:5/)).toBeTruthy();
    expect(screen.getByText('📴 offline')).toBeTruthy();
    expect(screen.getByText(/Put your phone away/)).toBeTruthy();
    expect(screen.getByText(/2\/4 checkpoints/)).toBeTruthy();
    expect(screen.getByText('Collect 10 pieces of litter')).toBeTruthy(); // unlocked at cp2
    expect(screen.getByText(String(mockSnap.score.total))).toBeTruthy();
    expect(screen.getByText(/You can lock your phone now/)).toBeTruthy();
  });

  it('jumps to the Checkpoint screen when a new checkpoint is reached, then to Completion when done', async () => {
    await render(<LiveScreen {...props('Live', { sessionId: mockSnap.sessionId })} />);
    await screen.findByText('Old Banyan');
    // Simulate the background task reporting the next snapshot (cp3 reached).
    const next = midRunSnapshot();
    next.state.checkpoints.cp3!.reached = true;
    await act(async () => mockListeners.forEach((fn) => fn(next)));
    await waitFor(() => expect(nav.navigate).toHaveBeenCalledWith('Checkpoint', { sessionId: next.sessionId, checkpointId: 'cp3' }));
    const done = midRunSnapshot('finished');
    await act(async () => mockListeners.forEach((fn) => fn(done)));
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith('Completion', { sessionId: done.sessionId }));
  });

  it('offers Evidence for an unlocked photo task and opens the in-app camera', async () => {
    mockSnap.state.tasks.litter!.status = 'available';
    await render(<LiveScreen {...props('Live', { sessionId: mockSnap.sessionId })} />);
    await fireEvent.press(await screen.findByRole('button', { name: /Evidence/ }));
    expect(nav.navigate).toHaveBeenCalledWith('Camera', { sessionId: mockSnap.sessionId, taskId: 'litter' });
    expect(screen.getByText(/Show the full bag of litter/)).toBeTruthy();
  });

  it('menu → Finish asks for confirmation, then finishes and stops tracking', async () => {
    const alert = jest.spyOn(Alert, 'alert');
    await render(<LiveScreen {...props('Live', { sessionId: mockSnap.sessionId })} />);
    await fireEvent.press(await screen.findByLabelText('Challenge menu'));
    const finish = alert.mock.calls[0]![2]!.find((b) => b.text === 'Finish now')!;
    await act(async () => finish.onPress!());
    const confirm = alert.mock.calls[1]![2]!.find((b) => b.text === 'Finish')!;
    await act(async () => confirm.onPress!());
    expect(stopRuntime).toHaveBeenCalled();
    expect(mockServices.sm.finish).toHaveBeenCalledWith(mockSnap.sessionId, 'manual', expect.anything());
    expect(nav.replace).toHaveBeenCalledWith('Completion', { sessionId: mockSnap.sessionId });
  });
});

describe('TasksScreen', () => {
  it('lists locked tasks with their checkpoint and lets you open the camera for available ones', async () => {
    mockSnap.state.tasks.litter!.status = 'available';
    await render(<TasksScreen {...props('Tasks', { sessionId: mockSnap.sessionId })} />);
    expect(await screen.findByText('Collect 10 pieces of litter')).toBeTruthy();
    expect(screen.getByText(/🔒 at Old Banyan/)).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: /Take photo/ }));
    expect(nav.navigate).toHaveBeenCalledWith('Camera', { sessionId: mockSnap.sessionId, taskId: 'litter' });
  });
});

describe('CheckpointScreen', () => {
  it('celebrates and offers the unlocked task', async () => {
    await render(<CheckpointScreen {...props('Checkpoint', { sessionId: mockSnap.sessionId, checkpointId: 'cp2' })} />);
    expect(await screen.findByText('Boat Club reached')).toBeTruthy();
    expect(screen.getByText(/🔓 Collect 10 pieces of litter/)).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: /Do it now/ }));
    expect(nav.replace).toHaveBeenCalledWith('Camera', { sessionId: mockSnap.sessionId, taskId: 'litter' });
  });
});

describe('CompletionScreen', () => {
  it('shows provisional points, offline label, wellness estimates; mood is sent only if opted in', async () => {
    mockServices.sm.snapshot.mockResolvedValue(midRunSnapshot('finished'));
    const finished = midRunSnapshot('finished');
    await render(<CompletionScreen {...props('Completion', { sessionId: finished.sessionId })} />);
    expect(await screen.findByText(`${finished.score.total} pts`)).toBeTruthy();
    expect(screen.getByText('Offline · will verify when online')).toBeTruthy();
    expect(screen.getByText(/estimates, not medical advice/)).toBeTruthy();
    expect(stopRuntime).toHaveBeenCalled();
    await fireEvent.press(screen.getByLabelText('Mood 5 of 5'));
    expect(mockServices.sm.setMood).toHaveBeenCalledWith(finished.sessionId, 'after', 5);
    expect(mockServices.sync.enqueue).not.toHaveBeenCalled(); // shareWellbeing = false
  });
});
