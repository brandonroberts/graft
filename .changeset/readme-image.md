---
'@graftsync/cli': patch
---

The README on npm shows its workflow image again. The packed README pointed images at the release tag, which the Release workflow creates only after publishing, so npmjs.com's first fetch of the image (which it caches) was a 404. Images now point at the published commit, which is on GitHub before the publish; links still point at the tag.
