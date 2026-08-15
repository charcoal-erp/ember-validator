# ember-validator

Reference validator for the **Ember bundle format** (`.czx`) — the open format Charcoal ERP
exports a customer's data into, and imports it back from.

**Zero dependencies. Node ≥ 18. Nothing to install.** It has to run on a departing customer's
laptop against a bundle they were handed, so it depends on nothing, phones nowhere, and is
written against the specification rather than against Charcoal's exporter — it checks the
spec, not the implementation.

```bash
git clone https://github.com/charcoal-erp/ember-validator
node ember-validator/bin/ember-validate.mjs verify ./my-bundle.czx
```

## Commands

```bash
ember-validate verify <bundle.czx | exploded-dir> [--strict] [--pubkey <key.json>]
ember-validate info   <bundle.czx | exploded-dir>
ember-validate diff   <bundleA> <bundleB>
ember-validate lint   <bundle.czx | exploded-dir>
ember-validate lint   <mapping-spec.json>
```

`verify` runs conformance stages 0–6 and exits non-zero on any error:

| Stage | Checks |
|---|---|
| 0 Container | archive/directory readable; `manifest.json` + `checksums.sha256` present |
| 1 Digests | every checksum line matches its file; no uncovered files; `bundleDigest` computed |
| 2 Manifest | schema-valid; `formatVersion` supported; resource files exist; `dependsOn` is a DAG |
| 3 Records | valid JSON per line; canonical bytes; envelope keys; sorted by `$id`; counts and hashes match the manifest |
| 4 Schemas | every record validates against its resource's JSON Schema |
| 5 References | every typed reference resolves in-bundle |
| 6 Blobs | every referenced blob is present and hashes to its address |

Pass `--pubkey` to also verify the bundle's detached signature (stage 7). Without a key, a
signature is reported as present-but-unverified rather than silently accepted.

`--strict` additionally fails on warnings.

**`lint` on a bundle asks a different question from `verify`** — not "is this conformant?" but
"will it survive an import into a live tenant with `--id-policy allocate`?" It checks
`$source{system, externalId}` on every non-anchor record and unique across the bundle (without
it, a re-run duplicates data), the `allocate` id-policy hint, organization/company anchors
carrying the natural keys the importer resolves them by, catalog references resolvable through
`catalog/`, and control totals. Adapter authors run both; `lint` never replaces `verify`.

## The specification

[`spec/ember-bundle-format-1.0.md`](spec/ember-bundle-format-1.0.md) is normative and
self-contained — writing an adapter needs only that document and this validator. Key words are
RFC 2119.

## Goldens — the 36-month support window

The spec makes a promise: **an importer MUST accept any bundle produced in the preceding 36
months** (§11). `goldens/` is how that is enforced mechanically rather than by intention —
sealed, signed bundles, one per format era, which Charcoal's CI verifies on every build and
asserts are still readable at current resource versions. A version bumped without a registered
migration is a red build.

They are committed here rather than kept internal for two reasons: you can see the promise is
real, and if you are writing your own consumer they make a ready-made regression corpus.

```bash
node bin/ember-validate.mjs verify goldens/1.0-full --pubkey goldens/signing-key.pub.json
```

`goldens/index.json` records each one's provenance and pins its `bundleDigest`.
See [`goldens/README.md`](goldens/README.md) — they are **sealed artifacts**, not fixtures to
regenerate.

## Examples

- `examples/acme-mini/` — a hand-written, conformant exploded bundle. After editing it, re-seal
  the digest chain with `node examples/build.mjs`.
- `examples/adapter-csv/` — a complete worked third-party adapter: CSV in, conformant bundle
  out, zero dependencies, nothing imported from Charcoal. Start here if you are writing a
  producer.

```bash
node --test test/*.mjs   # the validator's own self-tests, incl. zip round-trip and chaos cases
```

## Licence

Code: **Apache-2.0** ([`LICENSE`](LICENSE)) — with its patent grant, because you should be able
to implement this without asking.
Specification: **CC BY 4.0** ([`LICENSE-SPEC`](LICENSE-SPEC)) — because a format nobody else may
reimplement is not a portability guarantee.

## Contributing and governance

Charcoal ERP owns the specification; the change process is in §14 of the spec. Issues and pull
requests are welcome on this repository.

> **Note for Charcoal engineers:** this repository is a **mirror**. The canonical source is
> `packages/ember-validator` in the `backends` repo — make changes there and re-run
> `scripts/publish-ember-validator.sh`. Do not commit directly to the mirror; it will be
> overwritten.
