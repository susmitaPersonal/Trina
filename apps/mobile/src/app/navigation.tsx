import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import React from 'react';
import { Text } from 'react-native';
import { CameraScreen, CheckpointScreen, CompletionScreen, LiveScreen, MapScreen, TasksScreen } from '../screens/activity';
import { LoginScreen, RegisterScreen } from '../screens/auth';
import { DetailsScreen, JoinScreen, LeaderboardScreen } from '../screens/challenge';
import { AIBuilderScreen, CreateScreen, CustomizeScreen } from '../screens/create';
import { DiscoverScreen, HomeScreen } from '../screens/home';
import { PermissionsScreen, PreflightScreen, StartScreen } from '../screens/prepare';
import { AIModelScreen, ProfileScreen } from '../screens/profile';
import { HistoryScreen, ResultsScreen, SyncStatusScreen } from '../screens/results';
import { ConfirmScreen } from '../screens/confirm';
import { GuildsScreen } from '../screens/guilds';
import { MilestoneDetailScreen, MilestoneHistoryScreen, StatusScreen } from '../screens/milestones';
import { ModuleBuilderScreen, ModuleDetailScreen } from '../screens/modules';
import { PartyHostScreen, PartyJoinScreen, PartyPlayScreen, PartyScreen } from '../screens/party';
import { QuestStartScreen, TodayScreen } from '../screens/quests';
import { useApp } from './store';

export type RootParams = {
  Login: undefined;
  Register: undefined;
  Tabs: undefined;
  Details: { challengeId: string };
  Join: { challengeId: string };
  Leaderboard: { challengeId: string; title?: string };
  AIBuilder: undefined;
  Customize: { draftId?: string; templateId?: string };
  Preflight: { challengeId: string; version: number };
  Permissions: { next?: 'Preflight'; challengeId?: string; version?: number };
  Start: { challengeId: string; version: number };
  Live: { sessionId: string };
  Map: { sessionId: string };
  Tasks: { sessionId: string };
  Camera: { sessionId: string; taskId: string };
  Checkpoint: { sessionId: string; checkpointId: string };
  Completion: { sessionId: string };
  Results: { sessionId: string };
  History: undefined;
  SyncStatus: undefined;
  AIModel: undefined;
  QuestStart: { targetMinutes?: number; maxMinutes?: number } | undefined;
  Status: undefined;
  MilestoneHistory: undefined;
  MilestoneDetail: { key: string; windowKey: string };
  ModuleBuilder: undefined;
  ModuleDetail: { id: string; version: number };
  Confirm: { sessionId: string; mode: 'ask' | 'scan' };
  Guilds: undefined;
  Party: undefined;
  PartyHost: undefined;
  PartyJoin: undefined;
  PartyPlay: { sessionId: string; meetFirst?: boolean };
};

const Stack = createNativeStackNavigator<RootParams>();
const Tab = createBottomTabNavigator();

const icon = (e: string) => () => <Text style={{ fontSize: 22 }}>{e}</Text>;

function Tabs() {
  return (
    <Tab.Navigator screenOptions={{ headerShown: false, tabBarLabelStyle: { fontSize: 13, fontWeight: '600' }, tabBarStyle: { height: 64 } }}>
      <Tab.Screen name="Home" component={HomeScreen} options={{ tabBarIcon: icon('🏠') }} />
      <Tab.Screen name="Today" component={TodayScreen} options={{ tabBarIcon: icon('🌱') }} />
      <Tab.Screen name="Discover" component={DiscoverScreen} options={{ tabBarIcon: icon('🧭') }} />
      <Tab.Screen name="Create" component={CreateScreen} options={{ tabBarIcon: icon('✨') }} />
      <Tab.Screen name="Profile" component={ProfileScreen} options={{ tabBarIcon: icon('🙂') }} />
    </Tab.Navigator>
  );
}

export function RootNavigator({ resumeSessionId }: { resumeSessionId: string | null }) {
  const me = useApp((s) => s.me);
  const activity = { headerShown: false, gestureEnabled: false, presentation: 'fullScreenModal' as const };
  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      {!me ? (
        <>
          <Stack.Screen name="Login" component={LoginScreen} />
          <Stack.Screen name="Register" component={RegisterScreen} />
        </>
      ) : (
        <>
          {resumeSessionId ? (
            // Crash/kill resume: the app always reopens into Activity Mode while a session is active.
            <Stack.Screen name="Live" component={LiveScreen} options={activity} initialParams={{ sessionId: resumeSessionId }} />
          ) : null}
          <Stack.Screen name="Tabs" component={Tabs} />
          <Stack.Screen name="Details" component={DetailsScreen} />
          <Stack.Screen name="Join" component={JoinScreen} options={{ presentation: 'modal' }} />
          <Stack.Screen name="Leaderboard" component={LeaderboardScreen} />
          <Stack.Screen name="AIBuilder" component={AIBuilderScreen} />
          <Stack.Screen name="Customize" component={CustomizeScreen} />
          <Stack.Screen name="Preflight" component={PreflightScreen} />
          <Stack.Screen name="Permissions" component={PermissionsScreen} />
          <Stack.Screen name="Start" component={StartScreen} options={activity} />
          {!resumeSessionId ? <Stack.Screen name="Live" component={LiveScreen} options={activity} /> : null}
          <Stack.Screen name="Map" component={MapScreen} options={{ ...activity, presentation: 'modal' }} />
          <Stack.Screen name="Tasks" component={TasksScreen} options={{ ...activity, presentation: 'modal' }} />
          <Stack.Screen name="Camera" component={CameraScreen} options={activity} />
          <Stack.Screen name="Checkpoint" component={CheckpointScreen} options={{ ...activity, presentation: 'transparentModal' }} />
          <Stack.Screen name="Completion" component={CompletionScreen} options={activity} />
          <Stack.Screen name="Results" component={ResultsScreen} />
          <Stack.Screen name="History" component={HistoryScreen} />
          <Stack.Screen name="SyncStatus" component={SyncStatusScreen} options={{ presentation: 'modal' }} />
          <Stack.Screen name="AIModel" component={AIModelScreen} />
          <Stack.Screen name="QuestStart" component={QuestStartScreen} />
          <Stack.Screen name="Status" component={StatusScreen} />
          <Stack.Screen name="MilestoneHistory" component={MilestoneHistoryScreen} />
          <Stack.Screen name="MilestoneDetail" component={MilestoneDetailScreen} />
          <Stack.Screen name="ModuleBuilder" component={ModuleBuilderScreen} />
          <Stack.Screen name="ModuleDetail" component={ModuleDetailScreen} />
          <Stack.Screen name="Confirm" component={ConfirmScreen} options={{ ...activity, presentation: 'modal' }} />
          <Stack.Screen name="Guilds" component={GuildsScreen} />
          <Stack.Screen name="Party" component={PartyScreen} />
          <Stack.Screen name="PartyHost" component={PartyHostScreen} />
          <Stack.Screen name="PartyJoin" component={PartyJoinScreen} />
          <Stack.Screen name="PartyPlay" component={PartyPlayScreen} options={activity} />
        </>
      )}
    </Stack.Navigator>
  );
}
