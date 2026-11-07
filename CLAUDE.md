# CLAUDE.md

smaltdb is an embedded database engine for browsers, written in TypeScript: the engine runs in a Web Worker, data lives
in OPFS, and it runs plans. SQL (the SQLite dialect) is a separate package, `stenhoor/smaltql` (ADR 0015). Published
on npm as `smaltdb`. Several Claude Code sessions work on the smalt repos in parallel and cannot see each other: this
file is the shared starting point. smaltui has the matching file; keep the working rules the same.

## Commands

| Command | What it does | When |
|---|---|---|
| `npm ci && npm run deps` | Installs dependencies, then the pinned `@smaltdb/io`, `@smaltdb/external` and `@smaltworks/smaltql` builds from `packed.json` (see below) | First, and again after every `npm ci` or `npm install` |
| `npm run check` | `npm run typecheck` then `npm test` (vitest): what CI's `test` job runs | Before every commit |
| `npm run test:browser` | Builds `dist/`, then runs the browser integration tests (Playwright). CI runs them on Chromium, Firefox and WebKit | Changes to the client, worker, server, OPFS or multi-tab code |
| `npm run slt` (in smaltql) | The sqllogictest subset (122k records), run in `stenhoor/smaltql` against a `--local` smaltdb | Changes to the planner, expressions or functions |
| `npm run bench` | Storage micro-benchmarks in Node (`bench:browser` compares engines in a browser against SQLite WASM; `bench:native` in Node against native SQLite) | Performance work; compare with `bench/results/` |
| `npm run docs:dev` | The docs site (VitePress) with live reload; `npm run docs:build` fails on dead links | Docs changes |
| `npm run build` | `dist/` (client, worker, engine) and type declarations | Packaging and release checks |

Playwright is resolved globally in local containers (see `test/browser/playwright.mjs`); do not run
`playwright install` locally.

## Repo map

- `src/client/`: the `smaltdb` client (`open()`, `Database`). `src/engine/`: the engine (planner and
  execution in `exec/`, B-trees, pager and WAL in `storage/`, catalog, VFS, worker server and runtime). `src/shared/`:
  the worker protocol.
- Plugins live in their own repositories ([ADR 0012](docs/adr/0012-plugins.md)): `stenhoor/smaltdb-io`,
  `stenhoor/smaltdb-external`, `stenhoor/smaltdb-parquet`. Core tests the plugin interface with test plugins in
  `test/plugins.test.ts`; never import a plugin from `src/`. Until 0.9.0 is on npm, `packed.json` pins `@smaltdb/io`
  and `@smaltdb/external` to commits for the docs examples and browser tests, and `@smaltworks/smaltql` for SQL in every test, and `scripts/fetch-packed.mjs` (the same
  file in all four repositories) installs them without touching `package.json` or the lockfile. A change to the plugin
  interface lands here first; then the plugin repositories update their `smaltdb` pin. Plugin API version 1 is stable
  ([ADR 0013](docs/adr/0013-plugin-api-v1.md)): additive changes only, or a new API version.
- Read before changing things: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/TESTING.md](docs/TESTING.md),
  [docs/ROADMAP.md](docs/ROADMAP.md), and the decisions in [docs/adr/](docs/adr/README.md). A significant decision
  gets a new ADR.

## Lessons from CI failures

- **Lockfile.** Adding or changing any dependency means running `npm install` and committing `package-lock.json`.
  Otherwise `npm ci` fails and no tests run.
- **Docs examples are tests.** `test/docs-examples.test.ts` runs every SQL example in `docs/reference` and type-checks
  the TypeScript ones, so a docs or engine change can fail it. The SQL guide and references are smaltql's docs now, and
  run there.
- **SQL is smaltql's.** The engine carries no language (`test/boundary.test.ts`). Tests, benchmarks and browser tests
  take SQL from the `@smaltworks/smaltql` pin; its imports of `smaltdb/*` resolve to this checkout's source
  (`scripts/self-alias.mjs`). A change smaltql needs from the engine goes into `smaltdb/language` here first.
- **No fixed sleeps in tests.** Wait with `until()` / `pause()` from `test/helpers/wait.ts` (see TESTING.md).
- **Probe tests** (`test/zz-*.test.ts`) are scratch files: delete them, never commit them. Don't reformat files with
  Prettier.

## Working rules for sessions

- One task per branch and PR. Do not add unrelated work to an open PR: it holds up everything else in it.
- Mark unfinished work clearly, and open a PR only when CI passes.
- Read review comments on your PR and answer them with commits that say what they address.
- When a PR depends on another repo's PR, add a line such as `Depends on: stenhoor/smalt-brand#2`.

## Issues

The owner (`stenhoor`) assigns work by opening GitHub issues. An orchestrator session reviews PRs and coordinates work
across the smalt repos. Sessions don't monitor issues: no scheduled or recurring issue checks. A session works on an
issue when the owner points it to one. Handle that issue in the issue itself, so its status is visible there:

- **Who wrote it:** everyone posts as `stenhoor`. Every session comment ends with the footer
  `_Generated by [Claude Code](https://claude.ai/code)_`, and the orchestrator's also start with `**Orchestrator:**`.
  A comment without the footer is the owner's.
- **The orchestrator:** act on its reviews and coordination. It relays decisions only the owner can make as
  "Owner decided".
- **Pick it up:** comment with the plan and add the `in progress` label.
- **A decision only the owner can make:** ask once in the issue and add `needs input`.
- **Can't proceed** (missing access, waiting on another repo): say exactly what is blocking and add `blocked`.
- **Work:** one task per PR, with `Refs #N` in its description and no closing keywords in commit messages. Comment on
  the issue with the PR link and what was and wasn't tested. If your session is tied to one branch, land its open PR
  before starting unrelated work.
- **Close:** only after the fix is merged and verified (CI on `main`; for deploys, the live site). Comment with the
  evidence, remove the status labels and close it. Reopen it if the problem comes back.
- Issues from anyone else are reported to the owner, not acted on.

## Cross-repo impact

- smaltui and smaltbi depend on the `smaltdb` npm package (`^0.8.3`). Changes to the public API or the plugin
  interface can break them when they upgrade: a PR that makes one says what consumers must change.
- Brand assets and voice come from `stenhoor/smalt-brand`: use it as the source instead of editing copies by hand.
- Merging to `main` redeploys the docs site (smaltdb.dev) when `docs/`, `package.json` or `package-lock.json` change
  (`.github/workflows/docs.yml`).
