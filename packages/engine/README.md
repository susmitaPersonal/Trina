# @trina/engine

Pure, deterministic challenge **compiler + rules/scoring engine** plus the **module registry**.
Runs on the device (provisional score) and the server (authoritative score).

- Spec: [docs/architecture/challenge-engine.md](../../docs/architecture/challenge-engine.md)
- Add a module: [docs/guides/adding-a-module.md](../../docs/guides/adding-a-module.md)

Layout:
```
src/
  compile.ts  reduce.ts  facts.ts  rules.ts  evaluate.ts
  geo/        haversine, point-in-circle/polygon, bearing, simplify
  modules/    walking/ running/ cycling/ cleanup/ tree_care/ … + index.ts (registry)
fixtures/     golden tests: <case>/{definition,events,expected}.json
```

**Hard rules:** no `Date.now()`, no randomness, no I/O, no Node or React Native APIs. Integer
metres and points. Stamp `engineVersion` on every result.
