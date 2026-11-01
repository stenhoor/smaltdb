/// <reference lib="webworker" />
/**
 * Engine worker entry point. Owns the database file (OPFS sync access handles are only available
 * in dedicated workers) and serves the client that created it, plus other tabs over a
 * BroadcastChannel when it is the multi-tab leader (see server.ts, ADR 0009).
 */
import { SmaltError } from './errors.js';
import { EngineServer, defaultOpen } from './server.js';
import { detectCapabilities } from './vfs/capabilities.js';
import { OpfsVfs } from './vfs/opfs.js';
import type { BusMessage, Request, Response } from '../shared/protocol.js';

const scope = self as unknown as DedicatedWorkerGlobalScope;
let bus: BroadcastChannel | null = null;
const leaderId = crypto.randomUUID();

const server = new EngineServer(
  (session: string, msg: Response, transfer: Transferable[] = []) => {
    if (session === EngineServer.LOCAL) scope.postMessage(msg, transfer);
    else bus?.postMessage({ type: 'res', session, res: msg } satisfies BusMessage);
  },
  {
    open: defaultOpen(() => new OpfsVfs()),
    capabilities: detectCapabilities,
    // Another tab holds a lock named after its session for as long as it lives: when we are
    // granted that lock, the tab is gone.
    watchSession: (session) => {
      if (!bus || !navigator.locks) return;
      void navigator.locks.request(`${bus.name}:client:${session}`, () => server.sessionGone(session));
    },
  },
);

scope.onmessage = (e: MessageEvent<Request>) => {
  const req = e.data;
  if (req.op === 'open' && req.bus && !bus) {
    bus = new BroadcastChannel(req.bus);
    bus.onmessage = (ev: MessageEvent<BusMessage>) => {
      const m = ev.data;
      if (m.type === 'hello') bus!.postMessage({ type: 'leader', leader: leaderId } satisfies BusMessage);
      else if (m.type === 'req' && m.leader === leaderId) server.receive(m.session, m.req);
    };
    bus.postMessage({ type: 'leader', leader: leaderId } satisfies BusMessage);
  }
  try {
    server.receive(EngineServer.LOCAL, req);
  } catch (err) {
    const code = err instanceof SmaltError ? err.code : 'SMALT_INTERNAL';
    scope.postMessage({ id: req.id, kind: 'error', code, message: err instanceof Error ? err.message : String(err) } satisfies Response);
  }
};
