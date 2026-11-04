import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import semver from 'semver';
import { GRAFT_ID_PATTERN, renderGraftTemplate } from '@graftsync/spec';
import { GraftError } from './errors.js';
import { GRAFT_FILE, GRAFTS_DIR, type Project } from './project.js';

const README = `# .grafts

Each directory here is a **graft**: a local modification to an upstream package, described
for both humans and coding agents. See \`<id>/graft.md\` for why each one exists, which
invariants it guarantees, and how its oracle verifies them.

- \`graft status\` — list grafts and anchor health
- \`graft sync\` — re-verify grafts against a new upstream version
`;

const GITIGNORE = `.cache/
.report/
`;

/** Create `.grafts/` with a README and gitignore. Idempotent. */
export async function initProject(root: string): Promise<string[]> {
  const dir = path.join(root, GRAFTS_DIR);
  const created: string[] = [];
  await mkdir(dir, { recursive: true });
  for (const [name, content] of [
    ['README.md', README],
    ['.gitignore', GITIGNORE],
  ] as const) {
    const file = path.join(dir, name);
    if (!existsSync(file)) {
      await writeFile(file, content);
      created.push(file);
    }
  }
  return created;
}

export const AGENT_SKILL_PATH = '.claude/skills/graft-sync/SKILL.md';
export const MCP_CONFIG_FILE = '.mcp.json';
export const DEFAULT_MCP_SERVER = { command: 'npx', args: ['--no-install', 'graft-mcp', '--root', '.'] };

export interface SetupAgentInput {
  /** Contents of the graft-sync SKILL.md to install (the CLI reads it from @graftsync/skill). */
  skill: string;
  /** MCP server entry to register as `graft` (default: npx graft-mcp --root .). */
  server?: { command: string; args: string[]; env?: Record<string, string> };
}

export interface SetupAgentResult {
  /** Files created or updated, with what happened to each. */
  files: { file: string; action: 'created' | 'updated' | 'unchanged' | 'kept' }[];
  /** Things the user still has to do. */
  notes: string[];
}

/**
 * Onboard coding agents to a project: register the graft MCP server in `.mcp.json` (merged
 * with any existing servers; an existing `graft` entry is kept, as it may carry custom env) and
 * install the graft-sync skill. Idempotent.
 */
export async function setupAgent(root: string, input: SetupAgentInput): Promise<SetupAgentResult> {
  const result: SetupAgentResult = { files: [], notes: [] };

  const mcpFile = path.join(root, MCP_CONFIG_FILE);
  let config: { mcpServers?: Record<string, unknown> } = {};
  if (existsSync(mcpFile)) {
    try {
      config = JSON.parse(await readFile(mcpFile, 'utf8'));
    } catch (err) {
      throw new GraftError(`${MCP_CONFIG_FILE} is not valid JSON (${(err as Error).message}); not overwriting it`, 'agent/mcp-config');
    }
  }
  if (config.mcpServers?.graft) {
    result.files.push({ file: mcpFile, action: 'kept' });
  } else {
    const existed = existsSync(mcpFile);
    config.mcpServers = { ...(config.mcpServers ?? {}), graft: input.server ?? DEFAULT_MCP_SERVER };
    await writeFile(mcpFile, `${JSON.stringify(config, null, 2)}\n`);
    result.files.push({ file: mcpFile, action: existed ? 'updated' : 'created' });
  }

  const skillFile = path.join(root, AGENT_SKILL_PATH);
  const current = existsSync(skillFile) ? await readFile(skillFile, 'utf8') : undefined;
  if (current === input.skill) {
    result.files.push({ file: skillFile, action: 'unchanged' });
  } else {
    await mkdir(path.dirname(skillFile), { recursive: true });
    await writeFile(skillFile, input.skill);
    result.files.push({ file: skillFile, action: current === undefined ? 'created' : 'updated' });
  }

  const manifest = path.join(root, 'package.json');
  if (existsSync(manifest)) {
    const json = JSON.parse(await readFile(manifest, 'utf8')) as Record<string, Record<string, string> | undefined>;
    const has = (name: string) => ['dependencies', 'devDependencies'].some((f) => json[f]?.[name] !== undefined);
    const missing = ['@graftsync/cli', '@graftsync/mcp'].filter((name) => !has(name));
    if (missing.length) result.notes.push(`add ${missing.join(' and ')} as devDependencies so agents can start the MCP server`);
  }
  result.notes.push('agents without .mcp.json support: point them at the same command (npx --no-install graft-mcp --root .) and at the skill file');
  return result;
}

export interface AddGraftInput {
  id: string;
  package: string;
  /** Defaults to the installed version. */
  version?: string;
  mechanism: string;
  targets?: string[];
  modes?: string[];
}

/** Scaffold `graft.md`, a variant stub, and an oracle stub for a new graft. */
export async function addGraft(project: Project, input: AddGraftInput): Promise<string[]> {
  if (!GRAFT_ID_PATTERN.test(input.id)) throw new GraftError(`graft id "${input.id}" must be lowercase kebab-case`, 'graft/invalid-id');
  const dir = path.join(project.graftsDir, input.id);
  if (existsSync(path.join(dir, GRAFT_FILE))) throw new GraftError(`graft "${input.id}" already exists`, 'graft/exists');
  const adapter = project.adapter(input.mechanism);
  if (!adapter) throw new GraftError(`unknown mechanism "${input.mechanism}" (available: ${project.adapterNames.join(', ')})`, 'adapter/unknown');

  const version = input.version ?? (await project.installedVersion(input.package));
  if (!version || !semver.valid(version)) {
    throw new GraftError(`${input.package} is not installed; pass --version`, 'upstream/not-installed');
  }
  const major = semver.major(version);
  const variantFile = `./variants/v${major}${project.adapter(input.mechanism)?.variantExtension ?? '.ts'}`;
  const oracleFile = `${GRAFTS_DIR}/${input.id}/oracle.mjs`;
  const modes = input.modes?.length ? input.modes : ['default'];

  await initProject(project.root);
  await mkdir(path.join(dir, 'variants'), { recursive: true });
  const files: [string, string][] = [
    [
      path.join(dir, GRAFT_FILE),
      renderGraftTemplate({
        id: input.id,
        rootstock: { package: input.package, verified: version },
        mechanism: input.mechanism,
        ...(input.targets?.length ? { targets: input.targets } : {}),
        variants: [{ range: `>=${major}.0.0-0`, module: variantFile }],
        oracle: { command: `node ${oracleFile}`, modes },
        status: 'applied',
      }),
    ],
    [
      path.join(dir, variantFile),
      adapter.variantTemplate?.({ id: input.id, targets: input.targets, package: input.package }) ??
        `// Variant for ${input.package}. Implement the ${input.mechanism} mechanism here.\nexport default {};\n`,
    ],
    [path.join(project.root, oracleFile), ORACLE_STUB(input.id)],
  ];
  for (const [file, content] of files) await writeFile(file, content);
  return files.map(([f]) => f);
}

const ORACLE_STUB = (id: string) => `// Oracle for graft "${id}".
// Must exit 0 only if every invariant in .grafts/${id}/graft.md holds.
// Runs once per mode; the mode is in process.env.GRAFT_MODE (e.g. "dev" or "build").
// The upstream version under test is in process.env.GRAFT_UPSTREAM_VERSION.

const mode = process.env.GRAFT_MODE;
console.error(\`[oracle:${id}] not implemented yet (mode: \${mode})\`);
process.exit(1);
`;
