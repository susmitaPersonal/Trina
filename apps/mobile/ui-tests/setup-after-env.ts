// Cold Babel/coverage caches can make the first render of a file slow; avoid timing flakiness.
import { configure } from '@testing-library/react-native';

configure({ asyncUtilTimeout: 5000 });
jest.setTimeout(20_000);
