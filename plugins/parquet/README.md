# @smaltdb/parquet

The Parquet format for [smaltdb](https://github.com/stenhoor/smaltdb): `read_parquet()` and external tables over
`.parquet` files. Files are decoded with [hyparquet](https://github.com/hyparam/hyparquet). Only the footer, the
columns a statement uses and the row groups its filters cannot rule out are read.

```sh
npm install smaltdb @smaltdb/parquet
# for gzip, zstd, brotli or LZ4-compressed files (Snappy needs nothing more):
npm install hyparquet-compressors
```

In the browser, install it in your engine worker entry and open the database with that worker:

```ts
// db-worker.ts
import { serve } from 'smaltdb/worker-runtime';
import parquet from '@smaltdb/parquet';

serve({ plugins: [parquet] });
```

```ts
import { open } from 'smaltdb';

const db = await open('app', {
  worker: () => new Worker(new URL('./db-worker.ts', import.meta.url), { type: 'module' }),
});
const rows = await db.query("SELECT count(*) AS n FROM read_parquet('https://example.com/trips.parquet')");
```

With the in-process engine (Node): `Database.openMemory({ plugins: [parquet] })` from `smaltdb/engine`.

See the [plugins guide](https://github.com/stenhoor/smaltdb/blob/main/docs/guide/plugins.md). MIT licence.
