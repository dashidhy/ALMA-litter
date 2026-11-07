import { nativeCall } from '../bridge.js';
import { createZCodeProvider } from '@alma/zcode/adapter.js';
import { createNativeZCodeBackend } from '@alma/zcode/native-provider.js';
export const mobileZCodeProvider = createZCodeProvider(createNativeZCodeBackend(nativeCall));
