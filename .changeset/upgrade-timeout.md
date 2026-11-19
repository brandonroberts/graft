---
'@graftsync/core': patch
'@graftsync/cli': patch
---

An `upgrade` entry can be `{ "command": …, "timeoutMinutes": 90 }` for upgrades that take longer than the default 30 minutes. Command timeouts now stop everything the command started: before, only its shell was killed, so a timed-out install, generator or fork build kept running and Graft waited for it.
