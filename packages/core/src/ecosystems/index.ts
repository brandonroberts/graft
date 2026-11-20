import type { Ecosystem } from '../ecosystem.js';
import { cargoEcosystem } from './cargo.js';
import { goEcosystem } from './go.js';
import { npmEcosystem } from './npm.js';
import { pypiEcosystem } from './pypi.js';

export { npmEcosystem, cargoEcosystem, goEcosystem, pypiEcosystem };
export {
  declaredPypiDependencies,
  detectPythonTool,
  findPypiSiblings,
  pypiName,
  pypiOptions,
  pypiRepoKey,
  pythonFor,
  wheelDistName,
  PypiUpstreamSource,
  type PypiOptions,
} from './pypi.js';
export {
  findGoSiblings,
  goListModule,
  goModuleDir,
  goRepoKey,
  goVersion,
  parseGoListJsonStream,
  GoUpstreamSource,
  type GoListModule,
  type GoOptions,
} from './go.js';
export {
  cargoManifest,
  cargoMetadata,
  findCargoSiblings,
  sparseIndexPath,
  CargoUpstreamSource,
  type CargoMetadata,
  type CargoOptions,
  type CargoPackage,
} from './cargo.js';
export { tool, fetchText, channelTags, posixPath, type ToolResult } from './util.js';

/** Every ecosystem a project knows (`rootstock.ecosystem`). */
export const BUILTIN_ECOSYSTEMS: Ecosystem[] = [npmEcosystem, cargoEcosystem, goEcosystem, pypiEcosystem];
