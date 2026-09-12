# Publishing

The `Publish to npm` workflow is manually dispatched with an exact version and
channel. Ordinary pushes run tests and do not publish a package.

npm trusts the GitHub Actions workflow `publish.yml` in
`reliefeai/browser-relay` for `@linsoai/browser-relay`, with direct publishing
enabled. The publish job uses Node 24, npm 12.0.2 and `id-token: write`.
It uses OIDC rather than a stored `NPM_TOKEN`.

To verify the connection without publishing a new version:

```bash
gh workflow run publish.yml --ref main \
  -f version=1.5.3 -f channel=latest -f verify_only=true
```

The verification requests a real package-scoped grant from npm. It does not
print or persist credentials. `npm whoami` and `npm publish --dry-run` alone
do not verify this trust relationship.

For a release, commit and tag the approved package version, then dispatch the
workflow against that tag with `verify_only=false`, the exact version and the
intended channel. The workflow rejects prereleases on `latest`. Tags created
before the OIDC migration contain the previous workflow and must not be reused
to test the new publishing configuration.

npm may report a successful publish while the new package is still being
processed. Wait for the exact version and intended dist-tag to become visible,
then download the registry tarball and verify its integrity and contents against
the release artifact before making the GitHub Release public. A temporary 404
during processing is not a reason to submit the publication again.

References: [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/)
and [registry OIDC exchange](https://api-docs.npmjs.com/).
