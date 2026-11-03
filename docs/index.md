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
      text: Get started
      link: /guide/getting-started
    - theme: alt
      text: Quick start
      link: /guide/quick-start
    - theme: alt
      text: SQL reference
      link: /reference/sql/

features:
  - title: Off the main thread
    details: The engine runs in Web Workers, so queries never block the page.
  - title: Durable on OPFS
    details: Data lives in the Origin Private File System. Commits are atomic and durable through a write-ahead log.
  - title: SQLite-flavoured SQL
    details: The dialect is based on SQLite, so existing SQL knowledge carries over.
  - title: Analytics built in
    details: Columnar tables and materialized views with zone maps, spilling sorts and parallel readers.
  - title: External data
    details: Query CSV, JSON and Parquet files, URLs, S3 and Azure Blob storage with plain SQL, through optional plugins.
  - title: Introspection
    details: An information_schema, plus sqlite_schema and PRAGMA compatibility.
---

## Quick start

```ts
import { open } from 'smaltdb';

const db = await open('app'); // engine runs in a worker, data lives in OPFS
await db.exec('CREATE TABLE IF NOT EXISTS todo(id INTEGER PRIMARY KEY, title TEXT NOT NULL, done INT DEFAULT 0)');
await db.exec('INSERT INTO todo(title) VALUES (?)', ['write docs']);
const rows = await db.query('SELECT id, title FROM todo WHERE done = 0');
```
