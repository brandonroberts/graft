import { stringify } from 'yaml';
import type { GraftFrontmatterInput } from './schema.js';

/** Render a starter graft.md with every required section and guidance for authors. */
export function renderGraftTemplate(frontmatter: GraftFrontmatterInput): string {
  const yaml = stringify(frontmatter, { lineWidth: 0 });
  return `---
${yaml}---

## Why

<!-- What this modification enables, and why upstream does not (or will not) do it.
     Link the upstream issue/PR if one exists. -->

## Invariants

<!-- Observable behaviors that must hold. One bullet each. The oracle tests exactly these.
     Example: "- Every request sent by the client carries an \`x-trace-id\` header." -->

## Where to look

<!-- Describe the upstream area by *behavior*, not file path, so an agent can re-locate it
     after a refactor. Example: "The function that builds outgoing request headers right
     before the request is dispatched." -->

## Anchors

<!-- For each anchor a variant matches on: what it is, and why it was chosen over
     alternatives (prefer stable exported symbols and public strings over code shape). -->

## History

- ${new Date().toISOString().slice(0, 10)}: Graft created against ${frontmatter.rootstock.package}@${frontmatter.rootstock.verified}.
`;
}
