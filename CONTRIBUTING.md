# Contributing

**Issues and pull requests are welcome.** The specification exists to be implemented by other
people; if something in it is ambiguous, wrong, or impossible to implement, that is a bug worth
reporting.

## This repository is a mirror

The canonical source is `packages/ember-validator` in Charcoal's internal `backends` repository,
and this tree is regenerated from it by `scripts/publish-ember-validator.sh`. **Direct commits
here are overwritten on the next sync** — so a merged pull request is applied upstream and
arrives back here on the following sync, rather than living on this branch.

That is a deliberate trade: the validator has to stay byte-identical to the one Charcoal's own CI
runs against the golden bundles, because "the validator agrees with the producer" is the property
the whole format rests on. Two independently-editable copies would quietly stop being one thing.

## Changing the specification

The spec (`spec/ember-bundle-format-1.0.md`) is owned by Charcoal ERP and `1.0` is frozen: a
change that alters what conformant software must do produces a new version, never an edit to a
frozen one. Open an issue describing the problem the change solves, which bundles it affects, and
whether existing producers or consumers would have to change. See §14 of the spec.

A change that would make an already-issued bundle unreadable inside its 36-month support window
gets the most scrutiny, and usually loses to the window.

## Running the tests

```bash
node --test test/*.mjs                                                    # self-tests
node bin/ember-validate.mjs verify goldens/1.0-full --pubkey goldens/signing-key.pub.json
```

No dependencies, no install step, Node >= 18.
