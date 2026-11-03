# smaltdb

An embedded SQL database for browsers, written in TypeScript: the engine runs in a Web Worker, data lives in OPFS,
and the SQL dialect follows SQLite. Published on npm as `smaltdb`.

## Commands

| Command | What it does | When |
|---|---|---|
| `npm run check` | `npm run typecheck` then `npm test` (vitest): what CI's `test` job runs | Before every commit |
| `npm run test:browser` | Builds `dist/`, then runs the browser integration tests (Playwright). CI runs them on Chromium, Firefox and WebKit | Changes to the client, worker, server, OPFS or multi-tab code |
| `npm run slt` | The sqllogictest subset (122k records) | Changes to the parser, planner, expressions or functions |
| `npm run bench` | Storage micro-benchmarks in Node (`bench:browser` compares engines in a browser) | Performance work; compare with `bench/results/` |
| `npm run docs:dev` | The docs site (VitePress) with live reload; `npm run docs:build` fails on dead links | Docs changes |
| `npm run build` | `dist/` (client, worker, engine), type declarations, and every `plugins/*` workspace | Packaging and release checks |

Playwright is resolved globally in local containers (see `test/browser/playwright.mjs`); do not run
`playwright install` locally.

## Repo map

- `src/client/`: the `smaltdb` client (`open()`, `Database`). `src/engine/`: the engine (SQL in `sql/`, planner and
  execution in `exec/`, B-trees, pager and WAL in `storage/`, catalog, VFS, worker server and runtime). `src/shared/`:
  the worker protocol.
- `plugins/*`: optional packages (`@smaltdb/parquet`, …) as npm workspaces. ADR 0012 moves each to its own repository.
- Read before changing things: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/TESTING.md](docs/TESTING.md),
  [docs/ROADMAP.md](docs/ROADMAP.md), and the decisions in [docs/adr/](docs/adr/README.md). A significant decision
  gets a new ADR.

## Lessons from CI failures

- **Lockfile.** Adding or changing a `plugins/*` workspace or any dependency means running `npm install` and
  committing `package-lock.json`. Otherwise `npm ci` fails and no tests run.
- **Docs examples are tests.** `test/docs-examples.test.ts` runs every SQL example in `docs/guide` and
  `docs/reference` and type-checks the TypeScript ones, so a docs or engine change can fail it.
- **No fixed sleeps in tests.** Wait with `until()` / `pause()` from `test/helpers/wait.ts` (see TESTING.md).

## Working rules

- One task per branch and PR. Don't add unrelated work to an open PR: it holds up everything else in it.
- Mark unfinished work clearly, and open a PR only when CI passes.
- Read review comments on your PR and answer them with commits that say what they address.
- When a PR depends on another repo's PR, say so in its description: `Depends on: stenhoor/smalt-brand#2`.
- Probe tests (`test/zz-*.test.ts`) are scratch files: delete them, never commit them. Don't reformat files with
  Prettier.

## Cross-repo impact

- smaltui and smaltbi depend on the `smaltdb` npm package (`^0.8.3`). Changes to the public API or the plugin
  interface can break them when they upgrade: a PR that makes one says what consumers must change.
- Brand assets and voice come from `stenhoor/smalt-brand`: use it as the source instead of editing copies by hand.
- Merging to `main` redeploys the docs site (smaltdb.dev) when `docs/`, `package.json` or `package-lock.json` change
  (`.github/workflows/docs.yml`).
