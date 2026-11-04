# @graftsync/adapter-patch

## 0.1.2

### Patch Changes

- `graft capture <id>`: write your edit of the installed package as the graft's variant (the diff against the published package). It replaces the untouched scaffold stub, or adds a new variant once a real one exists, and keeps it only if it applies to the pristine version.
- Smaller install: pristine packages are fetched with the project's own npm (`npm pack`, `npm view`, honoring its `.npmrc`) instead of pacote. `@graftsync/cli` now installs 18 packages instead of 103.
- The graft-sync skill covers browser oracles: fail on console errors and 5xx responses too, since frameworks catch errors and only log them.
- Updated dependencies [3a0ffbb]
  - @graftsync/core@0.1.2
  - @graftsync/spec@0.1.2

## 0.1.1

### Patch Changes

- Updated dependencies
  - @graftsync/core@0.1.1
  - @graftsync/spec@0.1.1
