# tree-sitter-graphcal

Tree-sitter grammar for Graphcal (`.gcl`) files.

## Set up the toolchain

Install the global [Vite+ CLI](https://viteplus.dev/guide/global-cli), then run from the repository root:

```sh
vp env on
vp env install
vp pm ci
```

The project uses Vite+ only for environment management and running existing scripts. There is no local `vite-plus` dependency or Vite/Vitest migration.

Node.js, pnpm, and Tree-sitter share version pins between local development and CI. CI also pins the global Vite+ CLI:

| Tool | Version source |
| --- | --- |
| Global Vite+ CLI (CI) | `VP_VERSION` in `.github/workflows/ci.yaml` |
| Node.js | `.node-version` |
| pnpm | `package.json` → `packageManager` |
| Tree-sitter CLI | `package.json` and `pnpm-lock.yaml` |

To match CI's Vite+ version locally, run `vp upgrade <version>` using the workflow's `VP_VERSION` value. This changes your global CLI for other projects too. Vite+ selects and downloads the pinned Node.js and pnpm versions automatically in managed mode.

Local versions are selected by Vite+, not enforced by custom scripts. Use `vp env current` to inspect the selected Node.js and pnpm versions. To return to project pins, clear shell overrides with `vp env use --unset` and unset any `VP_NODE_VERSION`, `VP_PNPM_VERSION`, or `VP_PACKAGE_MANAGER` environment overrides.

Renovate updates the pins, lockfile, and SHA-pinned GitHub Actions. `VP_VERSION` uses a custom Renovate rule; Node.js and pnpm use built-in managers. Updates remain subject to the existing seven-day release-age policy and CI checks.

This matches the JavaScript toolchain, not the host OS or C compiler. Corpus tests also require a working C compiler. CI's companion Graphcal fixture branch remains a moving integration-test input.

## Generate the parser

```sh
vp run generate
```

`vp pm ci` runs a frozen-lockfile pnpm install from `pnpm-lock.yaml`. pnpm blocks dependency build scripts unless they are approved, so the Tree-sitter CLI's reviewed install script is explicitly allowed under `allowBuilds` in `pnpm-workspace.yaml` so it can download its executable. When updating Tree-sitter, review the new install script and update its version-specific entry in `allowBuilds` (or run `vp pm approve-builds`), then rerun `vp pm ci`. Do not approve all dependencies indiscriminately.

The `generate` script runs `tree-sitter generate` using `grammar.js` and updates the generated files in `src/`:

- `src/parser.c`
- `src/grammar.json`
- `src/node-types.json`

The generated files are tracked in this repository, so include them in commits when changing `grammar.js`. Do not edit the generated files directly.

## Verify changes

Run the corpus tests after generating the parser:

```sh
vp run test
```

Use `vp run test`, not `vp test`: the latter runs Vite+'s built-in Vitest command rather than this project's test script.

To parse a Graphcal file manually:

```sh
vp run parse path/to/file.gcl
```
