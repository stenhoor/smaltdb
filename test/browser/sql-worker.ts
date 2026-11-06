// An engine worker that reads SQL (smaltql's language, as `smaltql/worker` is): the tab tests open databases with it.
import { sqlLanguage } from 'smaltql';
import { defineWorker } from '../../src/engine/worker-runtime.js';

defineWorker({ languages: [sqlLanguage] });
