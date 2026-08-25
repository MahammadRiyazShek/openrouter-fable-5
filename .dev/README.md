# Dev harness (optional — not needed to deploy)

Nothing in this folder is used by the site. Delete it and the app is unchanged.

The app has no build step and no test framework, so these are plain Node scripts
run against a small hand-written DOM stub (`shim.mjs`), which is enough to
evaluate the modules and exercise the pure logic. They import straight from
`../js`, so there is no copy of the source to fall out of date.

```bash
node .dev/all.mjs            # everything below, in order
```

Individually:

```bash
node .dev/render-test.mjs    # markdown fences -> files, label promotion, preview stitching
node .dev/ingest-test.mjs    # zip walking, offset-view decoding, skip rules, message assembly
node .dev/api-test.mjs       # SSE stream parsing, error mapping, catalogue, store persistence
node .dev/run.mjs            # boots app.js: catches TDZ / missing-element / boot() errors
node .dev/bundle.mjs         # rebuilds single-file/index.html from js/*.js + styles.css
node .dev/verify-single.mjs  # checks the one-file build parses, boots and finds its elements
```

`bundle.mjs` is the only script that writes anything. Run it after changing
any file in `js/` or `styles.css`, or the single-file build will lag behind
the module build.
