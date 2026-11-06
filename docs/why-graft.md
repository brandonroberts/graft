# Graft vs. syncing with an agent alone

Graft doesn't replace the agent. It handles the parts an agent is bad at or expensive for, and calls the agent only for the parts that need judgment.

Coding agents can do the fix. What's missing is something to start them, and a record of why the modification exists and what must stay true. Graft ships no agent, calls no LLM, and has no hosted service.

## What Graft adds over an agent alone

Compared with telling an agent "upgrade X and fix our patch," Graft adds seven things.

1. **Most upgrades need no agent.** `graft sync` checks each graft's anchors and applies it to the target version's pristine package, then installs. If everything fits, it records the new verified version and stops. That is a cheap, repeatable CI step, not an agent run and a PR to review on every patch release.
   - Grafts with a `generator:` go further: sync rebuilds a new variant itself and keeps it only if it fits. The dogfood grafts in `.grafts/` work this way.
2. **It knows when something needs attention.** An agent only syncs when someone starts it. The [GitHub Action](../packages/action) watches npm dist-tags and runs sync. It opens a PR when the result is green and runs your agent only on `needs-agent`.
3. **The agent gets a much smaller problem.** On a miss, it gets the graft's intent, an anchor report and an upstream diff scoped to the files that matter.
   - In the [angular-tr](../examples/angular-tr) test, that was a 364-line diff instead of about 51,000 changed lines.
   - In repo mode it also gets a prepared `-agent` branch with conflict markers only in the files that actually conflict.
4. **A durable record of why the change exists.** Each `graft.md` holds the Why, the Invariants (what must stay true), where to look, and why each anchor was chosen. Without it, the agent reverse-engineers intent from a `.patch` file each time, and a reviewer has nothing to check its PR against.
5. **It catches patches that silently stop applying.** A missed anchor, an unsupported case, or a package manager that would drop a patch is an error, never a pass. An agent told to make the upgrade work can drop a hunk and still get green tests if nothing covers that behavior.
6. **Clear rules for the agent.** It adds a new variant for the new version range and never edits an old one. It proves each Invariant with your tests, adding a test where none exists. If the Invariants can't be met, it marks the graft `conflicted` instead of forcing a pass.
7. **Works with your setup.** One format covers patch files (pnpm, npm, yarn berry, bun, patch-package), vendored copies and forks. Any agent drives it through the CLI (`--json`, exit codes 0 ok, 1 needs attention, 2 tooling error) and the [`graft-sync` skill](../packages/skill/SKILL.md).

## Costs and limits

Graft asks for some upkeep and leaves behavior checks to you.

- **Upkeep:** you write and maintain a `graft.md` per modification, plus a test for each Invariant.
- **Fit, not behavior:** sync proves a graft still applies and installs. Whether it behaves correctly still rests on your tests or the agent.
- **Vendor mode** commits binary tarballs, and the dependency reads `file:.grafts/.vendor/…` instead of a version range.
- **Maturity:** the project is in early development and the [spec](spec.md) is a draft (v1).

## When to use which

| Situation | Better fit |
| --- | --- |
| One small patch, upgraded rarely | Ask an agent when needed |
| Several modifications, or a long-lived fork | Graft |
| Following upstream releases often | Graft |
| Upgrades must be automated and reviewable in CI | Graft |
