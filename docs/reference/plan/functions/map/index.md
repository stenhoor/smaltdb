---
description: 'Building maps, reading keys and values, merging.'
---

# Map functions

A map is a value of type `map<text, T>`: text keys, each once, to values of type `T` ([ADR
0038](../../../../adr/0038-map-type.md)). A map keeps its entries in key order (by code point), so two maps of the same
entries are equal values and results come back in that order. A plan writes a map with [`map_of`](./map_of): a `lit`
can't hold one. Results give maps as objects, which these pages print as JSON (`{"born":1815,"name":"Ada"}`).

- **Typed maps.** A map argument must be typed `map<text, …>`: a plan that gives one a value of another type is refused
  when it is compiled (`SMALT_MISMATCH`).
- **Keys are text.** A key given as a number or a blob is an error (`SMALT_MISMATCH`), and keys match exactly, by their
  characters.
- **NULL.** A NULL map gives NULL, and so does a NULL key where one is looked up. A key may have a NULL value: the map
  has the key.
- **Values under `any`.** A `map<text, any>` holds values of any type, and a `bool`, list, struct or map in it keeps its
  type ([values under `any`](../any/)).

The properties of a graph's nodes and relationships are maps: the examples use the `props` column of the sample graph's
`node` table, a `map<text, any>` of each person's `name` and `born` ([sample data](../../sample-data)).

## Functions {#functions}

- [`map_of`](./map_of): A map of keys and values given in pairs.
- [`map_from_entries`](./map_from_entries): A map of a list of key and value structs.
- [`map_get`](./map_get): The value of a key of a map, or NULL when the map hasn't the key.
- [`map_contains_key`](./map_contains_key): Whether a map has a key.
- [`map_len`](./map_len): The number of entries of a map.
- [`map_keys`](./map_keys): The keys of a map, in key order.
- [`map_values`](./map_values): The values of a map, in key order.
- [`map_entries`](./map_entries): The entries of a map as a list of key and value structs, in key order.
- [`map_merge`](./map_merge): The entries of two maps; where both have a key, the second map's value.
- [`map_remove`](./map_remove): A map without some keys.
