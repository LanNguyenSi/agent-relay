# Security Policy

## Supported Versions

Active development is on `main`. Only the latest published release on npm and the `:latest` Docker image are supported.

agent-relay sits on the network path between deployer and VPS targets, so vulnerabilities are treated as serious by default.

## Reporting a Vulnerability

Please **do not** open a public GitHub issue for security reports.

Email **contact@lan-nguyen-si.de** with:

- Affected version (npm / Docker tag / commit SHA)
- Reproduction steps or proof-of-concept
- Impact assessment (especially: command injection, auth bypass, secret leak)

You will get an acknowledgement within 72 hours and an initial assessment within 7 days. A fix timeline depends on severity and complexity, communicated in the assessment.
