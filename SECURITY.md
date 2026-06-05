# Security Policy

## Supported versions

Security fixes target the latest published npm version of `pi-flutter-run`.

## Reporting a vulnerability

Please do **not** open a public issue for security vulnerabilities.

Use one of these channels instead:

1. Open a private security advisory on GitHub if available.
2. Contact the npm/GitHub maintainer privately.

Include:

- Affected version.
- Operating system.
- Pi Agent version.
- Reproduction steps.
- Impact and any known workaround.

## Security expectations

`pi-flutter-run` is a Pi extension and therefore runs with local user permissions. Contributors must avoid:

- Hidden telemetry or undeclared network calls.
- Shell execution outside the documented Flutter/Pi workflows.
- Storing secrets in logs, screenshots, repository files, or issues.
- Unsafe handling of user-provided paths or commands.
