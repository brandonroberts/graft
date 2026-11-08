# Security policy

## Supported versions

Graft is 0.x. Only the latest published release of the `@graftsync/*` packages and the Action on `main` get security fixes.

## Reporting a vulnerability

Report it by opening an issue.

Include what's affected (the CLI, a mechanism, the Action), the version, how to reproduce it, and what an attacker gains.

## What's in scope

Graft runs with access to the projects it syncs, so these matter most:

- **The GitHub Action** runs with write access to the repository that uses it: it pushes branches and opens pull requests and issues. Anything that lets upstream package contents, a fork, or a pull request from outside steer what it commits, or what commands it runs, is in scope.
- **The CLI** fetches pristine packages with the project's own `npm`, applies patches, runs git, and runs each graft's `generator:` command. A way to write outside the project, or to run a command the project didn't configure, is in scope.

A `generator:` command or an `agent-command` that the project itself configured runs with the project's permissions by design; that alone is not a vulnerability.
