// smaltdb carries no language: the tests' databases read SQL from smaltql (ADR 0015), pinned in packed.json.
import { sqlLanguage } from '@smaltworks/smaltql';
import { registerLanguage } from '../src/engine/plan/language.js';

registerLanguage(sqlLanguage);

// Graph indexes (ADR 0040) are checked against their tables after every write, and every query that reads one is run
// again without it, in every test.
process.env.SMALT_GRAPH_INDEX_CHECK = '1';
