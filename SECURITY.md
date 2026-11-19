# Security Policy

## Supported Versions

Active development is on `main`. The supported distribution is the `ghcr.io/lannguyensi/agent-relay:latest` Docker image for `linux/amd64`, published on merges to `main` (a merge that changes only documentation does not republish). A `v*` tag publishes only its semver tags, such as `:0.2.0` and `:0.2`, and never moves `:latest`. Older tags and SHAs are not patched.

agent-relay sits on the network path between deployer and VPS targets, so vulnerabilities are treated as serious by default.

## Reporting a Vulnerability

Please **do not** open a public GitHub issue for security reports.

Email **contact@lan-nguyen-si.de** with:

- Affected version (Docker image tag or digest, release version, or commit SHA)
- Reproduction steps or proof-of-concept
- Impact assessment (especially: command injection, auth bypass, secret leak)

You will get an acknowledgement within 72 hours and an initial assessment within 7 days. A fix timeline depends on severity and complexity, communicated in the assessment.
