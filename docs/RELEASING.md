# Numbered Nova Dream releases

Every user-visible update gets a new application version and a concise entry in this repository's `CHANGELOG.md`. Keep public notes limited to reusable features and setup information. Personal deployment records belong only in the private repository.

The main-branch quality workflow publishes a GitHub Release after all required checks pass. `scripts/github-release.mjs` reads the version and its matching changelog entry, checks repository visibility, and tags the verified source commit. It does not upload workspace data, credentials, recovery files or unsigned installers. An existing release is left intact; tags are never moved. The private repository uses `nova-vX.Y.Z` so Nova releases do not trigger the predecessor application's `v*` installer workflow. The standalone public repository uses `vX.Y.Z`.

The workflow's built-in GitHub token has write permission only in the release job. No additional account, server or subscription is required. VPS deployment remains optional and independent of source release publication.

For an authorized manual retry after the same quality gate has passed, run from the application directory:

```sh
GITHUB_REPOSITORY=owner/repository node scripts/github-release.mjs --public
```

Use `--private` in the private repository. The script rejects a mismatched audience or a source commit outside `main`. It will not let an older completed workflow replace the latest release designation.

Historical releases use source commits whose package version matches the tag. Earlier numbered milestones that were never separately committed are listed as historical notes in the first source release containing them. This preserves the recorded history without labeling newer source archives as unavailable older builds. Development versions remain marked as prereleases. The original public source release starts at 1.1.3; it does not expose the private repository's earlier history.
