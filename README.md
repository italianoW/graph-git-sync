# Graph GitHub Sync

An Obsidian plugin that publishes an **anonymized snapshot** of your graph view —
node colors, node sizes (by connection count), and connections — to a GitHub repo,
with **no note titles, paths, or content** anywhere in the output. Runs only when
you trigger it manually (command palette), never automatically.

## What it does

1. Reads your vault's link graph via Obsidian's own link cache (`resolvedLinks`) —
   it never opens or reads note content.
2. Reads your vault's existing **graph view color groups** (`.obsidian/graph.json`)
   and matches each note to a group the same way the built-in graph does, to
   assign colors. Notes are then replaced with anonymous ids (`n0`, `n1`, …) —
   the mapping never leaves your machine.
3. Lays the graph out with a self-contained force-directed algorithm
   (no external dependency).
4. Renders it to a plain SVG: circles for nodes, lines for edges, no text at all.
5. Pushes that SVG to your GitHub repo via the Contents API.
6. Optionally rewrites a marker block in your README so the image shows up there.

## ⚠️ Public profile visibility (private vs public repo)

If your goal is to show the graph on your **public** GitHub profile README
(`github.com/<you>`), the target repo for this plugin needs to be **public**.
GitHub requires authentication to read anything — including raw file URLs —
from a private repo, so an `<img>` embed pointing at a private repo's file
will only ever render for you, never for other visitors. It'll just look
broken to everyone else.

**Recommended setup:** don't point this plugin at your (likely private)
vault repo. Instead, use a small, dedicated **public** repo that contains
nothing but this graph asset (and optionally a README), or push straight
into your special public profile repo (`<you>/<you>`, which GitHub requires
to be public anyway for it to show on your profile page). That way:

- The image actually renders for visitors.
- Your vault's private repo — and its full git history — never gets touched
  by this plugin at all, keeping the blast radius of "what's public" as
  small as possible.

The plugin will warn you at publish time (and in settings) if the configured
repo is private while "Update README" is enabled, since that combination
won't work as intended.

## Setup

1. Build the plugin (see below), or grab the built `main.js` + `manifest.json`.
2. Copy `main.js`, `manifest.json`, and `styles.css` (if present) into
   `<your vault>/.obsidian/plugins/graph-github-sync/`.
3. In Obsidian: **Settings → Community plugins**, enable **Graph GitHub Sync**.
4. Open the plugin settings and fill in:
   - **GitHub personal access token** — create one at
     https://github.com/settings/tokens with `repo` scope (classic) or, for a
     fine-grained token, `Contents: Read and write` on the target repo only.
   - **Repo owner / Repo name / Branch**
   - **SVG path in repo** — e.g. `assets/graph.svg`
   - **Update README** toggle — if on, put these two lines somewhere in your
     `README.md` and the plugin will keep the image between them:

     ```md
     <!-- GRAPH-SNAPSHOT:START -->
     <!-- GRAPH-SNAPSHOT:END -->
     ```

     If the markers aren't found, the plugin appends them (and the image) to
     the end of the README automatically on first run.
5. Run the command **"Publish anonymized graph snapshot to GitHub"** from the
   command palette (Cmd/Ctrl+P) whenever you want to push an updated snapshot.

## Animated GIF (nodes appear one by one)

By default the plugin publishes a static SVG. Set **Output format** to
"Animated GIF" in settings and it'll instead publish a looping GIF where
notes appear one at a time — hub-connected notes first, leaves filling in
after — before holding on the completed graph for a beat and looping.
Settings under GIF output:

- **GIF path in repo** — e.g. `assets/graph.gif`
- **Reveal frames** — how many frames the appearance animation spans
- **Frame delay (ms)** — how long each frame is shown
- **Hold frames at end** — extra frames on the completed graph before it loops

It's rendered and GIF-encoded entirely on-device (a small hand-rolled
LZW/GIF89a encoder, same "no external dependency" approach as the graph
layout) — nothing but the finished GIF bytes ever leaves your machine.
Large vaults (thousands of notes) will take noticeably longer to render;
the plugin will warn you and suggest lowering "Reveal frames" if needed.

## Coloring notes

By default colors come from your vault's own Graph view color groups (see
below). You can instead set **Color source** to "Built-in color preset" in
settings to use one of several bundled palettes (Ocean, Sunset, Forest,
Monochrome, Pastel, Obsidian Light) — useful if you haven't set up color
groups, or just want a different look. Presets cycle their palette across
nodes and also set the background/edge colors; they don't require any
Graph view configuration.

Colors come from whatever color groups you've already set up in Obsidian's
native Graph view (Graph view → the gear icon → **Groups**, e.g. a group with
query `path:Projects` colored blue). This plugin re-implements a **small
subset** of Obsidian's search syntax to match those queries:

- `path:foo`, `file:foo`, `tag:#foo` — supported
- Multiple space-separated tokens are ANDed together
- A leading `-` negates a token

More exotic queries (regex, OR groups, `line:`, etc.) may not match exactly —
in that case those notes fall back to the "Default node color" setting.

## Building from source

```bash
npm install
npm run build   # outputs main.js
```

`npm run dev` runs esbuild in watch mode for iterating on the plugin.

## Privacy notes

- No note titles, file paths, tags, or content are included in the generated
  SVG or ever sent to GitHub — only anonymous node ids, colors, sizes, and
  the edge list (as index pairs).
- Your GitHub token is stored in the plugin's local data file
  (`.obsidian/plugins/graph-github-sync/data.json`) inside your vault. Don't
  sync that file to a public repo/backup, and consider using a fine-grained
  token scoped only to the one repo.
- The GitHub Contents API commits the file as a normal commit — anyone with
  read access to the repo (e.g. if it's public) will be able to see graph
  structure and colors, and the SVG file's git history.
