---
description: 'Building lists and structs, reading, slicing, sorting, set operations and statistics over lists.'
---

# List and struct functions

A list is a value of type `list<T>`: elements of type `T`, in order, NULLs among them, nested to any depth ([ADR
0020](../../../../adr/0020-lists-and-structs.md)). A struct, `struct<name T, …>`, is named fields in order. A plan
writes a list with [`list_of`](./list_of) and a struct with [`struct_of`](./struct_of): a `lit` can't hold one. Results
give lists as arrays and structs as objects, which these pages print as JSON (`["apple","pear"]`, `{"name":"apple"}`).

- **Typed lists.** A list argument must be typed `list<…>`: a plan that gives one a value of another type, text
  included, is refused when it is compiled (`SMALT_MISMATCH`). A `lit` whose value is `null` may carry a list type.
- **NULL.** A NULL list gives NULL, and so does a NULL count, position or separator, unless a page says otherwise.
- **Positions** count from 0; where a page says so, a negative one counts from the end.
- **Equal elements.** Functions that look for, count or remove repeats compare elements as SQLite compares values, by
  the `binary` collation: `1` equals `1.0`, `'a'` isn't `'A'`, and text never equals a number. Where they count or keep
  distinct elements, NULL is one value.
- **Numbers.** The statistics (`list_sum` to `list_std`) take the non-NULL elements, which must be numbers; text is an
  error when it is met (`SMALT_MISMATCH`).
- **Types.** A function that gives a list of the same elements gives the first list's type; the call declares it as its
  `type`.

A list turns into rows with [`explode`](../../operations/explode), and a group's values into a list with the
[`implode`](../aggregate/implode) aggregate; [`each`](../../expressions/each) runs an expression over each element. The
examples use the sample table `baskets`, whose `items` (`list<text>`) and `counts` (`list<int>`) include an empty and a
NULL list ([sample data](../../sample-data)).

## Functions {#functions}

- [`list_of`](./list_of): A list of its arguments, in order.
- [`struct_of`](./struct_of): A struct of its arguments, as the fields of the call's type.
- [`struct_field`](./struct_field): A struct's field, by its position.
- [`list_len`](./list_len): The number of elements of a list.
- [`list_get`](./list_get): The element at a position of a list, from 0; negative counts from the end.
- [`list_item`](./list_item): The one element of a list of one; any other length is an error.
- [`list_contains`](./list_contains): Whether a list has an element equal to a value.
- [`list_count_matches`](./list_count_matches): The number of elements of a list equal to a value.
- [`list_slice`](./list_slice): The elements of a list from an offset, a given number of them or to the end.
- [`list_concat`](./list_concat): Two lists, one after the other.
- [`list_join`](./list_join): The elements of a list as text, joined by a separator.
- [`list_sort`](./list_sort): The elements of a list in order, NULLs first unless asked otherwise.
- [`list_reverse`](./list_reverse): The elements of a list in reverse order.
- [`list_unique`](./list_unique): The elements of a list without repeats, the first of each, in order.
- [`list_drop_nulls`](./list_drop_nulls): The non-NULL elements of a list.
- [`list_shift`](./list_shift): The elements of a list moved some places later or earlier, NULLs filling the places left.
- [`list_diff`](./list_diff): Each element of a list of numbers less the one some places before it.
- [`list_sum`](./list_sum): The sum of the numbers of a list.
- [`list_mean`](./list_mean): The mean of the numbers of a list.
- [`list_median`](./list_median): The median of the numbers of a list.
- [`list_min`](./list_min): The least number of a list.
- [`list_max`](./list_max): The greatest number of a list.
- [`list_var`](./list_var): The variance of the numbers of a list.
- [`list_std`](./list_std): The standard deviation of the numbers of a list.
- [`list_n_unique`](./list_n_unique): The number of distinct elements of a list.
- [`list_arg_min`](./list_arg_min): The position of the least element of a list.
- [`list_arg_max`](./list_arg_max): The position of the greatest element of a list.
- [`list_all`](./list_all): Whether every non-NULL element of a list is true.
- [`list_any`](./list_any): Whether any non-NULL element of a list is true.
- [`list_gather`](./list_gather): The elements of a list at the positions a list of indexes gives.
- [`list_gather_every`](./list_gather_every): Every n-th element of a list, from an offset.
- [`list_sample`](./list_sample): Elements of a list chosen at random, with or without replacement.
- [`list_union`](./list_union): The elements in either of two lists, each once.
- [`list_intersect`](./list_intersect): The elements in both of two lists, each once.
- [`list_except`](./list_except): The elements of a list that another hasn't, each once.
- [`list_symmetric_except`](./list_symmetric_except): The elements in one of two lists but not both, each once.
- [`list_same_lengths`](./list_same_lengths): The first of several lists, when they all have as many elements; else an error.
