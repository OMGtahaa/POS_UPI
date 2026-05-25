# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 1.8.x   | ✅        |
| < 1.8   | ❌        |

## Reporting a Vulnerability

If you discover a security vulnerability in this project, please report it responsibly:

1. **Do not** open a public GitHub issue.
2. Email the maintainer directly with a description of the vulnerability and reproduction steps.
3. Allow up to 48 hours for an initial response.

## Security Architecture

- This application runs entirely client-side with no backend server.
- Database access is protected by Row Level Security (RLS) policies restricting all operations to authenticated users' own data.
- All client-facing API keys are public anonymous keys with no elevated privileges.
