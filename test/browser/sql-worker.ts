// An engine worker that reads SQL (smaltql's language, as `@smaltworks/smaltql/worker` is): the tab tests open databases with it.
import { sqlLanguage } from '@smaltworks/smaltql';
import { defineWorker } from '../../src/engine/worker-runtime.js';

defineWorker({ languages: [sqlLanguage] });
