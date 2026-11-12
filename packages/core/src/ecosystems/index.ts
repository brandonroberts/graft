import type { Ecosystem } from '../ecosystem.js';
import { cargoEcosystem } from './cargo.js';
import { npmEcosystem } from './npm.js';

export { npmEcosystem, cargoEcosystem };
export { cargoManifest, cargoMetadata, sparseIndexPath, CargoUpstreamSource, type CargoOptions, type CargoPackage } from './cargo.js';
export { tool, fetchText, channelTags, posixPath, type ToolResult } from './util.js';

/** Every ecosystem a project knows (`rootstock.ecosystem`). */
export const BUILTIN_ECOSYSTEMS: Ecosystem[] = [npmEcosystem, cargoEcosystem];
