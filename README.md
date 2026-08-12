# tree-sitter-graphcal

Tree-sitter grammar for Graphcal (`.gcl`) files.

## Generate the parser

Requirements: Node.js and npm.

From the repository root:

```sh
npm ci
npm run generate
```

`npm ci` installs the pinned Tree-sitter CLI from `package-lock.json`. The `generate` script runs `tree-sitter generate` using `grammar.js` and updates the generated files in `src/`:

- `src/parser.c`
- `src/grammar.json`
- `src/node-types.json`

The generated files are tracked in this repository, so include them in commits when changing `grammar.js`. Do not edit the generated files directly.

## Verify changes

Run the corpus tests after generating the parser:

```sh
npm test
```

To parse a Graphcal file manually:

```sh
npm run parse -- path/to/file.gcl
```
