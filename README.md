# IconMaker

A browser-based SVG icon editor. [Open IconMaker](https://jhalaga.github.io/IconMaker/).

Open `index.html` to run locally. Run `node tests/unit.test.js` to check the model and editing tools.

## Versions and release notes

The current app version is in `VERSION`. Dated release notes are in [CHANGELOG.md](CHANGELOG.md), and in the app through the small version button under the IconMaker name. `releases.js` supplies the in-app history, newest first.

Use semantic versioning: major for breaking changes, minor for features, patch for fixes. The project file format has its own version and is independent of the app version.

## Publishing

GitHub Pages serves the root of the `gh-pages` branch. Development is on `iconmaker-v1`.

1. Update `releases.js`, `VERSION` and `CHANGELOG.md` together.
2. Run `node tests/unit.test.js` and `git diff --check`, then commit the release.
3. Push the development branch and the same commit to `gh-pages`, without force-pushing.
4. Tag that commit as `vX.Y.Z` and publish a GitHub release with the matching changelog entry.
5. Verify the Pages build and the version served by the live site.
