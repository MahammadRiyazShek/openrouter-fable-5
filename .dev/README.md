# Dev harness (optional — not needed to deploy)

Nothing in this folder is used by the site. Delete it and the app is unchanged.

The app has no build step and no test framework, so these are plain Node scripts
run against a small hand-written DOM stub (`shim.mjs`), which is enough to
evaluate the modules and exercise the pure logic.

```bash
cd .dev
cp ../js/*.js .          # the scripts import siblings, so copy the modules in
node render-test.mjs     # markdown fences -> files, label promotion, preview stitching
node api-test.mjs        # SSE stream parsing, error mapping, catalogue, store persistence
node run.mjs             # boots app.js: catches TDZ / missing-element / boot() errors
```

`*.js` copies are gitignored, so the folder stays clean afterwards.
