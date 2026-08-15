# Writing an Ember adapter

**Audience:** you have data in some other system — an ERP, an accounting package, a pile of
spreadsheets — and you want it inside Charcoal. This guide is how you turn that data into an
**Ember bundle** that Charcoal's importer will load.

You do not need access to Charcoal's source, its database, or its team. You need three things:

| | |
|---|---|
| The format spec | [`ember-bundle-format-1.0.md`](ember-bundle-format-1.0.md) — frozen at 1.0 |
| The reference validator | `ember-validate` — zero dependencies, Node ≥ 18, checks your output against the spec, not against the importer |
| The JSON Schemas for the resources you are writing | They ship inside every Ember bundle under `schema/`. Ask for a reference export of the target tenant, or take them from `examples/adapter-csv/schema/` |

A complete, runnable adapter lives at
[`examples/adapter-csv/`](../examples/adapter-csv/).
It is ~250 lines of dependency-free Node that turns two CSV files into a conformant bundle, and
everything below is illustrated there. Read this guide with that file open.

---

## 1. The shape of the job

An adapter is a pure function: **source data in, bundle out.** It never talks to Charcoal.

```
legacy CSV/SQL/API  ──▶  your adapter  ──▶  bundle/  ──▶  ember-validate  ──▶  ember-import
                                                             (you run)        (the operator runs)
```

A bundle is a directory (or a zip of one, `.czx`) laid out like this — the example's actual
output:

```
manifest.json                              what this bundle is, and what is in it
checksums.sha256                           sha256 of every other file, sorted by path
data/010-core/vendor.ndjson                one canonical JSON record per line
schema/core.vendor.v1.schema.json          the schema those records validate against
controls/control-totals.ndjson             what the SOURCE system says the totals are
```

## 2. Records

One JSON object per line, no wrapping array, every line newline-terminated. Domain fields are
named **verbatim as Charcoal's own property names** — `VendorCode`, `HQStateCode`, `IsActive`.
No renaming, no snake_case conversion; the schema tells you exactly which names exist, and
`additionalProperties: false` means an invented one is an error.

```json
{"$id":"vendor:0f2c…","$source":{"externalId":"SUP-1001","system":"legacy-purchasing-csv"},"$v":1,"CompanyId":"company:8ab3…","CreditDays":30,"CreditLimit":"500000.00","IsActive":true,"Name":"Hindustan Polymers","VendorCode":"SUP-1001"}
```

Four envelope keys matter to you:

- **`$id`** — `"<resource>:<uuid>"`. Under `allocate` (§4) Charcoal replaces every one of these,
  so the uuid is scratch: its only jobs are to make the bundle self-consistent and to let one
  record point at another. Derive it from the source key rather than randomly, and your bundle
  becomes a pure function of its input — re-running produces byte-identical output, so a diff
  means the *data* changed.
- **`$v`** — the `resourceVersion` you are writing against. It is in the schema's filename
  (`core.vendor.v1.schema.json` → `1`).
- **`$source`** — `{system, externalId}`. **This is the most important field in the file.**
  Section 4 explains why.
- **`$audit`** — optional `{CreatedAt, CreatedBy, …}`. Emit it only if your source really has
  that history. Omit it and Charcoal's own defaults apply.

Three rules that catch everyone:

1. **Canonical JSON.** Object keys sorted, no insignificant whitespace. The validator
   re-serializes your line and byte-compares, so "valid JSON" is not enough.
2. **Records sorted ascending by `$id`** within each file.
3. **Decimals are STRINGS, integers are numbers.** `"CreditLimit": "500000.00"` — as a JSON
   number it round-trips as `500000` and a money column silently loses its scale. Booleans are
   booleans; an empty source cell becomes explicit `null`, never `""`.

## 3. References

Anything pointing at another record is `"<resource>:<uuid>"` — `"VendorId": "vendor:0f2c…"`. Every
such reference **must resolve inside your bundle**, which is what makes it verifiable on its own.
A uuid-valued field that is *not* a reference (an external correlation id) is carried as a bare
uuid with no prefix.

Two exceptions:

- **Catalog references** (`role:`, `permission:`) do not point at data files. Their uuids are
  deployment-local, so they resolve through `catalog/roles.ndjson` by **natural key** (`Name`).
  If you reference a role, ship that file. Most adapters reference none.
- **`$audit` user references** may dangle — the importer drops them to null rather than refusing
  your migration because your legacy "created by" is not a Charcoal user.

## 4. `$source` and the identity map — read this twice

Your records' keys are not Charcoal UUIDs. So the importer runs under the **`allocate`** id
policy: it mints a fresh UUID for every record and records

```
(organization, sourceSystem, resource, externalId)  →  internalId
```

in its `import_identity_map` table. That table is what makes a **re-run idempotent**: the second
time the same bundle is imported, every record resolves through the map to the id it already got,
and nothing is inserted twice.

**A record without `$source{system, externalId}` cannot participate in that.** Import it twice and
you get two of it, under two different UUIDs, with no way to tell which is which. So:

- Every record needs `$source`. The `externalId` is the key in *your* system — verbatim, as a
  string. A row number will do if that is genuinely all you have, but a stable business key
  (`SUP-1001`) is far better: row numbers shift when someone edits the spreadsheet.
- `system` must be **stable forever**. Change it between runs and the next import looks like a
  brand-new migration and duplicates everything.
- Two records must never share `(system, resource, externalId)` — they would map to one row and
  one of them would be silently lost. The lint catches this.

Declare the policy in the manifest so the operator knows how to load your output:

```json
"options": { "idPolicyHint": "allocate" }
```

## 5. The organization and its companies are ANCHORS

Your data goes into a tenant that **already exists**. So your bundle *names* the organization and
any company it references — which is what lets every reference resolve and the bundle verify on
its own — and the importer **resolves** them against the target instead of inserting them:

| Anchor | Resolved by |
|---|---|
| `organization` | `Code` |
| `company` | `Name` — companies genuinely have no Code column on this platform |

Anchor records carry no `$source` (there is nothing to allocate) and need only their natural key
to be right. A company your bundle names and the target does not have is a hard refusal: creating
a second, empty "Acme Pharma" beside the real one is the worst thing an import could do quietly,
so it is made impossible rather than discouraged.

## 6. Control totals

`controls/control-totals.ndjson` is optional and you should write it anyway:

```json
{"basis":"count of rows in vendors.csv","control":"vendor_count","legacyValue":"4","tolerance":"0"}
```

These come from the **source** system — a vendor count, a trial-balance total, an open-AR figure.
The importer's verify stage checks what actually landed against them, and any variance has to be
explicitly accepted by a person. It is how a migration proves it did not quietly drop rows, and
it is the first thing a finance lead asks for.

## 7. The loop

```bash
node build.mjs                                   # your adapter

node ember-validate.mjs verify bundle            # is it a conformant Ember bundle?
node ember-validate.mjs lint   bundle            # will it survive an allocate import?
```

**`verify`** runs the spec's conformance stages 0–6: container, digests, manifest, canonical
records, schemas, references, blobs. Aim for **0 errors**; warnings are worth reading.

**`lint`** is the adapter profile — a narrower, later question that `verify` deliberately does not
ask, because a bundle can be perfectly conformant and still wrong for this job:

| Lint rule | Because |
|---|---|
| `options.idPolicyHint` is `allocate` | it is your only machine-readable way to tell the operator how to load the bundle |
| every non-anchor record has `$source{system, externalId}` | without it a re-run duplicates that record |
| no two records share a source key | both would map to one row; one would be lost |
| an `organization` anchor is present, with its natural key | otherwise nothing resolves the tenant |
| every catalog reference has a `catalog/` entry carrying its natural key | a role uuid from your machine means nothing on the target |
| `controls/` present | *(warning)* — see §6 |

Run **both**. Lint does not replace verify.

## 8. Handing it over

The operator runs:

```bash
ember-import <your-bundle> --id-policy allocate --execute
```

What Charcoal guarantees in return:

- **Nothing is loaded until the whole bundle passes verification.** Stages 0–6 run first; a
  failure means nothing was written.
- **References are rewritten, never guessed.** If any typed reference fails to resolve, the import
  refuses and names the record and column. A foreign uuid is never written into a live column.
- **Re-runs are idempotent** via the identity map (§4). Import the same bundle ten times and the
  tenant has one copy.
- **The whole run is undoable.** Every import writes an `import_runs` ledger row;
  `ember-import --rollback <runId>` deletes exactly what that run created, in reverse dependency
  order — and refuses, listing them, if anything has been transacted against since. Rows the run
  did not create are never touched.
- **Statuses, numbers and audit values are taken as given.** Charcoal does not "helpfully" rewrite
  your data on the way in.

What it does *not* do: create organizations or companies (§5), invent missing required fields, or
accept a bundle whose `formatVersion` is newer than the importer supports.

## 9. When the shape does not fit

- **A field you need is not in the schema.** Then Charcoal has no column for it. Do not smuggle it
  into another field — raise it; the schema is generated from the entity, so the answer is a
  platform change, not an adapter workaround.
- **Your source has rows you cannot map.** Put them in `quarantine/<resource>.ndjson` with a
  `$findings` array. That is the honest record of what was *not* migrated, and it is expected — a
  migration that claims to have moved everything is usually the one that lost something.
- **The data is too dirty to map mechanically.** That is what Import Studio is for (profiling,
  mapping, review). An adapter is the right tool when the source is structured and repeatable.

## 10. Checklist

- [ ] Records canonical, sorted by `$id`, newline-terminated
- [ ] Decimals as strings; nulls explicit; field names verbatim from the schema
- [ ] `$source{system, externalId}` on every non-anchor record, unique, stable
- [ ] `organization` (and any referenced `company`) present as anchors, natural keys correct
- [ ] Every typed reference resolves in-bundle; catalog refs have `catalog/` entries
- [ ] `options.idPolicyHint: "allocate"`
- [ ] `controls/control-totals.ndjson` written from the source system
- [ ] Schemas copied into `schema/`; `checksums.sha256` covers every file, sorted by path
- [ ] `ember-validate verify` → 0 errors
- [ ] `ember-validate lint` → 0 errors
