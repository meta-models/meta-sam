# Contributing to meta-sam

We want to make contributing to this project as easy and transparent as
possible. Participation is governed by our [Code of Conduct](CODE_OF_CONDUCT.md).

## Our Development Process

This GitHub repository is the source of truth. Changes land through pull
requests against `main`, and every pull request runs the same checks as
`node scripts/validate`. TypeScript packages are released to npm with Changesets;
see [`typescript/docs/releasing.md`](typescript/docs/releasing.md). The Python
distribution is released to PyPI from a version tag; see the releasing section of
[`python/README.md`](python/README.md). Both publications require approval in a
protected GitHub environment.

## Pull Requests

We actively welcome your pull requests.

1. Fork the repo and create your branch from `main`.
2. If you've added code that should be tested, add tests.
3. If you've changed APIs or protocol behavior, update the documentation.
4. Ensure the complete test suite passes: `node scripts/validate`.
5. Run the implementation's formatter; for TypeScript, use `npm run format` from `typescript/`, and for Python, use `python -m ruff format .` from `python/`.
6. If you haven't already, complete the Contributor License Agreement ("CLA").

Keep each pull request to one reviewable change. Larger work is easier to review
as a stack of dependent pull requests than as one large one.

## Contributor License Agreement ("CLA")

In order to accept your pull request, we need you to submit a CLA. You only need
to do this once to work on any of Meta's open source projects.

Complete your CLA here: <https://code.facebook.com/cla>

## Issues

We use GitHub issues to track public bugs. Please ensure your description is
clear and has sufficient instructions to be able to reproduce the issue. Use
synthetic media and synthetic SAM 3 output in reproductions; do not attach
credentials, private media, or raw model output containing personal data.

Meta has a [bounty program](https://bugbounty.meta.com/) for the safe
disclosure of security bugs. In those cases, please go through the process
outlined on that page and do not file a public issue. See also
[`SECURITY.md`](SECURITY.md).

## Before Sending a Change

1. Install dependencies for the implementation you are changing. For TypeScript, run `npm install` from `typescript/`. For Python 3.10 or newer, create a virtual environment and run `python -m pip install -e '.[dev]'` from `python/`.
2. Keep public TypeScript packages ESM-only and import internal modules with explicit `.js` extensions.
3. Keep units in API documentation, not public identifier names.
4. Treat every mask as one complete encoded payload.
5. Validate every conformance case against [`conformance/case.schema.json`](conformance/case.schema.json), and update [`protocol/`](protocol/) plus cases under [`conformance/cases/`](conformance/cases/) when changing the shared SAM 3 grammar. Use deterministic synthetic text by default. A captured case must contain only protocol output that has been reviewed to exclude prompts, source media, source identifiers, credentials, and personal data.
6. Add a TypeScript changeset with `npm run changeset` from `typescript/` when a published package's behavior, API, or dependencies change. Select only the directly changed packages; Changesets computes dependent package bumps from the workspace graph.
7. Keep [`conformance/compatibility.json`](conformance/compatibility.json) generated: TypeScript versioning regenerates it, and a Python version change must run `node scripts/sync-compatibility` in the same change.
8. Run `node scripts/validate-conformance` and `node scripts/validate` from the repository root.

Do not commit generated package archives, `dist` output, coverage output, or local
cache files.

## Compatibility

Public package entry points are the only supported imports. Deep imports are not part
of the contract. Parser changes must preserve stream lifecycle behavior as well as
syntax behavior.

## Coding Style

TypeScript formatting is enforced by Prettier (`npm run format:check` from
`typescript/`): 2-space indentation, single quotes, trailing commas, 88-character
lines. TypeScript is checked in strict mode by `npm run typecheck:packages` and
`npm run typecheck:tests`. Python formatting and linting are enforced by Ruff,
and public code plus tests are checked with strict mypy settings; the pinned
commands are defined in [`python/pyproject.toml`](python/pyproject.toml).

## License

By contributing to meta-sam, you agree that your contributions will be licensed
under the [SAM License](LICENSE) in the root directory of this source tree.
