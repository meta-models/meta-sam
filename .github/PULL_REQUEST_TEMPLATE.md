## Summary

<!-- What changes and why. Link the issue this closes, if any: "Closes #123". -->

## Test plan

<!-- The exact commands you ran and their result, e.g. `node scripts/validate`, `npx vitest run packages/parser`, `python -m pytest`. For live API behavior, say which model and media you used; never paste API keys or private media. -->

## Checklist

- [ ] One reviewable change; larger work is split into a stack of pull requests.
- [ ] Tests added or updated for changed behavior.
- [ ] `node scripts/validate` passes from the repository root.
- [ ] Formatting applied: `npm run format` (from `typescript/`) and/or `python -m ruff format .` (from `python/`).
- [ ] Parser behavior changed in **both** TypeScript and Python, with matching shared conformance cases under `conformance/cases/`, and `protocol/sam3.md` updated — or this change does not touch parser behavior.
- [ ] A changeset was added with `npm run changeset` for every published TypeScript package whose behavior, API, or dependencies changed — or no published package changed.
- [ ] `conformance/compatibility.json` regenerated with `node scripts/sync-compatibility` if a Python version or the corpus changed.
- [ ] No credentials, private media, prompts, or personal data in code, fixtures, or this description; captured fixtures contain reviewed protocol output only.
- [ ] I have completed the [Contributor License Agreement](https://code.facebook.com/cla).
