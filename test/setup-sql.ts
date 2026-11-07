// smaltdb carries no language: the tests' databases read SQL from smaltql (ADR 0015), pinned in packed.json.
import { sqlLanguage } from '@smaltworks/smaltql';
import { registerLanguage } from '../src/engine/plan/language.js';

registerLanguage(sqlLanguage);
