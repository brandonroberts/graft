export { createPatchAdapter, patchAdapter, MECHANISM } from './adapter.js';
export * from './patchfile.js';
export * from './pnpm.js';
export { manifestRoot, bunApplier, npmApplier, yarnApplier, yarnPatchSpec, npmMajor, NPM_NATIVE_PATCH_MAJOR, vendorApplier, graftApplier, GRAFT_POSTINSTALL, patchPackageApplier, pnpmApplier, selectApplier, toPatchPackageFormat, patchPackageFileName, PATCH_PACKAGE_DIR, type ApplierName, type ApplierContext, type PatchApplier } from './appliers.js';
export { buildVendorTarball, installVendoredTarball, tarballContents, vendoredTarballProblems, vendorFileName, VENDOR_DIR, type TarballBuilder, type VendorContext } from './vendor.js';
export { applyToInstalledCopy, findInstalledCopies, writeNewInode } from './installed.js';
export { patchAdapter as default } from './adapter.js';
