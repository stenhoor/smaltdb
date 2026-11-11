# ADR 0027: View interfaces in the engine

- **Status:** accepted (2026-11-11); steps 1 to 5 done (smaltql's `DROP … CASCADE` in review). The owner's answers are below
- **Date:** 2026-11-11
- **Issue:** #188 (proposal E10 from smaltts)
- **Builds on:** [ADR 0015](0015-smaltql.md) (smaltql, §8: no new SQL syntax), [ADR 0016](0016-plan-api-for-every-language.md)
  (the plan API, schema operations and the catalog), [ADR 0018](0018-bool-and-nan.md)–[0020](0020-lists-and-structs.md)
  (the types), and smaltts [ADR 0023](https://github.com/stenhoor/smaltts/blob/main/docs/adr/0023-the-smaltts-language.md)
  (decisions 5 and 7: reflecting and interface views; interfaces enforced by the engine). It **supersedes** smaltts
  decision 5 for new views: a view no longer reflects by default

## Context

A view either **reflects** what it reads (its columns follow the tables underneath) or declares an **interface**: a
column list that other tools and pipeline steps rely on, by names, order and types. smaltts ADR 0023 decided that the
column list is the declaration in every language: `CREATE VIEW daily(day, total) AS …` in smaltql, `columns: [...]` in
smaltts, the same engine object (`createView.columns`, stored today).

Today the engine protects part of that, whichever language issues the DDL (smaltts DESIGN.md §8.2, checked against
`main`):

| DDL | Today | An interface |
|---|---|---|
| Rename a column a view reads | allowed; the view's source text is edited by its language | holds |
| Drop a column a view reads | refused: after each ALTER the engine plans every view that planned before (`checkViewsAfterAlter`) | holds |
| Change a column's type (a rebuild: drop and recreate the table) | allowed; the view silently gives the new type | lost |
| Drop a table or view a view reads | allowed; the view fails when it is read | lost |
| Drop or replace the view itself | allowed | lost |

smaltts checks its own changes against its interfaces (gate B, smaltts decision 21), but DDL from smaltql or any other
language bypasses smaltts. Only the engine sees every schema operation, so only it can hold the contract.

## Decision

1. **Every view created from now on has an interface: its typed column list, captured when it is created** (the
   owner's decision, 2026-11-11). For a plain or materialized view, in any language, the engine binds the view once
   and stores each column's name, plan type and whether it can be NULL, as the view gives them then. A column list
   (`createView.columns`) names the columns; without one, the names are those the query gives. No new syntax in any
   language (ADR 0015 §8), and no typed lists in SQL: the types always come from the view's query.

   A view that can't bind when it is created (it reads a table created later, or gives the wrong number of columns
   for its names, which SQL allows until the view is read) is **pending**: it is created as before, and its interface
   is captured after the first schema operation that lets it bind (the owner's decision, 2026-11-11). Only a schema
   operation can change whether a view binds, so the interface is always captured and stored inside one.

   **Nullability is conservative** (the owner's decision, 2026-11-11): a column is recorded NOT NULL only when that is
   proven (a NOT NULL column or integer primary key carried through filters, projections, sorts, inner joins,
   groupings and unions; a literal; a `count`). Anything else can be NULL, so a change is never refused because the
   analysis missed that a column can't be NULL.

   **Views made before are grandfathered:** a view stored without an interface keeps today's behaviour, reflecting
   what it reads, until it is dropped and created again (which captures one).
2. **Every schema operation is checked against the interfaces it could break.** After `alterTable` (every action),
   `drop` of a table, view or materialized view, and `createTable` or `createView` of a name an interface view reads, the engine binds each interface view that read something the operation touched, through the view's
   language, and compares what it gives with its stored interface:
   - the same number of columns, in order (the names are the interface's own, whatever the query calls them);
   - each column's type the same, or converted **losslessly** (decision 3), in which case the view applies the
     conversion from then on (its plan casts the column);
   - a column that could not be NULL may become nullable only if the interface allows NULL.

   Anything else refuses the operation, before it changes anything, with an error that names the view, the column and
   the change (`schema change breaks the interface of view daily: column total: real → integer is not lossless`). The
   existing check for grandfathered views (they must still plan) stays as it is.

   As built (step 3):
   - **Inside a transaction the check waits for COMMIT**, as deferred foreign keys do. A type change is a rebuild
     (create a copy, drop the table, rename the copy into its place: SQL has no other way, and smaltts rebuilds so),
     and the views read the table again only once the rename is done. A COMMIT that finds a broken interface fails and
     leaves the transaction open; in autocommit, the statement is refused.
   - **A view without a column list may give more columns than its interface**: a view over `*` gains a column added
     to the table, and keeps the ones it had (Consequences). The engine reads only the interface's columns.
   - **A view whose language isn't registered** in a database can't be bound there, or read: it is not checked there.
   - **Where a column is converted:** the engine casts it where it expands a view (a plan's `scan` of the view).
     smaltql binds a view's SQL itself, so it applies the casts from the interface `getView` now gives (a smaltql
     change); until then a SQL read of such a view gives the column's new type.
3. **The engine owns the conversion table, decided by types alone.** Which type changes are lossless is a property of
   the two types, never of the rows a table holds (smaltts DESIGN.md §8.3): the same type; INTEGER or REAL to NUMERIC;
   INTEGER, REAL, BOOLEAN, the temporal types, LIST and STRUCT to TEXT (the result format); TEXT to BLOB; BOOLEAN to
   INTEGER; DATE to DATETIME; any type to ANY; lists and structs element by element. INTEGER to REAL, REAL to INTEGER,
   anything to a temporal type, and DURATION to INTEGER are not. The table is published in `smaltdb/plan`
   (`conversion(from, to)`: the cast to apply, or none), so smaltts uses the engine's table instead of its own copy
   (`src/conversions.ts`).
4. **Dropping what an interface reads is refused, unless the operation cascades.** `drop` and `alterTable` gain an
   optional `cascade`: with it, the interface views the operation would break are dropped with it (and listed in its
   result); without it, the operation is refused as in decision 2. A view with an interface can itself be dropped, or
   replaced by one with the same interface, like any view: the contract binds what the view reads, not the view's
   owner. smaltql would map `DROP … CASCADE` to `cascade` (a smaltql change, step 4).

   As built: `cascade` drops at once, inside a transaction too (the operation asked for it), and repeats until no
   view's interface is broken (a view dropped breaks the views that read it). The dropped views are listed in the
   in-process run result (`cascaded`). Grandfathered views are not dropped: they keep today's behaviour.
5. **Materialized views keep their stored columns' types.** An interface materialized view is checked as a plain one;
   its stored rows already have the interface's types, and a refresh converts with the same casts. A grandfathered
   materialized view whose shape changes is refused as today.

   As built (step 5): a materialized view always binds when it is created, so its interface is captured then. A refresh
   reads only the interface's columns, converted, as a reshaped view's read does. A view (plain or materialized) over
   external data that isn't loaded when the check runs can't be bound then, and is not checked: its columns are the
   data's. Some engine tests that dropped a table under a materialized view now do it in a transaction (checked at
   COMMIT), or drop the view first.
6. **The catalog shows interfaces.** `CatalogView` and a materialized view's `CatalogTable` gain `interface`: its
   columns with names, types and nullability. A view's definition still round-trips (ADR 0016 §7).

## Steps

1. The conversion table in `smaltdb/plan`, with its tests (each pair, and lists and structs element by element).
2. Interfaces captured on every `createView`, stored with the view's definition, shown in the catalog; grandfathered
   views told apart.
3. The check after every schema operation (decision 2), refusals with their messages, and the casts a view applies.
4. `cascade` on `drop` and `alterTable` (decision 4), and `DROP … CASCADE` in smaltql (a smaltql PR).
5. Materialized views (decision 5), and the docs: the schema and catalog references, and the views guide.

Each step is one PR; smaltts milestone 6 part 2 follows step 3, and its done-when is the same DDL giving the same
result from smaltql and from smaltts.

## Consequences

- An interface holds for every language: a smaltql session can no longer change a type, drop a table, or replace a
  view in a way that silently changes what an interface promised.
- Schema operations that touch what interface views read cost a bind per such view. Views are bound in the order of
  their dependencies, once each; operations that touch nothing an interface reads cost nothing more than today.
- Some DDL that succeeds today is refused: anything that would break a view created from now on. Grandfathered views
  behave exactly as before.
- **No new view reflects.** A view over `SELECT *` keeps the columns it had when it was created: a column added to the
  table doesn't reach it, a renamed column keeps the view's name for it, and a dropped one is refused. To follow a
  table, a view is created again. This supersedes smaltts decision 5 (reflecting by default) and smaltts's
  reflecting views (milestone 6 part 1) for new views; smaltts records the change in its design.

## The owner's answers (2026-11-11)

1. **Views that already exist** are grandfathered: they keep today's behaviour. Every view created from now on gets an
   interface, with or without a column list (decision 1).
2. **Nullability** is part of the interface (decisions 1 and 2).
3. **Typed column lists in SQL** (`CREATE VIEW v(a INTEGER, …)`): not now.
4. **smaltts refuses** a change that would break an interface view, rather than dropping the view (with or without
   `prune`); the views are dropped first, by hand. The engine's `cascade` (decision 4) stays for languages whose users
   ask for it (SQL's `DROP … CASCADE`).
5. **A view that can't bind when created** gets its interface the first time it binds (decision 1).
6. **Nullability** is proven conservatively (decision 1).
