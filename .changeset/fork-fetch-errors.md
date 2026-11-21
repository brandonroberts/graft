---
'@graftsync/adapter-fork': patch
'@graftsync/core': patch
---

Report fork adapter fetch, git, partial-clone, and config failures (`fork/partial-clone`, `fork/git`, `fork/config`, `fork/ecosystem`) as tooling errors (`outcome: 'error'`, exit code `2`) instead of `needs-agent`, and detect `file://` local partial clones in `refusePartialClone`.
