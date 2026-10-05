# anti-slop (vendored)

Oxlint plugin source vendored from [dmmulroy/anti-slop](https://github.com/dmmulroy/anti-slop),
path `skills/install-anti-slop/assets/anti-slop`.

|                   |                                                                                  |
| ----------------- | -------------------------------------------------------------------------------- |
| Pinned revision   | `c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b` (2026-09-10)                          |
| Previous revision | `9b80d9a5c317d3af94d88a577bdbde4d9a45f7be` (2026-08-12), imported in `26aca3d13` |

## How this copy relates to upstream

The tree was imported from the pinned revision with two deviations. Local
corrections made since that import are listed below.
Every file is run through this repository's `oxfmt` so `format:check` stays
green and so a later sync diffs on meaning rather than on line wrapping.
Re-normalize with
`./node_modules/.bin/oxfmt tools/oxlint/anti-slop --disable-nested-config` after
any sync.

The `effect/` subdirectory is deleted. Its five rules are replaced by
`@mpsuesser/oxlint-plugin-effect`, registered as the `effect` plugin in
`oxlint.config.ts`. That package carries the same Effect conventions plus the
wider rule set, so keeping this copy would mean two plugins reporting the same
findings. A later sync has to drop `effect/` again.

Two earlier commits, `06e14f43f` and
`e7943b72b`, had adapted the vendored source to this repository's own lint and
dead-code gates: braces around single-statement `if` bodies, one flattened
nesting level in `shared/dictionary-types.ts`, and the removal of the then-unused
`isPopulatedObjectExpression` export. Both were reverted during this sync.
`tools/oxlint/anti-slop/**` is now listed in `oxlint.config.ts` and `.fallowrc.json`
`ignorePatterns`, which is what upstream's install skill prescribes and what keeps
a sync from turning into a merge against house style.

## Local corrections

`shared/dictionary-types.ts` binds generic arguments to their parameter
declarations and retains each argument's lexical substitutions and alias
recursion state. An explicit argument resolves in the caller's scope; a default
resolves after earlier parameters have been bound. This prevents recursive
substitution when an alias and its caller use the same parameter name, without
losing unsafe union arms or nested alias applications. The shared
`lexical-type-parameters.ts` helper exposes the nearest binder for each name.

`shared/dictionary-types.test.ts` exercises these cases through the native
Oxlint CLI. The root Vitest configuration runs it as part of `bun run coverage`.

Preserve or reconcile these corrections during the next upstream sync.

## What the update brought in

- Three generic rules: `no-array-filter-map`, `no-reduce-accumulator-copy`,
  `require-readable-spacing`, with the shared modules they need (`array-method.ts`,
  `function-parameters.ts`, `lexical-type-parameters.ts`, `scope.ts`,
  `type-alias-resolution.ts`) and `vendor/eslint-stylistic/`.
- The plugin entry points moved from `definePlugin` to `eslintCompatPlugin`, and
  the rules from `create` to `createOnce`. `@oxlint/plugins` is pinned at `1.82.0`,
  which exports both.
- Sharper analysis in the carried-over rules. Fourteen `oxlint-disable` directives
  in application code went dead as a result and were removed.

## Verifying a sync

This copy came from Luca during the MCP extraction.
Check its local corrections against the pinned upstream revision before replacing
the directory in a later sync.
