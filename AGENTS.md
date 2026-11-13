# Project instructions

- Every release must deploy the same app version to both https://jhalaga.github.io/IconMaker/ and https://im.jozefhalaga.com/.
- GitHub Pages publishes `gh-pages`; development is on `iconmaker-v1`.
- The custom domain is a separate Cloudflare Pages direct-upload project: `iconmakerapp`, production branch `main`, account `1765ef3327f697830c216c0550c589ed`. A GitHub push alone does not release there.
- Follow README.md for staging, publishing and verification. Check deployment success and versioned assets on both domains before reporting a release as live.
- Update VERSION, releases.js and CHANGELOG.md together. Keep app versioning separate from the project file-format version.
- Save source and release notes as UTF-8 with LF line endings. Run `node tests/unit.test.js`, JavaScript syntax checks and `git diff --check` before publishing.
- Never package repository metadata, credentials or tests into the production upload; use scripts/prepare_release.py.
