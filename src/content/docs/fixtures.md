---
title: Fixtures and state schema for Wraith twins
description: "Seed a Wraith twin's CRUD state from disk: the directory-form fixture set (fixture.json + patches/), the legacy flat-file form, fixture-set selection with --fixture, and the state/schema.json entity_types contract that gates what gets loaded."
---

Fixtures seed a twin's stateful CRUD store with starting data so a freshly served twin already has customers, orders, or whatever entities your tests expect to exist. They live under `state/fixtures/` in the twin workspace and are loaded per session, not globally.

For parallel agent runs that select fixtures per session at runtime, see
[Sandboxing agents with Wraith](/sandboxing-agents/).

A fixture only loads if its entity type is declared in `state/schema.json`. The two halves are coupled: the schema names the entity types and their primary keys; the fixtures supply the records. Records for an undeclared entity type are silently skipped.

## Where fixtures live

```
twins/<name>/
  state/
    schema.json        # entity-type declarations (primary keys, indexes, FKs)
    fixtures/          # seed data, one fixture SET per subdirectory
      default/
        fixture.json
        patches/
          customers.patch.json
```

## Two on-disk forms

Wraith reads two fixture-set layouts. Each subdirectory under `state/fixtures/` is one **fixture set**, named after the directory. A set is loaded in whichever form it's authored in — the loader auto-detects by looking for a `fixture.json`.

### Directory form (preferred)

A fixture set that contains a `fixture.json` is in the directory form:

```
state/fixtures/checkout-happy-path/
  fixture.json
  patches/                       # optional
    customers.patch.json
```

`fixture.json` is a single JSON object:

```json
{
  "parent": "base:default",
  "description": "checkout scenario",
  "entities": {
    "customers": [
      { "id": "cus_1", "name": "Alice" }
    ],
    "orders": []
  }
}
```

- `entities` — object keyed by entity type. Each value is an **array of records**. Each record is a plain JSON object that must carry the entity type's primary-key field (`id` by default; see the schema below). Optional; defaults to empty.
- `parent` — optional. A fully-qualified, namespaced reference to another fixture set (e.g. `"base:default"`). When present, this set inherits the parent's entities and overlays its own on top. Resolved at serve time.
- `description` — optional, informational only. Not consumed by the runtime.

`fixture.json` is parsed strictly: any unrecognized top-level key is an error. Do not add a `name` field — the set name is always the directory name.

### Legacy flat-file form

A fixture set with **no** `fixture.json` is read in the legacy form: every `<entity_type>.json` file at the top of the set directory becomes one entity type, keyed by the filename stem. Each file is a **JSON array of records**:

```
state/fixtures/default/
  customers.json     # -> entity type "customers"
  orders.json        # -> entity type "orders"
```

```json
// customers.json
[
  { "id": "cus_1", "name": "Alice" }
]
```

A flat file that is not a top-level JSON array is rejected. This form predates fixture sets and is supported for backward compatibility; new twins should use the directory form. The legacy form has no `parent`, `description`, or `patches/`.

### The implicit `default` set

When you serve without `--fixture`, Wraith seeds every new session from the `default` fixture set, resolved in this precedence order:

1. `state/fixtures/default/` — if this subdirectory exists, it's the default set (directory or flat-file form inside the subdir).
2. Flat `<entity_type>.json` files directly under `state/fixtures/` — the original pre-set layout, loaded as the legacy form and treated as the `default` set.

If both exist, the explicit `default/` subdirectory wins and the loose flat files are ignored (a warning is logged). If neither exists, sessions start empty.

## Patches

A directory-form set may carry a `patches/` subdirectory. Each file is named `<entity_type>.patch.json` and overlays records onto the set's parent. Patches are applied in deterministic order (sorted by entity type) and only the leaf set's patches are applied.

A patch document is a JSON object with up to three keys, applied left to right (`add` → `replace` → `remove`):

```json
{
  "add": [
    { "id": "cus_2", "name": "Bob" }
  ],
  "replace": {
    "cus_1": { "id": "cus_1", "name": "Alice Updated" }
  },
  "remove": ["cus_3"]
}
```

- `add` — array of records to append. Each must be a JSON object.
- `replace` — object mapping a primary-key value to a full replacement record. Replacing a record that doesn't exist is a no-op.
- `remove` — array of primary-key values (string/number/bool) to drop. Removing a non-existent key is a no-op.

Any other top-level key (including RFC 6902 `op`/`path`/`value`) is rejected. Primary-key matching uses the entity type's `id` field; a numeric `id` matches its stringified key.

## Selecting a fixture set

By default, serve seeds from the implicit `default` set. To seed from a different set, pass `--fixture`:

```sh
wraith serve composite --fixture checkout-happy-path
```

`--fixture <NAME>` seeds every newly created session namespace from `state/fixtures/<NAME>/` instead of `default`. It accepts a namespaced form `<overlay-ns>:<NAME>` and resolves an exact namespaced set before falling back to the bare name. An unknown fixture name exits `1` and lists the available set names.

Fixtures are seeded **per session**: the first request carrying a given `X-Wraith-Session` header value creates a namespace and seeds it once. Subsequent requests on that session reuse the already-seeded state. Requests without the header share a single default namespace.

## The `state/schema.json` contract

`state/schema.json` declares the entity types the twin's CRUD store knows about. It gates fixture loading: a fixture record whose entity type isn't declared here is skipped.

```json
{
  "schema_version": 1,
  "entity_types": {
    "customers": {
      "primary_key": "id",
      "id_format": "cus_[a-zA-Z0-9]{14}",
      "indexes": [
        { "field": "email", "type": "equality" }
      ],
      "foreign_keys": [
        { "field": "default_source", "references": "cards.id" }
      ]
    }
  }
}
```

- `schema_version` — must be `1`.
- `entity_types` — object keyed by entity type name. Each entry:
  - `primary_key` — required. The record field used as the identity (commonly `"id"`). Fixture records must carry this field, and its value must be a string.
  - `id_format` — optional regex describing generated IDs.
  - `indexes` — optional array of `{ "field", "type" }` where `type` is `"equality"` or `"range"`.
  - `foreign_keys` — optional array of `{ "field", "references" }` where `references` is `"entity_type.field"`.

Entity types are also derived automatically from the synthesized model's routes. `state/schema.json` **adds** author-declared types on top — useful for entities that fixtures seed but no route references directly (so Lua handlers and fixtures can still address them). When a route-derived type and a declared type collide, the route-derived definition wins.

A missing or unparseable `state/schema.json` is non-fatal: the twin serves with a route-only schema, and fixtures for any type not in that schema are skipped.
