// Polyfill crypto.getRandomValues (UUIDv7) before anything else.
import 'react-native-get-random-values';
// Background tasks must be defined at module scope, before the app renders.
import './src/platform/location-task';
import './src/platform/background-sync';
import { registerRootComponent } from 'expo';
import App from './src/app/App';

registerRootComponent(App);
