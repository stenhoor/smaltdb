# ADR 0013: Plugin API version 1 is stable

- **Status:** accepted when the PR that adds it is merged (the owner's review)
- **Date:** 2026-11-03

## Context

[ADR 0012](0012-plugins.md) made optional features plugins and kept the plugin interface experimental "until our own
plugins have proven it". Its section 6 sets the condition for declaring it stable as API version 1: all three of our
plugins run on it unchanged from their own repositories. That is now true:
- `@smaltdb/io`, `@smaltdb/external` and `@smaltdb/parquet` live in their own repositories (step 5);
- their code builds against smaltdb's published types and entry points only (`smaltdb/engine`, `callPlugin`), checked
  by each plugin's declaration build. Only some of their tests reach into the engine's source, to drive the engine
  server directly.

Nothing is published before the interface is declared stable (owner's decision, 2026-11-02). Declaring it stable is a
promise to plugin authors, so this record says exactly what is promised.

## Decision

### 1. What API version 1 is

Plugin API version 1 is what [Writing plugins](../reference/api/plugins.md) documents:

- **The types a plugin uses**, exported from `smaltdb/engine`:
  - `SmaltPlugin`, `PluginHost`, `ConnectionTypeSpec`, `PluginMethod`, `MethodContext`, `AskError`;
  - `FormatReader`, `FormatRequest`, `FormatResult`, `FormatColumn`, `RandomAccessFile`;
  - `SourceHandler`, `SourceTarget`, `SourceContext`, `OpenedFile`, `RandomFile`, `ListedFile`;
  - `SqlValue`, `StaticType` and `Zone`, as far as these types use them;
  - the constant `PLUGIN_API_VERSION`.
- **The behaviour those pages describe:**
  - when `setup` runs and what the registration methods accept and refuse;
  - how the engine calls formats and sources, including `pushdown`, patterns, validators and the
    `wholeFileMayHelp` retry;
  - how errors map to codes: a plain `Error` becomes `SMALT_EXTERNAL`, a `SMALT_…` code is kept, and `AbortError`
    becomes `SMALT_INTERRUPT`;
  - `ask` and its `AskError` reasons;
  - `onSessionClosed` ordering.
- **The application side of plugins:**
  - `Database.open(…, { plugins })`, `Database.openMemory({ plugins })` and `serve({ plugins })`;
  - `db.plugins`;
  - `callPlugin(plugin, method, args, options)` and `onPluginMessage(plugin, handler)` on the client `Database`, and
    `callPlugin` on the engine `Database`.

**Not part of it:**
- the engine's internals and the worker protocol between client and engine worker, which are always the same smaltdb
  version;
- the `smaltdb-src/...` imports that our plugins' tests use.

`MethodContext.db` is the engine `Database`. Its own API is the public `smaltdb/engine` API and follows smaltdb's
versioning, not this record.

### 2. How version 1 may change

Within version 1, changes are **additive only**:
- **New optional members** may be added to the interfaces a plugin implements (`SmaltPlugin`, `FormatReader`,
  `SourceHandler`, `OpenedFile`, `RandomFile`, `ConnectionTypeSpec`), and new fields to what the engine passes in
  (`FormatRequest`, `SourceContext`, `MethodContext`). A plugin that ignores them keeps working.
- **New members** may be added to `PluginHost`, and new options to `callPlugin`.
- **Not allowed within version 1:**
  - making an optional member required;
  - removing or renaming a member;
  - changing a member's type in a way existing plugins can't accept;
  - changing documented behaviour.
- **One exception:** a new `AskError` reason or a new value in another string union a plugin only reads. A plugin
  should treat an unknown value like `'failed'` or ignore it, and the reference says so.

Anything else is a **new API version**:
- `PLUGIN_API_VERSION` becomes 2, and a new ADR records why.
- The release notes say what plugins must change.
- An engine that implements version 2 says which versions it still accepts. It refuses others with `SMALT_MISUSE`,
  naming both versions, as it does today.

`test/plugin-api.test.ts` holds a version 1 plugin that implements only the required members and uses every
`PluginHost` member. It type-checks in CI, so a change that would break a version 1 plugin fails it.

### 3. Releases and peer dependencies

Unchanged from ADR 0012:
- Core and smaltdb's own plugins are released together with the same version number.
- Each plugin's peer dependency on `smaltdb` stays limited to the minor version (`>=0.9.0 <0.10.0`).

A wider range, which would let a plugin outlive several smaltdb minors, is possible later without changing this
record's promise. It is the owner's call when publishing.

## Consequences

- **For plugin authors:** the reference is a stable contract. "Not stable yet" notes leave the docs.
- **For us:** a change to the plugin interface now needs a decision: additive within version 1, or a new version. A
  change needed by one of our plugins still lands in smaltdb first (ADR 0012).
- **For the plan:** ADR 0012's step 6 is done when this is accepted. Next is the pre-publish check (pack smaltdb and
  the three plugins, run smaltui and smaltbi against them), then the 0.9.0 release.
