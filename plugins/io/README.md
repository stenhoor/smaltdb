# @smaltdb/io

CSV, TSV and JSON for [smaltdb](https://github.com/stenhoor/smaltdb): the `csv`, `tsv` and `json` (`ndjson`, `jsonl`)
formats for external tables, `read_csv()` and `read_json()`, and CSV / JSON import and export. No dependencies.

```sh
npm install smaltdb @smaltdb/io
```

In the browser, install it in your engine worker entry and open the database with that worker:

```ts
// db-worker.ts
import { serve } from 'smaltdb/worker-runtime';
import io from '@smaltdb/io';

serve({ plugins: [io] });
```

```ts
import { open } from 'smaltdb';
import { exportCSV, importCSV } from '@smaltdb/io/client';

const db = await open('app', {
  worker: () => new Worker(new URL('./db-worker.ts', import.meta.url), { type: 'module' }),
});
await importCSV(db, 'people', file, { create: true }); // a string, Uint8Array, ArrayBuffer or Blob
const csv = await exportCSV(db, 'SELECT * FROM people WHERE age > ?', [30]);
```

`importJSON` and `exportJSON` work the same way. Reading files with `read_csv()` / `read_json()` also needs a source,
such as `@smaltdb/external`.

With the in-process engine (Node): `Database.openMemory({ plugins: [io] })` from `smaltdb/engine`; the helpers take
that `Database` too.

See the [plugins guide](https://github.com/stenhoor/smaltdb/blob/main/docs/guide/plugins.md). MIT licence.
