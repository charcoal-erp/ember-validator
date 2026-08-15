# `adapter-csv` — a worked Ember adapter

The living proof behind
[the adapter guide](../../spec/ember-adapter-guide.md): two
CSV exports from a legacy purchasing system become a conformant `migration`-profile bundle that
`ember-import --id-policy allocate` loads.

```
input/vendors.csv     4 suppliers          the source data, committed
input/contacts.csv    5 contacts
schema/               4 JSON Schemas       what Charcoal hands an adapter author
build.mjs             ~250 lines           the adapter — zero dependencies
bundle/               11 records           the committed OUTPUT, regenerated not hand-edited
```

```bash
node build.mjs
node ../../bin/ember-validate.mjs verify bundle   # 0 errors, 0 warnings
node ../../bin/ember-validate.mjs lint   bundle   # 0 errors, 0 warnings
```

`build.mjs` imports **nothing from Charcoal** — not `@charcoal/platform-bundle`, not the
validator's internals. Node's standard library, the frozen format spec, and the four schemas are
the entire interface. That constraint is the point: if the example needed anything from inside the
platform, the format would not actually be open.

The output is a pure function of the input — scratch `$id`s are derived from source keys, and
`bundleId`/`createdAt` are pinned — so re-running over unchanged CSVs reproduces the committed
bundle byte for byte, and a diff means the data changed. A real one-shot migration would use a
fresh `bundleId` and the real clock.

**The bundle targets the demo tenant** (`ACME` / `Acme Pharma Pvt Ltd`) that
`backends/examples/acme-mini` seeds, so the two compose: seed the fixture, then load this adapter
bundle on top of it. An adapter for a real customer changes `ORG`/`COMPANY` at the top of
`build.mjs` and nothing else about how it works.
