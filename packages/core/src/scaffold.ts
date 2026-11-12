import { existsSync, statSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ACTIVE_STATUSES, GRAFT_ID_PATTERN, renderGraftTemplate } from '@graftsync/spec';
import { GraftError } from './errors.js';
import { GRAFT_FILE, GRAFTS_DIR, type Project } from './project.js';

const README = `# .grafts

Each directory here is a **graft**: a local modification to an upstream package, described
for both humans and coding agents. See \`<id>/graft.md\` for why each one exists, which
invariants it guarantees, and where an agent should look when upstream changes.

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

/** Directory name of the skill inside a skills folder. */
export const SKILL_NAME = 'graft-sync';

/**
 * Skills folders that coding agents read, relative to the project root. If one exists, the
 * project uses that agent's skills.
 */
export const KNOWN_SKILLS_DIRS = [
  '.claude/skills',
  '.agents/skills',
  '.codex/skills',
  '.cursor/skills',
  '.gemini/skills',
  '.github/skills',
];

/**
 * Agent config folders whose `skills/` subfolder the agent reads. A project that has one of these
 * but no skills folder yet uses that agent. (`.github/` is not here: most repos have it for
 * workflows, not Copilot.)
 */
export const KNOWN_AGENT_DIRS = ['.claude', '.agents', '.codex', '.cursor', '.gemini'];

export interface SetupAgentInput {
  /** Contents of the graft-sync SKILL.md to install (the CLI reads it from @graftsync/skill). */
  skill: string;
  /** Install into these skills folders (relative to root) instead of detecting them. */
  skillsDirs?: string[];
}

export interface SetupAgentResult {
  /** Skills folders the skill was installed into, relative to the root, and how they were chosen. */
  skillsDirs: { dir: string; reason: 'existing skills folder' | 'agent folder' | 'requested' }[];
  /** Files created or updated, with what happened to each. */
  files: { file: string; action: 'created' | 'updated' | 'unchanged' }[];
  /** Things the user still has to do. */
  notes: string[];
}

/**
 * The skills folders this project's agents read: every existing known skills folder; failing
 * that, `skills/` under every existing known agent folder. Empty when nothing is detected.
 */
export function detectSkillsDirs(root: string): SetupAgentResult['skillsDirs'] {
  const isDir = (rel: string) => {
    try {
      return statSync(path.join(root, rel)).isDirectory();
    } catch {
      return false;
    }
  };
  const existing = KNOWN_SKILLS_DIRS.filter(isDir).map((dir) => ({ dir, reason: 'existing skills folder' as const }));
  if (existing.length) return existing;
  return KNOWN_AGENT_DIRS.filter(isDir).map((d) => ({ dir: `${d}/skills`, reason: 'agent folder' as const }));
}

/**
 * Onboard coding agents to a project: install the graft-sync skill (which drives Graft through
 * the `graft` CLI) into the skills folders the project's agents read. Detected unless given;
 * fails rather than guessing when no agent is detected. Idempotent.
 */
export async function setupAgent(root: string, input: SetupAgentInput): Promise<SetupAgentResult> {
  const skillsDirs = input.skillsDirs?.length
    ? input.skillsDirs.map((dir) => ({ dir: dir.replace(/\/+$/, ''), reason: 'requested' as const }))
    : detectSkillsDirs(root);
  if (!skillsDirs.length) {
    throw new GraftError(
      `no agent skills folder found in ${root} (looked for ${KNOWN_SKILLS_DIRS.join(', ')} and agent folders ${KNOWN_AGENT_DIRS.join(', ')}). ` +
        'Pass --skills-dir <path> to choose where to install the graft-sync skill.',
      'agent/no-skills-dir',
    );
  }
  const result: SetupAgentResult = { skillsDirs, files: [], notes: [] };
  for (const { dir } of skillsDirs) {
    const skillFile = path.join(root, dir, SKILL_NAME, 'SKILL.md');
    const current = existsSync(skillFile) ? await readFile(skillFile, 'utf8') : undefined;
    if (current === input.skill) {
      result.files.push({ file: skillFile, action: 'unchanged' });
    } else {
      await mkdir(path.dirname(skillFile), { recursive: true });
      await writeFile(skillFile, input.skill);
      result.files.push({ file: skillFile, action: current === undefined ? 'created' : 'updated' });
    }
  }

  const manifest = path.join(root, 'package.json');
  if (existsSync(manifest)) {
    const json = JSON.parse(await readFile(manifest, 'utf8')) as Record<string, Record<string, string> | undefined>;
    const has = (name: string) => ['dependencies', 'devDependencies'].some((f) => json[f]?.[name] !== undefined);
    if (!has('@graftsync/cli')) result.notes.push('add @graftsync/cli as a devDependency so agents can run `graft`');
  }
  return result;
}

export interface AddGraftInput {
  id: string;
  package: string;
  /** The package's ecosystem (`npm`, `cargo`, `go`, `pypi`); default npm. */
  ecosystem?: string;
  /** Defaults to the installed version. */
  version?: string;
  mechanism: string;
  targets?: string[];
  /** Mechanism-specific scaffolding options, passed to the adapter (e.g. fork: upstream, inPlace). */
  options?: Record<string, string | boolean>;
}

/** Scaffold `graft.md` and a variant stub for a new graft. */
export async function addGraft(project: Project, input: AddGraftInput): Promise<string[]> {
  if (!GRAFT_ID_PATTERN.test(input.id)) throw new GraftError(`graft id "${input.id}" must be lowercase kebab-case`, 'graft/invalid-id');
  const dir = path.join(project.graftsDir, input.id);
  if (existsSync(path.join(dir, GRAFT_FILE))) throw new GraftError(`graft "${input.id}" already exists`, 'graft/exists');
  const adapter = project.adapter(input.mechanism);
  if (!adapter)
    throw new GraftError(`unknown mechanism "${input.mechanism}" (available: ${project.adapterNames.join(', ')})`, 'adapter/unknown');
  const ecosystem = project.ecosystemFor(input.ecosystem ?? 'npm');
  if (adapter.exclusivePerPackage) {
    const existing = (await project.loadAll()).grafts.find(
      (g) =>
        g.frontmatter.mechanism === input.mechanism &&
        g.frontmatter.rootstock.package === input.package &&
        g.frontmatter.rootstock.ecosystem === ecosystem.name &&
        ACTIVE_STATUSES.includes(g.frontmatter.status),
    );
    if (existing) {
      throw new GraftError(
        `graft "${existing.id}" already patches ${input.package} with the ${input.mechanism} mechanism, which applies only one graft per package; ` +
          `add your change to "${existing.id}" instead (a single variant can contain patches for several files)`,
        'graft/duplicate-rootstock',
      );
    }
  }

  const given = input.version && ecosystem.normalizeVersion ? ecosystem.normalizeVersion(input.version) : input.version;
  const version = given ?? (await project.installedVersion(input.package, ecosystem.name));
  if (!version) throw new GraftError(`${input.package} is not installed; pass --version`, 'upstream/not-installed');
  if (!ecosystem.scheme.valid(version)) throw new GraftError(`"${version}" is not a valid ${ecosystem.name} version`, 'version/invalid');
  const major = ecosystem.scheme.major(version);
  const variantFile = `./variants/v${major}${project.adapter(input.mechanism)?.variantExtension ?? '.ts'}`;
  const scaffold = {
    id: input.id,
    package: input.package,
    ecosystem: ecosystem.name,
    targets: input.targets,
    root: project.root,
    options: input.options ?? {},
  };

  await initProject(project.root);
  await mkdir(path.join(dir, 'variants'), { recursive: true });
  const files: [string, string][] = [
    [
      path.join(dir, GRAFT_FILE),
      renderGraftTemplate({
        id: input.id,
        rootstock: { package: input.package, ...(ecosystem.name === 'npm' ? {} : { ecosystem: ecosystem.name }), verified: version },
        mechanism: input.mechanism,
        ...(input.targets?.length ? { targets: input.targets } : {}),
        variants: [{ range: ecosystem.scheme.fromMajor(version), module: variantFile }],
        ...adapter.scaffoldFrontmatter?.({ ...scaffold, version }),
        status: 'applied',
      }),
    ],
    [
      path.join(dir, variantFile),
      adapter.variantTemplate?.(scaffold) ??
        `// Variant for ${input.package}. Implement the ${input.mechanism} mechanism here.\nexport default {};\n`,
    ],
  ];
  for (const [file, content] of files) await writeFile(file, content);
  return files.map(([f]) => f);
}
