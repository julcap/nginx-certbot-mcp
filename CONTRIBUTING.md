# Contributing to nginx-certbot-mcp

Thank you for your interest in improving nginx-certbot-mcp. Contributions that
make AI-assisted Nginx, DNS, and certificate operations safer, clearer, and
more reliable are welcome.

## Before you start

- Search the existing issues and pull requests before opening a new one.
- Open an issue before making a substantial change so the design and scope can
  be discussed first.
- Keep pull requests focused. Separate unrelated fixes or features.
- Never include credentials, private keys, certificates, domain secrets,
  production configuration, or other sensitive information.

## Development setup

1. Fork the repository and create a branch from the default branch.
2. Install the supported Node.js version and dependencies:

   ```bash
   npm ci
   ```

3. Build the project:

   ```bash
   npm run build
   ```

4. Run the available checks:

   ```bash
   npm test --if-present
   npm run lint --if-present
   ```

Use a descriptive branch name such as `feature/dry-run-mode` or
`fix/certificate-validation`.

## Security and design principles

This project can perform operations on internet-facing infrastructure. Changes
must preserve its least-privilege design.

- Do not add arbitrary shell execution or generic privileged file access.
- Keep privileged operations narrow, explicit, and allowlisted.
- Validate and normalize all external input, especially domains, paths, ports,
  command arguments, and provider responses.
- Avoid shell interpolation. Prefer APIs or argument arrays over constructed
  command strings.
- Never log secrets, private keys, tokens, complete credentials, or sensitive
  environment variables.
- Make mutating operations observable and auditable.
- Validate configuration before reload or activation.
- Prefer reversible operations and document rollback behavior.
- Require explicit confirmation for destructive or high-impact operations.
- Add or update tests for security boundaries, validation, error handling, and
  failure recovery.

## Pull requests

A pull request should include:

- A concise explanation of the problem and the proposed solution.
- Any security or operational implications.
- Tests for new behavior or a clear explanation of why tests are not practical.
- Documentation updates when behavior, setup, permissions, or MCP tools change.
- No generated build output unless the repository explicitly tracks it.

Before submitting, confirm that the project builds and all available checks
pass. Maintainers may ask for changes or decline work that expands privileged
access without a clear safety model.

## Commit messages

Write short, imperative commit subjects that explain the change, for example:

```text
Add validation for upstream ports
Prevent secrets from appearing in audit logs
Document Route 53 permissions
```

## Reporting security vulnerabilities

Do not disclose suspected vulnerabilities in a public issue. Use GitHub's
private vulnerability reporting for this repository. If that feature is not
available, contact the maintainer privately before sharing technical details.

Include the affected version, impact, reproduction steps, and any suggested
mitigation. Do not test against infrastructure you do not own or have explicit
permission to assess.

## Licensing of contributions

This project is licensed under the Elastic License 2.0 (`Elastic-2.0`). By
submitting a contribution, you agree that your contribution is provided under
the same license and that you have the right to submit it.

The Elastic License 2.0 is source-available but is not an OSI-approved open
source license. In particular, it does not permit providing a substantial set
of the software's functionality to third parties as a hosted or managed
service. See the [LICENSE](../../Downloads/LICENSE) file for the complete terms.

Unless you explicitly state otherwise, you retain copyright in your
contribution.
