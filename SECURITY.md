# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 0.1.x   | Yes                |

## Reporting a Vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

If you discover a security vulnerability in Beads Web, we ask that you report it responsibly using one of the following methods:

1. **Email:** Send a detailed report to [security@example.com](mailto:security@example.com).
   *(Maintainer: update this address before publishing.)*

2. **GitHub Security Advisory:** Use the [private security advisory feature](https://github.com/jmcy9999/beads-web/security/advisories/new) on the repository to report the issue confidentially.

### What to Include

- A clear description of the vulnerability.
- Step-by-step instructions to reproduce the issue.
- An assessment of the potential impact (e.g., data exposure, remote code execution, privilege escalation).
- Any suggested fixes or mitigations, if you have them.

### Response Timeline

- **Acknowledgment:** Within 48 hours of receiving your report.
- **Initial assessment:** Within 7 days, including severity classification and an expected timeline for a fix.

We will keep you informed of progress toward a resolution and may ask for additional information or guidance.

## Security Considerations

Beads Web is a Next.js dashboard for the Beads issue tracker. It is designed primarily for **local or trusted-network use**. The following details describe the security posture of the application.

### Local Execution Model

Beads Web runs on `localhost` and reads from local `.beads/` directories on the host filesystem. It does not connect to external services or databases by default.

### Server-Side API Routes

Next.js API routes execute on the server (Node.js runtime) and have access to the host filesystem. These routes read issue data from local `.beads/` directories and invoke the `bv` CLI tool. All API routes are unauthenticated by default (see "Authentication" below).

### CLI Execution

The `bv` CLI is executed via `child_process.execFile` rather than `child_process.exec`. This prevents shell interpretation of arguments and mitigates shell injection attacks. A 30-second timeout is enforced on all subprocess calls.

### Input Validation

Git ref parameters (e.g., the `since` parameter on the diff endpoint) are validated against a strict allowlist regex (`/^[a-zA-Z0-9~^._\-/]+$/`) before being passed to any subprocess. Requests with invalid refs are rejected with a 400 response.

### Read-Only Database Access

SQLite databases (`.beads/beads.db`) are opened in **read-only mode** (`{ readonly: true }`). Beads Web does not write to or modify the Beads database.

### Authentication

Beads Web does **not** include authentication or authorization by default. It is designed to run on `localhost` or within a trusted network. If you need to expose Beads Web to an untrusted network, you should place it behind a reverse proxy that provides authentication (e.g., nginx with HTTP basic auth, OAuth2 Proxy, or a similar solution).

## Scope

### In Scope

- The Beads Web application code (this repository: [github.com/jmcy9999/beads-web](https://github.com/jmcy9999/beads-web)).
- Next.js API routes, server-side logic, and frontend components shipped in this repository.

### Out of Scope

- The `bd` and `bv` CLI tools (maintained separately as part of the Beads project).
- The Beads issue format specification itself.
- Third-party dependencies (please report those to their respective maintainers, though we appreciate a heads-up if a dependency vulnerability affects Beads Web directly).
