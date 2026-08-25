# Blueprint

A single-page workbench for OpenRouter. Paste your API key, pick a model, attach anything — a zip of a codebase, a PDF spec, a spreadsheet, a screenshot — and ask it to build what you need. Whatever the model writes back as files gets collected into a side panel you can preview and download as a zip.

There is no server, no build step and no npm install. Every file in this repository is shipped to the browser exactly as it sits on disk, which is why the same commit deploys unchanged to GitHub Pages and to Vercel.

## What you get

The chat itself streams token by token, keeps a local history of conversations, renders markdown with syntax highlighting, and shows token usage and cost per reply when OpenRouter reports it. Uploads are read entirely in your own browser: zips are walked and the interesting text files pulled out, PDFs are parsed to text (or handed to OpenRouter's native PDF pipeline if you prefer), Word and Excel files are converted, images are sent as image parts to vision-capable models. The "cut sheet" on the right watches every reply for fenced code blocks that name a file, folds revisions across turns so the newest version of each path wins, and offers per-file copy and save, a whole-project zip, and a sandboxed live preview that inlines sibling CSS and JS so a generated multi-file site runs without a server.

The model list is fetched live from your account, so whichever Claude Fable release your key can see shows up in the picker without anything here needing to change. The default model is resolved at runtime against that list — anything matching `fable` is preferred, then Claude Sonnet/Opus 4, then any Anthropic model — and there's a manual field in the picker if you want to type an exact model ID.

## Files in this repository

Upload all of these, keeping the layout intact:

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
vercel.json                         headers and clean URLs for Vercel
.nojekyll                           stops GitHub Pages from filtering files
.gitignore
.github/workflows/deploy-pages.yml  Pages deploy via Actions (see below)
README.md
.dev/                               test harness — optional, delete if you like
```

`.nojekyll` matters more than it looks: without it GitHub Pages runs the tree through Jekyll, which ignores paths beginning with an underscore and can interfere with asset serving. Keep the empty file.

`.dev/` holds a small Node test harness (117 assertions over the fence parser, the SSE stream reader, error mapping and storage pruning) that runs against a hand-written DOM stub. It is never loaded by the site — see `.dev/README.md` if you want to run it.

## Deploying to GitHub Pages

Create a repository, push these files to the root of the default branch (not into a subfolder), then in the repository open **Settings → Pages**. Either source works:

Choose **GitHub Actions** and the included workflow publishes the repo root on every push to `main`. Or choose **Deploy from a branch**, set branch to `main` and folder to `/ (root)`, and Pages serves the files directly — in that case the workflow file is harmless and can be deleted.

The site lands at `https://<user>.github.io/<repo>/`. Every path in the project is relative, so the subdirectory is not a problem.

## Deploying to Vercel

Import the repository at [vercel.com/new](https://vercel.com/new). When Vercel asks about the framework, choose **Other**, leave the build command empty and set the output directory to the repository root (`.`). There is nothing to compile, so the deploy is a file copy. `vercel.json` adds a few security headers and tells Vercel not to cache `js/*` or `styles.css`, so a redeploy shows up immediately instead of after a cache expiry.

## Running it locally

The app uses ES modules, which browsers refuse to load over `file://`. Serve the folder instead:

```bash
cd path/to/the/repo
python3 -m http.server 8000
# then open http://localhost:8000
```

`npx serve` works equally well if you'd rather use Node.

## First run

Click **Add key** (or the key badge in the sidebar), paste your OpenRouter key — it starts with `sk-or-` — and save. The key is verified against `GET /api/v1/key`, which also reads back your credit and rate-limit status, then the model catalogue loads. Tick "Remember on this device" to keep the key in `localStorage`; leave it unticked and it lives in `sessionStorage` and disappears when you close the tab.

From there: type a prompt, or drag files anywhere onto the window, or paste an image straight into the composer. The context meter under the composer estimates how much of the model's window your attachments will occupy before you send, and warns you if you've attached an image to a model without vision.

Settings (gear icon, bottom of the sidebar) covers the system prompt, temperature, max output tokens, how many previous turns to resend, PDF handling (parse locally vs. let OpenRouter parse it), streaming, and whether to display reasoning tokens. There's also an export button that writes your whole history to JSON, and a wipe button that clears everything including the key.

## About the key

This is a static site with no backend, so your key is used directly from the browser: it is stored only in your own browser storage and sent only to `openrouter.ai` over HTTPS, as an `Authorization` header. Nothing is proxied through a third party and no telemetry is collected.

The trade-off worth knowing: anyone who can use the deployed page — or read your browser storage — can spend from that key. If you publish the URL, treat it like sharing the key. Two sensible precautions are to create a dedicated OpenRouter key for this site so you can revoke it independently, and to set a credit limit on that key in the OpenRouter dashboard. If you'd rather the key never reach the browser at all, that requires a server-side proxy, which by design this project doesn't have.

## Limits and behaviour worth knowing

Uploads are capped to keep a careless drop from freezing the tab: 48 MB per file, 800 KB and 400 entries per zip, 120 PDF pages, 12 MB per image, and roughly 220k characters per extracted file with a 900k ceiling across one message's attachments. Anything longer is truncated with a visible marker rather than silently dropped. Binary files inside a zip are skipped, as are `node_modules`, `.git`, lockfiles and build output.

Chat history lives in `localStorage`, which is a few megabytes at best. When it fills up the oldest attachment payloads are pruned first so your conversations survive; the transcript is what's worth keeping. History is per-browser and per-origin — it does not sync between devices.

Third-party parsers (marked, DOMPurify, highlight.js, JSZip, pdf.js, mammoth, SheetJS) load on demand from jsDelivr the first time a feature needs them. If a CDN is blocked, markdown falls back to plain text and code stays unhighlighted rather than the page breaking.

## Licence

MIT. Do what you like with it.
