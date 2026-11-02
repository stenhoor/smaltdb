// An application's engine worker with plugins (ADR 0012): the pattern the docs describe.
import parquet from '@smaltdb/parquet';
import { serve } from '../../src/engine/worker-runtime.js';

serve({ plugins: [parquet] });
