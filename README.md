# IconMaker

A browser-based SVG icon editor. [Open IconMaker](https://im.jozefhalaga.com/) or use the [GitHub Pages mirror](https://jhalaga.github.io/IconMaker/).

Open `index.html` to run locally. Run `node tests/unit.test.js` to check the model and editing tools.

## Versions and release notes

The current app version is in `VERSION`. Dated release notes are in [CHANGELOG.md](CHANGELOG.md), and in the app through the small version button under the IconMaker name. `releases.js` supplies the in-app history, newest first.

Use semantic versioning: major for breaking changes, minor for features, patch for fixes. The project file format has its own version and is independent of the app version.

## Publishing

Every release must reach **both** production sites. Development is on `iconmaker-v1`.

- GitHub Pages: https://jhalaga.github.io/IconMaker/ — root of the `gh-pages` branch.
- Custom domain: https://im.jozefhalaga.com/ — Cloudflare Pages project `iconmakerapp`, production branch `main`, account `1765ef3327f697830c216c0550c589ed`. This is a separate direct-upload deployment; pushing GitHub does not update it.

1. Update `releases.js`, `VERSION` and `CHANGELOG.md` together.
2. Run `node tests/unit.test.js` and `git diff --check`, then commit the release.
3. Push the development branch and the same commit to `gh-pages`, without force-pushing.
4. Run `python scripts/prepare_release.py` to stage only public app assets. Upload the printed directory with the Cloudflare Pages uploader: `wrangler pages deploy <directory> --project-name iconmakerapp --branch main --commit-hash <SHA>`. Keep credentials outside the repository. The `cf` CLI can inspect this project but does not implement static-directory asset upload.
5. Tag that commit as `vX.Y.Z` and publish a GitHub release with the matching changelog entry.
6. Verify deployment success and the exact `VERSION`, `releases.js`, and updated assets on **both** URLs before calling the release complete. For automated requests to the custom domain, use a browser User-Agent; the Cloudflare firewall rejects the default Python User-Agent.
