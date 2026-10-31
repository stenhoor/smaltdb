/**
 * Runtime capability detection. Baseline browsers (Chrome 108, Firefox 111, Safari 17) only
 * need `syncAccessHandle`; everything else enables optional fast paths (ADR 0002).
 */
export interface Capabilities {
  /** OPFS FileSystemSyncAccessHandle available (dedicated worker only). */
  syncAccessHandle: boolean;
  /** Sync handles support `mode: 'readwrite-unsafe'` (multiple concurrent handles). */
  readwriteUnsafe: boolean;
  /** Page is cross-origin isolated, so SharedArrayBuffer can be shared with workers. */
  crossOriginIsolated: boolean;
  sharedArrayBuffer: boolean;
  atomicsWait: boolean;
  webLocks: boolean;
  sharedWorker: boolean;
  broadcastChannel: boolean;
  /** `new Function` permitted by CSP (enables expression code generation). */
  cspEval: boolean;
  hardwareConcurrency: number;
}

export function detectCapabilities(): Capabilities {
  const g = globalThis as Record<string, unknown> & { navigator?: Navigator };
  const fileHandleProto = (g.FileSystemFileHandle as { prototype?: object } | undefined)?.prototype;
  const syncHandleProto = (g.FileSystemSyncAccessHandle as { prototype?: object } | undefined)?.prototype;
  let cspEval = false;
  try {
    cspEval = new Function('return 1')() === 1;
  } catch {
    cspEval = false;
  }
  return {
    syncAccessHandle: !!fileHandleProto && 'createSyncAccessHandle' in fileHandleProto,
    readwriteUnsafe: !!syncHandleProto && 'mode' in syncHandleProto,
    crossOriginIsolated: g.crossOriginIsolated === true,
    sharedArrayBuffer: typeof SharedArrayBuffer === 'function',
    atomicsWait: typeof Atomics === 'object' && typeof Atomics.wait === 'function',
    webLocks: !!g.navigator && 'locks' in g.navigator,
    sharedWorker: typeof g.SharedWorker === 'function',
    broadcastChannel: typeof g.BroadcastChannel === 'function',
    cspEval,
    hardwareConcurrency: g.navigator?.hardwareConcurrency ?? 1,
  };
}
