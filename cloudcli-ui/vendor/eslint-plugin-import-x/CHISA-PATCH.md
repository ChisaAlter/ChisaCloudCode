# Chisa compatibility patch

Source: https://registry.npmjs.org/eslint-plugin-import-x/-/eslint-plugin-import-x-4.17.1.tgz

Integrity: sha512-4cdstYkKCyjumM2Q9NSI03K8D2a9F4Ssz33K2lv2hQa4KmR9jPLwk3uWGtNvclfqBrPGfGuMBwsGMbe6dMRbfg==

Version4.17.1-chisa.1 retains upstream MIT license and all rules. Changes only dependency minimatch11.0.3 and no-internal-modules makeRe/RegExp.test to Minimatch/Minimatch.match in ESM+CJS. Required by minimatch GHSA-g3hv-75wg-m249; latest upstream plugin still statically imports removed makeRe. Provenance and exact before/after SHA256 are retained alongside parent candidate. Contract tests cover allow/forbid real resolved paths, relative/scoped/normalized Windows inputs, ESLint ESM+CJS and the actual oxlint bridge. Full upstream296-file content hashes are verified on Windows and Linux; only the3recorded files differ. Provenance copies, LICENSE and exact applicable COMPAT-PATCH.diff ship beside this file. To rebuild source without touching this reviewed directory, run `node rebuild-from-upstream.mjs <absolute-empty-output-root>`; it verifies the official tarball SHA512 before extraction and rejects an existing target. Pack that rebuilt source with `npm pack <output-root>/vendor/eslint-plugin-import-x --ignore-scripts`, then compare the recorded source hashes. Added notes/provenance do not change the previously packed local dependency tarball bytes.

Run the standalone maintenance checks from the repository root after ordinary installation:

```sh
node --test vendor/eslint-plugin-import-x/maintenance.test.mjs
```

All7checks passed on the candidate graph. They verify the296pinned source/installed file hashes, ESM+CJS forbidden imports, allowed/denied real resolved imports,42captured oldmakeRe vectors, dot/brace/extglob/Windows contracts, bounded amplification in a worker and the actual oxlintJSbridge. matcher-baseline.json retains the original minimatch10.2.6 source hash and expected values; it does not require installing an affected old version. These tests require normal root devDependencies but no audit-directory paths, network or provider credentials. Temporary test directories are uniquely created and cleaned after use.
