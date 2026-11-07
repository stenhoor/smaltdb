---
layout: home

hero:
  name: 'sm<span class="alt">alt</span>db'
  text: Small. Alternative. Fast.
  tagline: A fast alternative database for the browser, written in TypeScript.
  image:
    light: /grain-mark.svg
    dark: /grain-mark-on-dark.svg
    alt: smaltdb
  actions:
    - theme: brand
      text: SQL with smaltql
      link: https://stenhoor.github.io/smaltql/
    - theme: alt
      text: The engine
      link: /reference/engine/
    - theme: alt
      text: Engine API
      link: /reference/api/engine

features:
  - title: Off the main thread
    details: The engine runs in Web Workers, so queries never block the page.
  - title: Durable on OPFS
    details: Data lives in the Origin Private File System. Commits are atomic and durable through a write-ahead log.
  - title: Multiple languages
    details: 'The engine runs plans; languages build them: <a href="https://stenhoor.github.io/smaltql/">smaltql</a> for SQL and <a href="https://stenhoor.github.io/smaltdf/">smaltdf</a> for dataframes, both in development, and a typed API, smaltts, planned. <a href="/reference/engine/languages">Write your own</a>.'
  - title: Analytics built in
    details: Columnar tables and materialized views with zone maps, spilling sorts and parallel readers.
  - title: External data
    details: CSV, JSON and Parquet files, URLs, S3 and Azure Blob storage, through optional plugins.
  - title: A cost-based planner
    details: Access paths, join order and decorrelated subqueries, chosen by cost for every plan whoever built it.
---

## Use it

For a SQL database in a page, use [smaltql](https://stenhoor.github.io/smaltql/): its `open()` starts this engine in
a worker with SQL registered.

```ts
import { open } from '@smaltworks/smaltql';

const db = await open('app'); // the engine runs in a worker, data lives in OPFS
await db.exec('CREATE TABLE IF NOT EXISTS todo(id INTEGER PRIMARY KEY, title TEXT NOT NULL, done INT DEFAULT 0)');
const rows = await db.query('SELECT id, title FROM todo WHERE done = 0');
```

To build plans yourself, or to write a language, start with [the engine](./reference/engine/).
