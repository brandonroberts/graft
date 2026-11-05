---
"@graftsync/core": patch
"@graftsync/adapter-fork": patch
"@graftsync/skill": patch
---

Repo mode: a result's fetchable ref (`materialized.fetch`, `agentStart`) now names the upstream commit it sits on (`upstream`), and the report's adopt command, the README, the skill and the Action adopt it as a merge of that commit with the result's tree. Before, adopting by tree swap left upstream out of the fork's history, so a fork that also merges upstream itself replayed it on its next merge (#22). A local `fork.repo` or `upstream` that is a partial clone is now refused with `fork/partial-clone`, naming the cause, instead of git's "repository corruption" error (#23).
