# Changelog

All notable changes to the reference validator. The **specification** versions independently
(`formatVersion`, §11) — a validator release does not imply a spec release, and vice versa.

This project follows [Semantic Versioning](https://semver.org/). For a validator, "breaking"
means: a bundle that verified under the previous version no longer verifies. That is treated as
a serious event, not a routine major bump — the golden bundles in `goldens/` exist to make it
impossible to do by accident.

## [Unreleased]

### Added

- **Golden bundles** (`goldens/`) — three committed, sealed, signed exploded bundles, one per
  format era, with `index.json` pinning each `bundleDigest` and `signing-key.pub.json` carrying
  the verification key. These are the regression corpus for the 36-month support window (spec
  §11). Third parties writing their own consumers are welcome to use them as theirs.
- `goldens/import-matrix.sh` — restores every golden into a database stack (tier 2).
- Apache-2.0 licence for the code; CC BY 4.0 for the specification (`LICENSE-SPEC`).

## [1.0.0-draft] — 2026-08-01

First implementation, written against the frozen `1.0` specification and deliberately
independent of any exporter or importer: it checks the spec, not an implementation.

### Added

- `ember-validate verify` — conformance stages 0–6 (container, digests, manifest, records,
  schemas, references, blobs) plus stage 7, detached-JWS signature verification when a public
  key is supplied.
- `ember-validate info` — manifest summary and `bundleDigest`.
- `ember-validate diff` — per-resource record deltas between two bundles.
- `ember-validate lint` — the adapter-bundle profile (will this survive an `allocate` import?)
  and Import Studio MappingSpec validation.
- Support for both container forms: `.czx` archives (including an inflate-only ZIP reader, so
  there is no dependency) and exploded directories.
- Encrypted-bundle support (`.czx.enc`) with `--passphrase`.
- `schemas/manifest.schema.json` — the normative machine schema for `formatVersion` 1.0.
- `examples/acme-mini` — a hand-written conformant bundle.
- `examples/adapter-csv` — a complete worked third-party adapter: CSV in, conformant bundle
  out, zero dependencies, nothing imported from Charcoal.
