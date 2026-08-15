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

So we keep a copy of a real export here, and CI checks on every build that today's code can
still read it.

## Pre-GA scope — read this before adding anything

**The 36-month window counts bundles issued to CUSTOMERS, and there are none yet.** So this
directory guards nothing contractual today and is deliberately minimal: **one** bundle, checked
as a cheap smoke test.

**The real corpus starts at first general-availability release** — seal one bundle from the
*production* exporter as era zero. That is when the clock has something to count, when the
database-restore tier is worth putting back in CI, and when clause 3 of the commitment draft
becomes offerable.

Two pre-production fixtures were retired from the corpus on 2026-08-15 for exactly this reason.
They were hand-written or synthetic rather than exporter output — which is precisely how one of
them came to carry ten columns that have never existed on the entities. Both still live as
validator examples under `../examples/`, which is what they always really were.

| Golden | Era | Why it is here |
|---|---|---|
| `1.0-full` | 1.0 full-shape | Real exporter output across 8 module databases: embedded children, numbering watermarks, the `resolved/` settings sidecar, per-DB snapshot consistency, pseudonymized values. Genuine evidence that the shipping exporter and shipping validator agree. |

`index.json` is the register: provenance, era, feature list, the **pinned `bundleDigest`**, and
each golden's **role**.

## Roles

A golden carries `role: importer` — a bundle Charcoal's exporter actually produced, and therefore
real evidence about imports. The distinction exists because a hand-written illustration is *not*
such a bundle, and holding one to the import promise means testing something we never claimed.

That is not theoretical. When the restore tier first ran for real it failed with
`column "Code" of relation "companies" does not exist`: a hand-written fixture carried
`company.Code` plus nine other columns that have **never** existed on the entities. Every
no-database check had passed it for months, because **a bundle is internally consistent by
construction** — its own `schema/*.json` describes its own records, so checking it against itself
proves nothing. Tier 1 now also asks whether the columns still exist on the *current* entity
manifest, which catches the class without a database; but it was the real restore that found it.

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
goldens signing key (`kid 76e65bd2ec932008`). The private half lives outside every checkout —
`gitleaks` scans full history, and a private key that ever touched a commit is burned. The
goldens key is deliberately *not* a deployment's `ember-keygen` key: a golden must stay
verifiable offline, on any machine, for the whole 36-month window, with no database in the
picture.

Losing the private half is **recoverable**: mint a new one and re-seal every golden. `manifest.sig`
sits outside the digest chain, so re-signing changes no `bundleDigest` and the pins above still
hold — which is exactly why rotation is not the regeneration rule 1 forbids. All goldens must
share one key (stage 7 matches the signature's `kid` against the single public key), so rotation
is all-or-nothing in one reviewed commit.

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
  manifest. Version equality is not sufficient — the retired `1.0-minimal` fixture declared
  `company` at version 1, the entity *is* at version 1, and it still carried a `Code` column that
  has never existed.

The third check is the mechanical teeth: **a `resourceVersion` bumped without its upcaster is
a red build**, which forces the bump and the migration into the same commit.

Tier 1 catches shape drift, and now catches dropped columns too. It still does **not** catch
everything about "would the rows actually go in" — constraints, defaults and FK targets only
answer to a real database. That is tier 2.

### Tier 2 — the database import matrix, run locally

```bash
npm run db:provision -- --suffix _ci --drop                   # backends: 14 module DBs
(cd ../../core-service && npm run db:provision -- --suffix _ci --drop)   # core
DB_SUFFIX=_ci ./import-matrix.sh
```

Restores every `importer` golden into a real stack and reports per-resource row counts. This is
what actually proves an old bundle goes in.

**It is not in CI pre-GA.** It briefly was, and it can be again in one commit — both repos now
have `npm run db:provision`, which builds a stack straight from the entity classes, so no live
deployment is needed. It was taken back out because it guarded a promise not yet made and needed
a cross-repo credential to provision core's schema. **Put it back at GA**, alongside era zero.

A golden may declare `requiresBase`, in which case it is layered on top of that base without an
intervening truncate: `allocate` resolves organization and company as anchors against a tenant
that must already exist. No current golden needs this, but the machinery is there — it is how a
real adapter-driven migration runs against a live tenant.

When it does go back into CI, it will need a `CORE_SERVICE_TOKEN` secret to check out the
sibling repo — core's schema must come from core-service, since its source never enters this one.

## Adding a golden (a new era)

1. Produce the bundle, or copy it from wherever it was produced.
2. `node scripts/seal-golden-bundle.mjs seal <dir> --key <private-key-path>`
3. Add its entry to `index.json` — including the `bundleDigest` the validator reports, its
   `role`, and `requiresBase` if it needs a tenant to exist.
4. Run tier 1 and tier 2.
5. Commit it **alone**, with the era and the reason in the message.
