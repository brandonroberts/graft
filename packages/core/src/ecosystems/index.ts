import type { Ecosystem } from '../ecosystem.js';
import { npmEcosystem } from './npm.js';

export { npmEcosystem };

/** Every ecosystem a project knows (`rootstock.ecosystem`). */
export const BUILTIN_ECOSYSTEMS: Ecosystem[] = [npmEcosystem];
