# Beta acceptance gate

Pull requests targeting `main` run a stable `beta-acceptance` check in addition to the existing `foundation-spike` and `production-container` workflows.

The beta check does not duplicate the heavy test suites. It waits for the sibling pull-request runs for the same PR head SHA and succeeds only when both required workflows complete successfully. A failed, cancelled, timed-out, missing, or excessively delayed required workflow causes the beta check to fail closed.

The sibling workflows themselves are executed by GitHub Actions against the pull-request merge ref, so the beta check represents the tested merge candidate rather than treating a green feature-branch build as sufficient release evidence.

## Required repository rule

For this check to prevent merging, the repository ruleset or branch protection for `main` must require the status check named exactly:

`beta-acceptance`

The workflow file alone cannot enforce repository merge policy. Do not claim the merge gate is mandatory until the repository rule has been configured and verified with a deliberately failing pull request.

## Release-candidate evidence

A beta release candidate additionally requires the release-level acceptance and recovery run tracked in the beta-readiness issue. This PR gate is necessary but does not replace backup/restore, recovery-matrix, packaging, documentation, licensing, or approved-SPEC scope decisions.
