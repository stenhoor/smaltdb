// An application's engine worker with plugins (ADR 0012) and a language (ADR 0015): the pattern the docs describe.
import external from '@smaltdb/external';
import io from '@smaltdb/io';
import { sqlLanguage } from '@smaltworks/smaltql';
import { defineWorker } from '../../src/engine/worker-runtime.js';

// SQL as given to defineWorker, marked so the page can tell it is the language this worker registered: it reads
// smalt_worker_language() as the string 'defineWorker'.
const mark = (text: string): string => text.replaceAll('smalt_worker_language()', "'defineWorker'");
const sql = { ...sqlLanguage, parse: (text: string) => sqlLanguage.parse!(mark(text)), parseOne: (text: string) => sqlLanguage.parseOne!(mark(text)) };

// `?readers=proxy` (the client test's second run): readers read the owner's files through it (ADR 0021);
// `?readers=off`: no parallel readers (measurements).
const readers = new URL(self.location.href).searchParams.get('readers');
defineWorker({ languages: [sql], plugins: [external, io], parallelReaders: readers === 'proxy' || readers === 'off' ? readers : 'auto' });
