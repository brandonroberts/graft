export { createPatchAdapter, patchAdapter, MECHANISM } from './adapter.js';
export * from './patchfile.js';
export * from './pnpm.js';
export { bunApplier, npmApplier, npmMajor, NPM_NATIVE_PATCH_MAJOR, vendorApplier, graftApplier, GRAFT_POSTINSTALL, patchPackageApplier, pnpmApplier, selectApplier, toPatchPackageFormat, patchPackageFileName, PATCH_PACKAGE_DIR, type ApplierName, type ApplierContext, type PatchApplier } from './appliers.js';
export { buildVendorTarball, tarballContents, vendorFileName, VENDOR_DIR } from './vendor.js';
export { applyToInstalledCopy, findInstalledCopies, writeNewInode } from './installed.js';
export { patchAdapter as default } from './adapter.js';
