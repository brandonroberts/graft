---
'@graftsync/core': patch
'@graftsync/cli': patch
'@graftsync/skill': patch
---

The sync report keeps the end of an `upgrade` command's output (`installOutput` in `sync.json`, a section of `sync.md`), and the skill tells agents to read it even when sync is green: a tool can exit 0 and leave work for an agent, as `nx migrate --agentic` does when it runs inside one.
