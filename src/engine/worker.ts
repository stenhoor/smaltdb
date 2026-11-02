/**
 * The default engine worker (smaltdb/worker): the engine with no plugins. Applications that use
 * plugins write their own entry with `serve({ plugins })` from smaltdb/worker-runtime (ADR 0012).
 */
import { serve } from './worker-runtime.js';

serve();
