# Security Policy

## Scope

agent-memory-bridge is a **local, single-user** bridge. Adapters capture agent
events on your machine and send them, over loopback HTTP, to a memory worker
that is also running locally (default `127.0.0.1:37701` / `127.0.0.1:8000`).
The project never ships conversation content to a third-party cloud.

## Reporting a vulnerability

Please **do not** open a public issue for security bugs. Email the maintainer:

**camplus360@163.com**

Include a description, reproduction steps, affected file/version, and (if
possible) a suggested fix. You should receive an initial response within a few
days. Thank you for disclosing responsibly.

## Things to be aware of

- **Do not expose the worker ports.** The claude-mem / mem0 workers bind to
  loopback by default. Binding them to `0.0.0.0` or a public interface would
  expose stored conversation data to the network; keep them local or behind
  authentication and a firewall.
- **Secrets in prompts/tool output.** Anything your agent sees — including
  credentials printed by tools — can be captured and stored in the local memory
  database. Avoid printing secrets, and review the worker's own data-retention
  settings. `.env` files are git-ignored; never commit API keys.
- **`api` passthrough is restricted** to paths beginning with `/api/` on the
  configured local worker, to limit server-side request forgery.
- Installers and hooks run locally; review `install.sh` and the adapter you
  enable before running them, as you would with any script.

## Dependency / upstream concerns

This repository bundles no third-party runtime code; it interoperates with the
separately installed, Apache-2.0-licensed **claude-mem** and **mem0** programs.
Security issues in those backends should be reported to their own projects.
