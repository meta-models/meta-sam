# meta-sam

Language-neutral protocol documentation, shared conformance cases, and native-language implementations for SAM 3 streaming segmentation.

## Repository layout

- [`protocol/`](protocol/) owns the language-neutral protocol contract.
- [`conformance/`](conformance/) owns the [JSON Schema](conformance/case.schema.json), shared synthetic and privacy-reviewed captured cases, exact normalized outcomes, and the [package compatibility matrix](conformance/compatibility.json).
- [`typescript/`](typescript/) contains the npm workspace and the TypeScript implementation.
- [`python/`](python/) contains the dependency-free `meta-sam-parser` distribution and native Python implementation.
- [`scripts/`](scripts/) contains repository-wide validation entry points.

Package details and release instructions live in each implementation's README: [TypeScript](typescript/README.md) and [Python](python/README.md).

## Try the API playground

From the repository root, install both TypeScript dependency trees with one command:

```sh
npm --prefix typescript run playground:setup
```

For live segmentation, copy the environment template and add your Model API key:

```sh
cp typescript/examples/api-playground/.env.example \
  typescript/examples/api-playground/.env.local
```

Then start the playground:

```sh
npm --prefix typescript run playground:dev
```

Open <http://127.0.0.1:4173>. See the [playground README](typescript/examples/api-playground/README.md) for configuration and test commands.

## Validation

From the repository root:

```sh
node scripts/validate-conformance
node scripts/validate
```

The first command verifies the checked-in compatibility identity and runs all 40 cases in both languages. The second command runs each implementation's complete validation suite. Python validation includes formatting, linting, strict type checking, tests with at least 95% coverage, reproducible wheel and sdist builds, exact artifact audits, isolated wheel and sdist consumers, installed-distribution typing, and the pinned official OpenAI SDK smoke.

Licensed under the [SAM License](LICENSE). Contributions are welcome—see [`CONTRIBUTING.md`](CONTRIBUTING.md) and our [Code of Conduct](CODE_OF_CONDUCT.md).
