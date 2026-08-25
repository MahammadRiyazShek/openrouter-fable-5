# Blueprint

A workbench for OpenRouter that runs entirely in your browser. Paste your API key, pick a model, attach anything — a zip of a codebase, a PDF spec, a spreadsheet, a screenshot — and ask for what you want built. Whatever the model writes back as files is collected in a side panel you can preview and download as a zip.

No server, no build step, no `npm install`. Nothing is proxied through anyone else: your key goes from your browser straight to `openrouter.ai`.

## Two builds. Use the first one.

**`single-file/index.html`** is the whole app in one file — HTML, CSS and JavaScript inlined, no folders, no dependencies at upload time. Upload that one file and there is nothing left that can go missing. This is the build to use if a previous upload half-completed, or if you just want the shortest path to a working site.

The multi-file build at the repository root is the same app with the source split up (`styles.css`, `js/*.js`). It is nicer to edit and it is what the single file is generated from, but it has one failure mode worth understanding: the browser loads `js/app.js` as an ES module, and if any one module is missing the **entire** module graph fails. The page still draws, and then nothing works — no attach button, no send, no key dialog. A partly-finished upload looks exactly like a broken app.

Both builds are byte-identical in behaviour. Rebuild the single file after editing the source with:

```bash
node .dev/bundle.mjs
```

## Putting it online

### GitHub Pages, the short way

Create a new repository. On the empty repo page choose **uploading an existing file**, drag in `single-file/index.html`, and **rename it to `index.html`** so it sits at the root — the file box lets you edit the name before committing. Commit. Then **Settings → Pages → Source: Deploy from a branch**, branch `main`, folder `/ (root)`, Save. Give it a minute and the site is at `https://<your-user>.github.io/<repo>/`.

Watch the commit finish before you navigate away. A red ✗ next to the commit means a workflow failed, not that your files are missing; a spinner means it is still going. If files are missing from the repository's file list, the upload did not complete — do it again rather than assuming Pages will catch up.

### GitHub Pages, the whole repository

Upload everything, keeping the folder layout intact:

```
index.html                          app shell and dialogs
styles.css                          the whole design system
favicon.svg
js/config.js                        endpoints, defaults, limits, CDN loader
js/store.js                         state, localStorage persistence, chat history
js/api.js                           OpenRouter models / key / chat + SSE streaming
js/ingest.js                        zip, PDF, docx, xlsx, image, text extraction
js/render.js                        markdown rendering and fences -> files
js/app.js                           wiring: UI, events, turns, panels
single-file/index.html              the one-file build (generated)
vercel.json                         headers and clean URLs for Vercel
.nojekyll                           stops GitHub Pages from filtering files
.github/workflows/deploy-pages.yml  Pages deploy via Actions
README.md
.dev/                               test harness — optional, delete if you like
```

Then either set **Settings → Pages → Source** to **GitHub Actions** and let the included workflow publish the root on every push, or use **Deploy from a branch** with `main` and `/ (root)` and delete the workflow file. Drag-and-drop upload in the GitHub web UI does preserve folders if you drag the `js` folder itself rather than the loose files inside it.

`.nojekyll` matters more than it looks: without it Pages runs the tree through Jekyll, which ignores paths beginning with an underscore. Keep the empty file.

### Vercel

Import the repository at [vercel.com/new](https://vercel.com/new). Framework preset **Other**, build command empty, output directory `.`. There is nothing to compile, so the deploy is a file copy. `vercel.json` adds a few security headers and tells Vercel not to cache `js/*` or `styles.css`, so a redeploy shows up immediately instead of after a cache expiry.

If you only want the single-file build on Vercel, put that one `index.html` in an otherwise empty repository — the settings above are unchanged.

### Running it from your own machine

The single file opens by double-clicking it. No server needed, because it is a classic script rather than a module.

The multi-file build needs a server, since browsers refuse to load ES modules over `file://`:

```bash
cd path/to/the/repo
python3 -m http.server 8000
# then open http://localhost:8000
```

## First run

Click **Connect your API key**, paste your OpenRouter key — it starts with `sk-or-` — and save. The key is verified against `GET /api/v1/key`, which also reads back your credit and rate-limit status, then the model catalogue loads.

The model list comes live from your account, so whichever Claude Fable release your key can see appears in the picker without anything here needing to change. The default is resolved at runtime against that list: anything matching `fable` wins, then Claude Sonnet/Opus 4, then any Anthropic model. There is also a field in the picker for typing an exact model ID if you want one that isn't listed.

From there: type a prompt, drag files anywhere onto the window, or paste an image straight into the composer. There is no length limit on the message box — paste an entire file into it if you like. The context meter underneath estimates how much of the model's window your attachments will occupy before you send, and warns you if you've attached an image to a model without vision.

## When something doesn't work

Open **Settings → Run self-check**. It reports the build type, browser support, storage, key and model status, then loads each parser library and finally generates a zip and reads it back through the real attachment path. Any line marked FAILED is the actual cause.

The most common real fault is a blocked CDN. Parsers for zip, PDF, Word and Excel files are fetched on demand from jsDelivr, with unpkg and cdnjs as fallbacks, because several ISPs — Indian ones especially — block `cdn.jsdelivr.net` outright. If all three are unreachable the self-check says so by name. An ad blocker or a corporate proxy can do the same thing; try a private window with extensions disabled.

If the page comes up and nothing at all responds, wait four seconds: a watchdog in the page will replace the screen with a message naming whatever failed to load. Chat and markdown keep working when a CDN is blocked — only file reading and syntax colouring need those libraries.

## About the key

This is a static site with no backend, so the key is used directly from the browser. It is stored only in your own browser — `localStorage` if you tick "keep this key on this device", otherwise `sessionStorage`, which forgets it when the tab closes — and sent only to `openrouter.ai` over HTTPS as an `Authorization` header. No telemetry, no proxy.

The trade-off worth knowing: anyone who can open the deployed page, or read your browser storage, can spend from that key. If you publish the URL, treat that as sharing the key. Two sensible precautions: create a dedicated OpenRouter key for this site so you can revoke it on its own, and set a credit limit on it in the OpenRouter dashboard. Keeping the key out of the browser entirely would need a server-side proxy, which this project deliberately doesn't have.

## Limits and behaviour worth knowing

Uploads are capped so a careless drop can't freeze the tab: 48 MB per file, 800 KB and 400 entries per zip, 120 PDF pages, 12 MB per image, roughly 220k characters per extracted file and 900k across one message's attachments. Anything longer is truncated with a visible marker rather than silently dropped. Inside a zip, binaries are skipped along with `node_modules`, `.git`, lockfiles, minified files and build output; the full listing is still sent so the model knows what exists and can ask for a specific path.

Chat history lives in `localStorage`, which is a few megabytes at best. When it fills, the oldest attachment payloads are pruned first so the transcripts survive. History is per-browser and per-origin — it does not sync between devices.

For files the model writes: it is asked to put the path on the code fence, like ` ```js src/app.js `. The cut sheet folds revisions across turns so the newest version of each path wins, and offers per-file copy, whole-project zip, and a sandboxed preview that inlines sibling CSS and JS so a generated multi-file site runs without a server.

## Licence

MIT. Do what you like with it.
