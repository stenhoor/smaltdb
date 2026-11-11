# ADR 0027: View interfaces in the engine

- **Status:** proposed
- **Date:** 2026-11-11
- **Issue:** #188 (proposal E10 from smaltts)
- **Builds on:** [ADR 0015](0015-smaltql.md) (smaltql, §8: no new SQL syntax), [ADR 0016](0016-plan-api-for-every-language.md)
  (the plan API, schema operations and the catalog), [ADR 0018](0018-bool-and-nan.md)–[0020](0020-lists-and-structs.md)
  (the types), and smaltts [ADR 0023](https://github.com/stenhoor/smaltts/blob/main/docs/adr/0023-the-smaltts-language.md)
  (decisions 5 and 7: reflecting and interface views; interfaces enforced by the engine)

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

1. **An interface is a view's typed column list, captured when the view is created.** A plain or materialized view
   created with `columns` declares an interface; the engine binds the view once (as it does now to check the list's
   length) and stores, beside the names, each column's plan type and whether it can be NULL, as the view gives them
   then. A view without `columns` reflects, as today. No new syntax in any language: the column list is the
   declaration (ADR 0015 §8); its types come from the view's query.
2. **Every schema operation is checked against the interfaces it could break.** After `alterTable` (every action),
   `drop` of a table, view or materialized view, and `createTable` or `createView` of a name an interface view reads, the engine binds each interface view that read something the operation touched, through the view's
   language, and compares what it gives with its stored interface:
   - the same number of columns, in order (the names are the interface's own, whatever the query calls them);
   - each column's type the same, or converted **losslessly** (decision 3), in which case the view applies the
     conversion from then on (its plan casts the column);
   - a column that could not be NULL may become nullable only if the interface allows NULL.

   Anything else refuses the operation, before it changes anything, with an error that names the view, the column and
   the change (`schema change breaks the interface of view daily: column total: real → integer is not lossless`). The
   existing check for views without an interface (they must still plan) stays as it is.
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
5. **Materialized views keep their stored columns' types.** An interface materialized view is checked as a plain one;
   its stored rows already have the interface's types, and a refresh converts with the same casts. A reflecting
   materialized view whose shape changes is refused as today, until E9 (refresh that adapts its stored columns) lets it
   be recreated.
6. **The catalog shows interfaces.** `CatalogView` and a materialized view's `CatalogTable` gain `interface`: its
   columns with names, types and nullability. A view's definition still round-trips (ADR 0016 §7).

## Steps

1. The conversion table in `smaltdb/plan`, with its tests (each pair, and lists and structs element by element).
2. Interfaces captured on `createView` with `columns`, stored with the view's definition, shown in the catalog.
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
- Some DDL that succeeds today is refused, but only where a view declared an interface that the DDL would break. Views
  without a column list behave exactly as before.

## Open points (for the owner)

1. **Views that already have a column list.** Databases made before this record have views with `columns` but no
   stored types. Should they become interfaces when the engine first binds them after an upgrade (their types captured
   then), or stay reflecting until they are created again? *Recommendation:* capture on first bind, so every column
   list means the same thing; a view that doesn't bind stays without an interface until it does.
2. **Nullability.** Should the interface record nullability (decision 1, and the NOT NULL rows of §8.3), or types only?
   *Recommendation:* record it: a nullable column appearing where `NOT NULL` was promised breaks readers just as a type
   change does.
3. **Typed column lists in SQL** (smaltts DESIGN.md open question 2): should smaltql also accept declared types in the
   list (`CREATE VIEW v(a INTEGER, b REAL) AS …`), as a smaltql addition? *Recommendation:* not in this record; the
   captured types serve both languages, and smaltts can declare types through its own API.
4. **`cascade` in smaltts:** smaltts's change sets list the interface views a step would drop and require `prune`
   (as for tables), or refuse? *Recommendation:* list them in the step's diagnostics and drop them only with `prune`.
