/**
 * Registers the SQL language with the engine. smaltdb's entry points (index.ts, worker-runtime.ts) import this, so a
 * database reads SQL; engine code itself never imports the language (ADR 0015 step 9, test/boundary.test.ts).
 */
import { registerLanguage } from '../language-support.js';
import { sqlLanguage } from './language.js';

registerLanguage(sqlLanguage);
