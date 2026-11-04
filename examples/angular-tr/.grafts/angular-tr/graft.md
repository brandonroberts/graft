---
id: angular-tr
rootstock:
  package: angular
  # The upstream angular/angular this checkout sits on: a release, or release+commit.
  verified: 22.3.0-next.2+e36a63e20e30
mechanism: fork
variants:
  # One permanent variant: this checkout (uncommitted work included) against `verified`.
  - range: ">=22.0.0-0"
    module: ./variants/v22.json
oracle:
  command: node "$GRAFT_DIR/oracle.mjs" {mode}
  modes:
    - pages
  timeout: 900
fork:
  repo: .
  upstream: https://github.com/angular/angular.git
  tag: v{version}
  install: none
status: applied
---

## Why

angular-tr is the community Turkish translation of the Angular docs (angular.dev), published at
https://angular-docs.tr. The repository is a full fork of angular/angular; the translation is
its change. Graft keeps that change current with each upstream Angular release.

## Invariants

- Every page under `adev/src/content` that the fork has translated stays translated after a
  sync: not reverted to upstream's English, no new English headings, no new English prose.
- No conflict markers anywhere in `adev/src/content`.
- Translated headings keep their English `{#anchor}` ids, so links between pages still resolve
  (the docs build fails on broken heading links).
- Code, API names, file paths, URLs, CLI commands and alert keywords (`NOTE:`, `TIP:`…) stay as
  upstream has them.

## Where to look

- The docs pages: `adev/src/content/**/*.md`, by section (`guide/`, `ecosystem/`, `tutorials/`,
  `reference/`, `best-practices/`, `ai/`…).
- Turkish UI strings of the docs site: the templates and components under `adev/src/app`
  (navigation, home page, update guide, editor, API reference).
- Repository meta files the fork localized: README, CONTRIBUTING, SECURITY, CODE_OF_CONDUCT.
- When upstream rewrites or moves a page, translate the new English in place, following the
  terminology table and style rules in `.agent/skills/tr-contributor/SKILL.md`.

## Anchors

Every hunk of the fork's diff against upstream is an anchor: the English it replaced must still
be in upstream, unchanged. Upstream edits to a translated paragraph surface as misses, and git's
merge leaves conflict markers in exactly those files for an agent (or contributor) to translate.
Upstream English that merges cleanly into a translated page is not an anchor miss; the oracle's
`pages` check catches it.

## History

- 2026-11-04: Graft adopted at upstream e36a63e20e (22.3.0-next.2+), the base of the fork's
  2026-10-27 sync.
