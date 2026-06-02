# @onegrid/undo

Undo / redo manager for oneGrid — captures user mutations as inverse pairs, bundles multi-cell ops into one entry via transactions, binds Cmd+Z / Cmd+Shift+Z. Adopter owns the data store; this package owns the stack semantics.

Part of [oneGrid](https://github.com/CelestialBrain/onegrid) — a free, MIT-licensed, framework-agnostic
data grid. See the [monorepo README](https://github.com/CelestialBrain/onegrid#readme) for the full
package map, architecture, and roadmap.

## Install

```sh
npm install @onegrid/undo
```

## Documentation

This package is documented in the [oneGrid repository](https://github.com/CelestialBrain/onegrid/tree/main/packages/undo).
The public API surface is tracked in
[`docs/api`](https://github.com/CelestialBrain/onegrid/tree/main/docs/api).

## License

MIT
