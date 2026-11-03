// An application's engine worker with plugins (ADR 0012): the pattern the docs describe.
import external from '@smaltdb/external';
import io from '@smaltdb/io';
import { serve } from '../../src/engine/worker-runtime.js';

serve({ plugins: [external, io] });
