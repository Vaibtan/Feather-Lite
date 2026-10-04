# Vendored anti-slop

Source: https://github.com/dmmulroy/anti-slop/tree/c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b

Runtime copied unchanged from `skills/install-anti-slop/assets/anti-slop` at that revision. The root MIT license and nested vendor licenses/attribution are retained. Oxlint and `@oxlint/plugins` are pinned together at 1.78.0, matching this reviewed upstream version. No upstream installer skill, formatter migration, or TypeScript upgrade was installed.

Node >=22.18.0 is required for the vendored TypeScript plugins to load with native type stripping. This minimum is reflected in the root package engines; CI already uses Node 22. Source: the installed Oxlint configuration schema's `jsPlugins` documentation and https://oxc.rs/docs/guide/usage/linter/js-plugins.html.

The explicit-only `$anti-slop` skill wraps manual review/cleanup. Neither `pnpm check` nor CI runs Oxlint. The optional .oxlintrc.json scan checks five selected rules; .oxlintrc.baseline.json evaluates all generic/Effect rules as warnings. See the dated baseline report in docs/reviews for compatibility decisions. Upstream recommendations may mention Effect 4 APIs; assess them against pinned Effect 3 conventions rather than applying a blanket migration.
