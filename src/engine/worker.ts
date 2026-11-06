/**
 * The default engine worker (smaltdb/worker): the engine with no language and no plugins, which runs statements given as
 * plans. A language gives its own worker (smaltql's `smaltql/worker`), and an application with plugins writes its own
 * entry with `defineWorker({ languages, plugins })` from smaltdb/worker-runtime (ADR 0012, 0015).
 */
import { serve } from './worker-runtime.js';

serve();
