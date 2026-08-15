# Golden bundles

These are **sealed artifacts**. Read this before changing anything in this directory.

## What they are for

The Ember specification makes a promise with a number in it:

> An importer **MUST** accept any bundle produced in the preceding 36 months.
> — [spec §11](../spec/ember-bundle-format-1.0.md)

A promise like that decays by default. Nobody sets out to break it. Someone bumps an
entity's `resourceVersion` because its shape genuinely changed, ships, and the bundles a
customer downloaded eighteen months ago quietly stop being importable. Nothing fails,
because the old bundles live on customers' disks and not in this repo — there is no test
that *could* fail.

So they live in this repo. Each directory here is one committed, signed, exploded bundle
representing one **(formatVersion × significant resourceVersion era)**, and CI asserts on
every build that today's code can still read every one of them.

| Golden | Era | What it holds that the others don't |
|---|---|---|
| `1.0-minimal` | 1.0 minimal | The smallest conformant bundle — hand-written against the spec, never produced by the exporter. Catches changes that make a bare-bones bundle unreadable. **Role: `conformance`** — see below. |
| `1.0-full` | 1.0 full-shape | Real exporter output across 8 module databases: embedded children, numbering watermarks, the `resolved/` settings sidecar, per-DB snapshot consistency, pseudonymized values. |
| `1.0-adapter` | 1.0 adapter profile | Written by a **third party**, not by Charcoal — the `migration` profile with the `allocate` id-policy hint, `$source` provenance and control totals. This is the golden that proves the format is writable from outside, which is the entire no-lock-in claim. |

`index.json` is the register: provenance, era, feature list, the **pinned `bundleDigest`**, and
each golden's **role**.

## Roles — what a golden is evidence *about*

| Role | Tier 1 | Tier 2 | Meaning |
|---|---|---|---|
| `importer` | verify + digest + resourceVersion + **field compatibility** | imported into a real stack | A bundle Charcoal's exporter produced. These carry the 36-month promise. |
| `conformance` | verify + digest + resourceVersion | skipped (and *printed* as skipped) | Evidence about the **validator** — the minimal shape a reader must accept. Never produced by Charcoal, so the support window does not cover it. |

`1.0-minimal` is `conformance`, and the reason is worth knowing. When tier 2 first ran for real
it failed with `column "Code" of relation "companies" does not exist`: the hand-written example
carries `company.Code`, a column that has **never** existed on the Company entity — along with
nine other phantom columns across `purchase_order` and `purchase_order_line`. It was written from
the spec as an illustration, not produced by the exporter, and could never have been imported.

That is the whole argument for tier 2 in one incident. Every no-database check had passed it for
months, because a bundle is internally consistent by construction — its own `schema/*.json`
describes its own records, so checking it against itself proves nothing. Tier 1 now also asks
whether the columns still exist on the *current* entity manifest (`importer` goldens only), which
catches the class without a database; but it was tier 2 that found it.

## The rules

**1. A golden is never regenerated.** Regeneration is precisely the failure the support
window guards against — a golden that gets refreshed whenever a build goes red is a golden
that proves nothing. This is why `index.json` pins each `bundleDigest`: a bundle that was
quietly re-checksummed and re-sealed is internally consistent and verifies perfectly, so it
cannot detect the change about itself. The pin catches it.

**2. A golden changes only when a formatVersion era is added, and that is its own reviewed
commit.** Never bundled with the change that prompted it. If a build is red because a
golden no longer verifies, the bug is in the change, not in the golden.

**3. No private key material, ever.** `signing-key.pub.json` is the **public** half of the
goldens signing key (`kid 76e65bd2ec932008`). The private half lives outside every checkout,
in the machine-local secrets directory — `gitleaks` scans full history, and a private key
that ever touched a commit is burned. The goldens key is deliberately *not* a deployment's
`ember-keygen` key: a golden must stay verifiable offline, on any machine, for at least the
whole 36-month window, with no database anywhere in the picture.

## The two tiers

Honestly scoped, because a green check mark should not be read as more than it is.

### Tier 1 — every build, no database

```bash
node scripts/check-golden-bundles.mjs
```

Wired into CI's `build` job (it reads the entity manifest blessed one step earlier, and needs
platform-bundle's built `dist/`). For every golden it asserts:

- it still **verifies** — validator stages 0–6 clean, plus a real signature check against
  `signing-key.pub.json`;
- its `bundleDigest` still matches the pin in `index.json`;
- every resource it carries is still **readable by today's platform** — either the current
  `resourceVersion` equals the golden's `$v`, or a registered migration chain covers the gap
  (Charcoal's record-migration registry);
- for `importer` goldens, every **column** its records carry still exists on the current entity
  manifest. Version equality is not sufficient — `1.0-minimal` declares `company` at version 1,
  the entity *is* at version 1, and the golden still carries a `Code` column that has never
  existed.

The third check is the mechanical teeth: **a `resourceVersion` bumped without its upcaster is
a red build**, which forces the bump and the migration into the same commit.

Tier 1 catches shape drift, and now catches dropped columns too. It still does **not** catch
everything about "would the rows actually go in" — constraints, defaults and FK targets only
answer to a real database. That is tier 2.

### Tier 2 — the database import matrix, every build


Restores every `importer` golden into a real stack and reports per-resource row counts. This is
what actually proves an old bundle goes in.

**It runs in CI** (job `golden-import-matrix`, with a Postgres service). It could not, until
both repos gained `db:provision` — the only documented way to get a stack used to be cloning a
live one (`pg_dump -s core | psql core_test`), and CI has no live deployment. Now each repo
synchronizes its own schema straight from its entity classes, so the stack comes from a
checkout.

A golden with `requiresBase` is layered on top of its base without an intervening truncate:
`allocate` resolves organization and company as anchors against a tenant that must already
exist, so `1.0-adapter` lands on `1.0-full`. That is also how a real adapter migration runs.

The matrix runner itself is not part of this repository: it drives Charcoal's importer against
a multi-database stack, so it would not run anywhere else. What it proves is what matters here —
these exact bundles, the ones in this directory, are restored on every build.

## Adding a golden (a new era)

1. Produce the bundle, or copy it from wherever it was produced.
2. `node scripts/seal-golden-bundle.mjs seal <dir> --key <private-key-path>`
3. Add its entry to `index.json` — including the `bundleDigest` the validator reports, its
   `role`, and `requiresBase` if it needs a tenant to exist.
4. Run tier 1 and tier 2.
5. Commit it **alone**, with the era and the reason in the message.
