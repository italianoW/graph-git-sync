import {
	App,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	TFile,
	requestUrl,
} from "obsidian";

/* -------------------------------------------------------------------------
 * Settings
 * ---------------------------------------------------------------------- */

type ColorMode = "vault" | "preset";

interface GraphGithubSyncSettings {
	githubToken: string;
	repoOwner: string;
	repoName: string;
	branch: string;
	svgPath: string; // path inside the repo, e.g. "assets/graph.svg"
	updateReadme: boolean;
	readmePath: string; // e.g. "README.md"
	commitMessage: string;
	includeOrphans: boolean;
	includeAttachments: boolean;
	respectExcludedFiles: boolean;
	colorMode: ColorMode;
	colorPreset: string;
	backgroundColor: string;
	defaultNodeColor: string;
	edgeColor: string;
	width: number;
	height: number;
	outputFormat: "svg" | "gif";
	gifPath: string; // path inside the repo, e.g. "assets/graph.gif"
	gifNodesPerFrame: number; // how many new nodes sprout in per frame (1 = strictly one at a time)
	gifFrameDelayMs: number; // per-frame delay
	gifHoldFrames: number; // extra frames holding the completed graph before it loops
}

const DEFAULT_SETTINGS: GraphGithubSyncSettings = {
	githubToken: "",
	repoOwner: "",
	repoName: "",
	branch: "main",
	svgPath: "assets/graph.svg",
	updateReadme: true,
	readmePath: "README.md",
	commitMessage: "Update anonymized graph snapshot",
	includeOrphans: true,
	includeAttachments: false,
	respectExcludedFiles: true,
	colorMode: "vault",
	colorPreset: "ocean",
	backgroundColor: "transparent",
	defaultNodeColor: "#888888",
	edgeColor: "#999999",
	width: 1000,
	height: 700,
	outputFormat: "svg",
	gifPath: "assets/graph.gif",
	gifNodesPerFrame: 1,
	gifFrameDelayMs: 80,
	gifHoldFrames: 15,
};

/* -------------------------------------------------------------------------
 * Built-in color presets — an alternative to reading colors from the
 * vault's own Graph view color groups. Each preset supplies a background,
 * an edge color, and a palette of node colors that get cycled across nodes
 * (in file order) so the snapshot has visual variety even for vaults with
 * no color groups configured.
 * ---------------------------------------------------------------------- */

interface ColorPreset {
	label: string;
	background: string;
	edge: string;
	palette: string[];
}

const COLOR_PRESETS: Record<string, ColorPreset> = {
	ocean: {
		label: "Ocean",
		background: "#0b1b2b",
		edge: "#3a6b8a",
		palette: ["#4fb0e6", "#3ddad0", "#7ee787", "#5c8fd6", "#2fe0c9"],
	},
	sunset: {
		label: "Sunset",
		background: "#1a0f1f",
		edge: "#8a5a6b",
		palette: ["#ff7e5f", "#feb47b", "#ff5f8f", "#f9c74f", "#f3722c"],
	},
	forest: {
		label: "Forest",
		background: "#0f1a12",
		edge: "#4a6b52",
		palette: ["#74c69d", "#40916c", "#95d5b2", "#b7e4c7", "#2d6a4f"],
	},
	monochrome: {
		label: "Monochrome",
		background: "#111111",
		edge: "#555555",
		palette: ["#e0e0e0", "#b0b0b0", "#888888", "#c8c8c8", "#999999"],
	},
	pastel: {
		label: "Pastel",
		background: "#fdfbf7",
		edge: "#cfc9c0",
		palette: ["#a8d8ea", "#aa96da", "#fcbad3", "#ffffd2", "#c7f0bd"],
	},
	obsidianLight: {
		label: "Obsidian Light",
		background: "#ffffff",
		edge: "#c8c8c8",
		palette: ["#7a7ad6", "#e0607e", "#4fa3d1", "#6bb96f", "#d69b4f"],
	},
};

const DEFAULT_COLOR_PRESET_KEY = "ocean";

const README_START_MARKER = "<!-- GRAPH-SNAPSHOT:START -->";
const README_END_MARKER = "<!-- GRAPH-SNAPSHOT:END -->";

/* -------------------------------------------------------------------------
 * Internal graph types
 * ---------------------------------------------------------------------- */

interface GraphNode {
	id: string; // anonymized, e.g. "n0"
	x: number;
	y: number;
	vx: number;
	vy: number;
	degree: number;
	color: string;
}

interface GraphEdge {
	source: number; // index into node array
	target: number;
}

/* -------------------------------------------------------------------------
 * Color group matching (reads the vault's own graph.json color groups)
 * ---------------------------------------------------------------------- */

interface ColorGroup {
	query: string;
	color: { a: number; rgb: number };
}

function rgbToHex(rgb: number): string {
	return "#" + (rgb >>> 0).toString(16).padStart(6, "0").slice(-6);
}

/**
 * Subset of Obsidian's search query syntax, good enough for typical graph
 * color-group rules:
 *  - "OR" as a top-level separator between clauses
 *  - space-separated tokens within a clause, ANDed together (quoted phrases
 *    with internal spaces, e.g. path:"5 - Indexes", are kept as one token)
 *  - "-" negates a token
 *  - path:/file:/tag: prefixes match against the note's path/filename/tags
 *  - a bare quoted wikilink, e.g. "[[Baby]]", matches notes that link OUT to
 *    a note named "Baby" (checked via the vault's own resolved link graph,
 *    no file content is read for this case)
 *  - any other bare/quoted text falls back to a literal, case-insensitive
 *    search of the note's content (mirrors Obsidian's default search
 *    behavior for un-prefixed terms)
 */
const TOKEN_RE = /(-)?(?:(path|file|tag):)?(?:"([^"]*)"|(\S+))/gi;

interface ParsedToken {
	negate: boolean;
	prefix?: string;
	value: string;
}

function parseTokens(clause: string): ParsedToken[] {
	const tokens: ParsedToken[] = [];
	let match: RegExpExecArray | null;
	TOKEN_RE.lastIndex = 0;
	while ((match = TOKEN_RE.exec(clause)) !== null) {
		const [, neg, prefix, quoted, bare] = match;
		const value = quoted !== undefined ? quoted : bare ?? "";
		if (!value) continue;
		tokens.push({ negate: !!neg, prefix: prefix?.toLowerCase(), value });
	}
	return tokens;
}

async function fileMatchesQuery(
	app: App,
	file: TFile,
	query: string,
	tags: string[],
	outgoingLinkNames: string[],
	contentCache: Map<string, string>
): Promise<boolean> {
	const orBranches = query.split(/\bOR\b/i).map((s) => s.trim()).filter(Boolean);
	if (orBranches.length > 1) {
		for (const branch of orBranches) {
			if (
				await fileMatchesQuery(app, file, branch, tags, outgoingLinkNames, contentCache)
			) {
				return true;
			}
		}
		return false;
	}

	const tokens = parseTokens(query);
	if (tokens.length === 0) return false;

	for (const { negate, prefix, value } of tokens) {
		const lowerVal = value.toLowerCase();
		let matched: boolean;

		if (prefix === "path") {
			matched = file.path.toLowerCase().includes(lowerVal);
		} else if (prefix === "file") {
			matched = file.path.toLowerCase().split("/").pop()!.includes(lowerVal);
		} else if (prefix === "tag") {
			const needle = lowerVal.startsWith("#") ? lowerVal : "#" + lowerVal;
			matched = tags.some((t) => t.toLowerCase() === needle);
		} else {
			const linkMatch = value.match(/^\[\[(.+?)(\|.*)?\]\]$/);
			if (linkMatch) {
				const targetName = linkMatch[1].toLowerCase().split("/").pop()!;
				matched = outgoingLinkNames.some((n) => n.toLowerCase() === targetName);
			} else {
				let content = contentCache.get(file.path);
				if (content === undefined) {
					try {
						content = await app.vault.cachedRead(file);
					} catch {
						content = "";
					}
					contentCache.set(file.path, content);
				}
				matched = content.toLowerCase().includes(lowerVal);
			}
		}

		if (negate) matched = !matched;
		if (!matched) return false; // AND semantics within a clause
	}
	return true;
}

async function loadColorGroups(app: App): Promise<ColorGroup[]> {
	const path = `${app.vault.configDir}/graph.json`;
	try {
		const exists = await app.vault.adapter.exists(path);
		if (!exists) {
			console.warn(
				`Graph GitHub Sync: no ${path} found. Open Graph view, add at least one color group under the gear icon → Groups, then close the graph settings (this is what creates the file).`
			);
			return [];
		}
		const raw = await app.vault.adapter.read(path);
		const parsed = JSON.parse(raw);
		const groups = parsed?.colorGroups;
		if (Array.isArray(groups) && groups.length > 0) {
			const valid = groups.filter((g: any) => g?.query && g?.color);
			console.log(
				`Graph GitHub Sync: loaded ${valid.length} color group(s) from ${path}:`,
				valid.map((g: any) => g.query)
			);
			return valid.map((g: any) => ({ query: g.query, color: g.color }));
		}
		console.warn(
			`Graph GitHub Sync: ${path} exists but has no color groups configured. Add one in Graph view → gear icon → Groups.`
		);
	} catch (e) {
		console.error(`Graph GitHub Sync: error reading ${path}`, e);
	}
	return [];
}

/* -------------------------------------------------------------------------
 * Excluded files (Settings → Files & Links → Excluded files)
 * ---------------------------------------------------------------------- */

/**
 * Obsidian keeps the "Excluded files" list in `Vault.getConfig("userIgnoreFilters")`.
 * It's not part of the public plugin API surface, but it's the same accessor
 * real-world plugins that toggle/extend this exact setting rely on (e.g.
 * "Toggle Excluded Folders"), and — critically — it reads Obsidian's live,
 * in-memory config. Reading `.obsidian/app.json` straight off disk (the
 * previous approach here) is NOT equivalent: Obsidian debounces writing
 * settings to disk, so a freshly-edited exclude list can still be missing
 * from app.json for a few seconds, and on some setups the file read raced
 * that debounce every time — which is why exclusions silently did nothing.
 */
function getUserIgnoreFilters(app: App): string[] {
	try {
		const raw = (app.vault as any).getConfig?.("userIgnoreFilters");
		if (Array.isArray(raw)) {
			return raw.filter((f) => typeof f === "string" && f.length > 0);
		}
	} catch (e) {
		console.error("Graph GitHub Sync: error reading userIgnoreFilters via Vault.getConfig", e);
	}
	return [];
}

/** Last-resort fallback if `Vault.getConfig` is ever removed: read the raw
 * filter list straight out of app.json. Kept only so the plugin degrades
 * gracefully instead of throwing — getUserIgnoreFilters() above is what
 * actually runs in practice.
 */
async function loadRawExcludeFiltersFromDisk(app: App): Promise<string[]> {
	const path = `${app.vault.configDir}/app.json`;
	try {
		const exists = await app.vault.adapter.exists(path);
		if (!exists) return [];
		const raw = await app.vault.adapter.read(path);
		const parsed = JSON.parse(raw);
		const filters = parsed?.userIgnoreFilters;
		return Array.isArray(filters) ? filters.filter((f) => typeof f === "string" && f.length > 0) : [];
	} catch (e) {
		console.error(`Graph GitHub Sync: error reading ${path}`, e);
		return [];
	}
}

/** Matches Obsidian's excluded-files rules against a vault path:
 *  - pattern ending in "/": excludes that folder (and everything under it)
 *  - pattern containing "/": treated as a path, excludes exact path or
 *    anything nested under it
 *  - bare pattern with no "/": matches a file/folder name at any level, or
 *    a file extension (e.g. "png" excludes all *.png files)
 */
function buildExcludeMatcherFromFilters(filters: string[]): (path: string) => boolean {
	return (path: string) => {
		const segments = path.split("/");
		const filename = segments[segments.length - 1];
		for (const f of filters) {
			if (f.endsWith("/")) {
				if (path === f.slice(0, -1) || path.startsWith(f)) return true;
			} else if (f.includes("/")) {
				if (path === f || path.startsWith(f + "/")) return true;
			} else {
				if (filename === f) return true;
				if (filename.toLowerCase().endsWith("." + f.toLowerCase())) return true;
				if (segments.includes(f)) return true;
			}
		}
		return false;
	};
}

async function buildExcludeMatcher(app: App): Promise<(path: string) => boolean> {
	let filters = getUserIgnoreFilters(app);
	if (filters.length === 0) {
		filters = await loadRawExcludeFiltersFromDisk(app);
	}
	if (filters.length === 0) return () => false;
	console.log(`Graph GitHub Sync: excluding files matching ${filters.length} filter(s):`, filters);
	return buildExcludeMatcherFromFilters(filters);
}

/* -------------------------------------------------------------------------
 * Force-directed layout (Fruchterman-Reingold, self-contained)
 * ---------------------------------------------------------------------- */

function layoutGraph(
	nodes: GraphNode[],
	edges: GraphEdge[],
	width: number,
	height: number
) {
	const n = nodes.length;
	if (n === 0) return;

	const area = width * height;
	const k = Math.sqrt(area / n);
	const iterations = n > 800 ? 80 : 200;

	// deterministic-ish random start, spread across a circle
	nodes.forEach((node, i) => {
		const angle = (i / n) * Math.PI * 2;
		const r = Math.min(width, height) * 0.35 * Math.sqrt(Math.random());
		node.x = width / 2 + Math.cos(angle) * r;
		node.y = height / 2 + Math.sin(angle) * r;
		node.vx = 0;
		node.vy = 0;
	});

	let temperature = Math.min(width, height) * 0.1;
	const cooling = temperature / iterations;
	const cx = width / 2;
	const cy = height / 2;

	for (let iter = 0; iter < iterations; iter++) {
		// repulsive forces (all pairs)
		for (let i = 0; i < n; i++) {
			nodes[i].vx = 0;
			nodes[i].vy = 0;
		}
		for (let i = 0; i < n; i++) {
			for (let j = i + 1; j < n; j++) {
				let dx = nodes[i].x - nodes[j].x;
				let dy = nodes[i].y - nodes[j].y;
				let dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
				const force = (k * k) / dist;
				const fx = (dx / dist) * force;
				const fy = (dy / dist) * force;
				nodes[i].vx += fx;
				nodes[i].vy += fy;
				nodes[j].vx -= fx;
				nodes[j].vy -= fy;
			}
		}

		// attractive forces (edges)
		for (const edge of edges) {
			const a = nodes[edge.source];
			const b = nodes[edge.target];
			let dx = a.x - b.x;
			let dy = a.y - b.y;
			let dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
			const force = (dist * dist) / k;
			const fx = (dx / dist) * force;
			const fy = (dy / dist) * force;
			a.vx -= fx;
			a.vy -= fy;
			b.vx += fx;
			b.vy += fy;
		}

		// mild pull toward the canvas center, same idea as core Graph view's
		// centering force. This isn't just cosmetic — it's what keeps every
		// node (especially orphans with no edges to anchor them) bounded at
		// all, now that positions are no longer clamped to the canvas walls
		// below. Without it, an unconnected node would drift outward forever.
		const centerStrength = 0.04;
		for (const node of nodes) {
			node.vx += (cx - node.x) * centerStrength;
			node.vy += (cy - node.y) * centerStrength;
		}

		// apply displacement, capped by temperature. Deliberately NOT clamped
		// to the canvas bounds here: hard-clamping mid-simulation was pinning
		// repelled/orphan nodes to x=0/width or y=0/height, producing visible
		// straight rows of nodes along the edges instead of a natural spread.
		// The center-gravity force above keeps things bounded instead, and
		// renderSvg() fits + centers the true bounding box into the canvas
		// afterward, so nothing needs to be clamped while it's still moving.
		for (const node of nodes) {
			const disp = Math.sqrt(node.vx * node.vx + node.vy * node.vy) || 0.01;
			node.x += (node.vx / disp) * Math.min(disp, temperature);
			node.y += (node.vy / disp) * Math.min(disp, temperature);
		}

		temperature -= cooling;
	}

	// final recentering pass: shift the whole layout so its bounding-box
	// center lands exactly on the canvas center, undoing any residual drift
	// left over from the simulation (odd node counts, asymmetric graphs, etc.)
	const xs = nodes.map((n) => n.x);
	const ys = nodes.map((n) => n.y);
	const boundsCx = (Math.min(...xs) + Math.max(...xs)) / 2;
	const boundsCy = (Math.min(...ys) + Math.max(...ys)) / 2;
	const dx = cx - boundsCx;
	const dy = cy - boundsCy;
	for (const node of nodes) {
		node.x += dx;
		node.y += dy;
	}
}

/* -------------------------------------------------------------------------
 * Shared render geometry — used by both the static SVG renderer and the
 * animated GIF frame renderer so they stay pixel-consistent with each other.
 * ---------------------------------------------------------------------- */

interface RenderGeometry {
	positions: { x: number; y: number }[];
	radiusFor: (degree: number) => number;
}

function computeRenderGeometry(
	nodes: GraphNode[],
	width: number,
	height: number
): RenderGeometry {
	const margin = 24;

	// Fit the graph into the canvas, but center it on where the graph is
	// actually *dense* rather than on the raw bounding-box midpoint. A
	// bbox midpoint gets dragged around by a handful of far-flung/orphan
	// nodes — e.g. a tight, heavily-linked cluster plus a few stray
	// unconnected notes off to one side ends up with the whole thing
	// visually off-center, because the box midpoint sits in the empty gap
	// between them, not in the cluster. Weighting each node's contribution
	// to the center by its degree (well-connected nodes count for more)
	// keeps the dense "body" of the graph anchored in the middle instead.
	const xs = nodes.map((n) => n.x);
	const ys = nodes.map((n) => n.y);
	const minX = Math.min(...xs);
	const maxX = Math.max(...xs);
	const minY = Math.min(...ys);
	const maxY = Math.max(...ys);

	let weightSum = 0;
	let wx = 0;
	let wy = 0;
	for (const n of nodes) {
		const w = 1 + n.degree; // orphans still count a little, hubs count a lot
		weightSum += w;
		wx += n.x * w;
		wy += n.y * w;
	}
	const centroidX = weightSum > 0 ? wx / weightSum : (minX + maxX) / 2;
	const centroidY = weightSum > 0 ? wy / weightSum : (minY + maxY) / 2;

	// Scale so every node still fits inside the canvas even though we're
	// anchoring on the density centroid instead of the bbox center: take
	// the tightest of the four half-extents (left/right/top/bottom of the
	// centroid), uniformly, so circles stay circular and nothing spills
	// past the margin. Sparse outliers end up nearer the edge — which is
	// the correct, honest picture of a graph that really is lopsided.
	const halfW = (width - margin * 2) / 2;
	const halfH = (height - margin * 2) / 2;
	const scale = Math.min(
		halfW / Math.max(1, centroidX - minX),
		halfW / Math.max(1, maxX - centroidX),
		halfH / Math.max(1, centroidY - minY),
		halfH / Math.max(1, maxY - centroidY)
	);

	const canvasCx = width / 2;
	const canvasCy = height / 2;

	const positions = nodes.map((n) => ({
		x: canvasCx + (n.x - centroidX) * scale,
		y: canvasCy + (n.y - centroidY) * scale,
	}));

	const maxDegree = Math.max(1, ...nodes.map((n) => n.degree));
	const radiusFor = (degree: number) => 2.5 + Math.sqrt(degree / maxDegree) * 7;

	return { positions, radiusFor };
}

/** Resolves the effective edge/background colors for the current settings,
 * accounting for preset mode overriding the custom color fields. */
function effectiveColors(settings: GraphGithubSyncSettings): {
	edgeColor: string;
	backgroundColor: string;
} {
	const usePreset = settings.colorMode === "preset";
	const preset = COLOR_PRESETS[settings.colorPreset] ?? COLOR_PRESETS[DEFAULT_COLOR_PRESET_KEY];
	return {
		edgeColor: usePreset ? preset.edge : settings.edgeColor,
		backgroundColor: usePreset ? preset.background : settings.backgroundColor,
	};
}

/* -------------------------------------------------------------------------
 * SVG rendering — no note names anywhere, just circles + lines + colors
 * ---------------------------------------------------------------------- */

function renderSvg(
	nodes: GraphNode[],
	edges: GraphEdge[],
	settings: GraphGithubSyncSettings
): string {
	const { width, height } = settings;
	const { edgeColor, backgroundColor } = effectiveColors(settings);
	const { positions, radiusFor } = computeRenderGeometry(nodes, width, height);

	let edgeLines = "";
	for (const e of edges) {
		const a = positions[e.source];
		const b = positions[e.target];
		edgeLines += `<line x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(
			1
		)}" x2="${b.x.toFixed(1)}" y2="${b.y.toFixed(
			1
		)}" stroke="${edgeColor}" stroke-width="0.6" stroke-opacity="0.5" />\n`;
	}

	let nodeCircles = "";
	nodes.forEach((n, i) => {
		const p = positions[i];
		const r = radiusFor(n.degree);
		nodeCircles += `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(
			1
		)}" r="${r.toFixed(1)}" fill="${n.color}" />\n`;
	});

	const bg =
		backgroundColor && backgroundColor !== "transparent"
			? `<rect width="100%" height="100%" fill="${backgroundColor}" />`
			: "";

	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">
${bg}
<g>
${edgeLines}${nodeCircles}
</g>
</svg>`;
}

/* -------------------------------------------------------------------------
 * Animated GIF rendering — same layout as the SVG, but nodes are revealed
 * progressively (hub-first) across a handful of frames, encoded as a
 * self-contained GIF89a with no external dependency (small hand-rolled
 * LZW encoder + a frequency-based color quantizer), same spirit as the
 * force-directed layout above.
 * ---------------------------------------------------------------------- */

/** Renders one frame of the reveal animation to a 2D canvas context and
 * returns the resulting ImageData. `revealed` controls which node indices
 * (and, transitively, which edges) are drawn this frame; `justSprouted`
 * are nodes that appeared *this* frame — drawn slightly larger for one
 * frame as a little "pop", so growth reads as events, not just a static
 * count going up. */
function renderGifFrame(
	ctx: CanvasRenderingContext2D,
	width: number,
	height: number,
	nodes: GraphNode[],
	edges: GraphEdge[],
	geometry: RenderGeometry,
	revealed: Set<number>,
	justSprouted: Set<number>,
	edgeColor: string,
	backgroundColor: string,
	transparentBg: boolean
): ImageData {
	ctx.clearRect(0, 0, width, height);
	if (!transparentBg) {
		ctx.fillStyle = backgroundColor;
		ctx.fillRect(0, 0, width, height);
	}

	const { positions, radiusFor } = geometry;

	ctx.strokeStyle = edgeColor;
	ctx.lineWidth = 0.6;
	ctx.globalAlpha = 0.5;
	ctx.beginPath();
	for (const e of edges) {
		if (!revealed.has(e.source) || !revealed.has(e.target)) continue;
		const a = positions[e.source];
		const b = positions[e.target];
		ctx.moveTo(a.x, a.y);
		ctx.lineTo(b.x, b.y);
	}
	ctx.stroke();
	ctx.globalAlpha = 1;

	nodes.forEach((n, i) => {
		if (!revealed.has(i)) return;
		const p = positions[i];
		const r = radiusFor(n.degree) * (justSprouted.has(i) ? 1.6 : 1);
		ctx.fillStyle = n.color;
		ctx.beginPath();
		ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
		ctx.fill();
	});

	return ctx.getImageData(0, 0, width, height);
}

/** Orders nodes so the animation reads as a tree/graph actually *growing*:
 * a breadth-first walk out from each connected component's most-connected
 * node, so every node that appears after the first in its component does so
 * already attached to a node that's already on screen — like a branch
 * sprouting from the existing structure, rather than nodes popping in at
 * random and edges snapping in afterward. Disconnected components (and
 * orphans) each start their own new "tree" once the previous one is
 * exhausted, still in roughly hub-first order across components. */
function computeRevealOrder(nodes: GraphNode[], edges: GraphEdge[]): number[] {
	const n = nodes.length;
	const adjacency: number[][] = Array.from({ length: n }, () => []);
	for (const e of edges) {
		adjacency[e.source].push(e.target);
		adjacency[e.target].push(e.source);
	}

	const byDegreeDesc = nodes
		.map((_, i) => i)
		.sort((a, b) => nodes[b].degree - nodes[a].degree || a - b);

	const visited = new Set<number>();
	const order: number[] = [];

	for (const start of byDegreeDesc) {
		if (visited.has(start)) continue;
		// BFS from this component's highest-degree unvisited node.
		const queue: number[] = [start];
		visited.add(start);
		while (queue.length > 0) {
			const current = queue.shift()!;
			order.push(current);
			// Visit neighbors hub-first too, so branches favor well-connected
			// notes over leaves as the tree fans out.
			const neighbors = adjacency[current]
				.filter((nb) => !visited.has(nb))
				.sort((a, b) => nodes[b].degree - nodes[a].degree || a - b);
			for (const nb of neighbors) {
				visited.add(nb);
				queue.push(nb);
			}
		}
	}

	return order;
}

/* --- Frequency-based color quantizer (global palette across all frames) --- */

const QUANT_STEP = 16; // round each channel to a multiple of this before bucketing

function quantizeBucket(r: number, g: number, b: number): number {
	const qr = Math.round(r / QUANT_STEP) * QUANT_STEP;
	const qg = Math.round(g / QUANT_STEP) * QUANT_STEP;
	const qb = Math.round(b / QUANT_STEP) * QUANT_STEP;
	return (Math.min(255, qr) << 16) | (Math.min(255, qg) << 8) | Math.min(255, qb);
}

interface QuantizedFrames {
	palette: [number, number, number][]; // RGB triples, length is a power of two
	indexedFrames: Uint8Array[]; // one index per pixel, row-major
	transparentIndex?: number;
}

function quantizeFrames(
	frames: ImageData[],
	width: number,
	height: number,
	transparentBg: boolean
): QuantizedFrames {
	const maxColors = transparentBg ? 255 : 256; // reserve one slot for transparency
	const counts = new Map<number, number>();

	for (const frame of frames) {
		const data = frame.data;
		for (let i = 0; i < data.length; i += 4) {
			if (transparentBg && data[i + 3] < 128) continue; // transparent pixel, not counted
			const bucket = quantizeBucket(data[i], data[i + 1], data[i + 2]);
			counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
		}
	}

	const sortedBuckets = [...counts.entries()]
		.sort((a, b) => b[1] - a[1])
		.slice(0, maxColors)
		.map(([bucket]) => bucket);

	if (sortedBuckets.length === 0) sortedBuckets.push(0); // degenerate all-transparent case

	const bucketToIndex = new Map<number, number>();
	const palette: [number, number, number][] = sortedBuckets.map((bucket, i) => {
		bucketToIndex.set(bucket, i);
		return [(bucket >> 16) & 255, (bucket >> 8) & 255, bucket & 255];
	});

	let transparentIndex: number | undefined;
	if (transparentBg) {
		transparentIndex = palette.length;
		palette.push([0, 0, 0]); // color value is irrelevant, index is what matters
	}

	// Nearest-palette lookup for buckets that didn't make the cut, cached so
	// each distinct bucket is resolved at most once regardless of frame count.
	const nearestCache = new Map<number, number>();
	function nearestIndex(bucket: number): number {
		const cached = bucketToIndex.get(bucket);
		if (cached !== undefined) return cached;
		const fromCache = nearestCache.get(bucket);
		if (fromCache !== undefined) return fromCache;
		const r = (bucket >> 16) & 255;
		const g = (bucket >> 8) & 255;
		const b = bucket & 255;
		let best = 0;
		let bestDist = Infinity;
		for (let i = 0; i < palette.length; i++) {
			if (i === transparentIndex) continue;
			const [pr, pg, pb] = palette[i];
			const dist = (pr - r) ** 2 + (pg - g) ** 2 + (pb - b) ** 2;
			if (dist < bestDist) {
				bestDist = dist;
				best = i;
			}
		}
		nearestCache.set(bucket, best);
		return best;
	}

	const indexedFrames = frames.map((frame) => {
		const data = frame.data;
		const out = new Uint8Array(width * height);
		for (let p = 0, i = 0; p < data.length; p += 4, i++) {
			if (transparentBg && data[p + 3] < 128) {
				out[i] = transparentIndex!;
				continue;
			}
			out[i] = nearestIndex(quantizeBucket(data[p], data[p + 1], data[p + 2]));
		}
		return out;
	});

	// Pad the palette out to a power of two (GIF requires this for the table size field).
	let tableSize = 2;
	while (tableSize < palette.length) tableSize *= 2;
	while (palette.length < tableSize) palette.push([0, 0, 0]);

	return { palette, indexedFrames, transparentIndex };
}

/* --- Minimal GIF89a / LZW encoder --- */

class GifBitWriter {
	private bytes: number[] = [];
	private bitBuffer = 0;
	private bitCount = 0;

	writeBits(value: number, numBits: number) {
		this.bitBuffer |= value << this.bitCount;
		this.bitCount += numBits;
		while (this.bitCount >= 8) {
			this.bytes.push(this.bitBuffer & 0xff);
			this.bitBuffer >>= 8;
			this.bitCount -= 8;
		}
	}

	finish(): number[] {
		if (this.bitCount > 0) {
			this.bytes.push(this.bitBuffer & 0xff);
			this.bitBuffer = 0;
			this.bitCount = 0;
		}
		return this.bytes;
	}
}

/** Standard variable-code-size LZW encoding as used by GIF's image data
 * sub-blocks (not plain LZW — codes reset on a clear code, and the code
 * width grows from `minCodeSize + 1` up to 12 bits as the dictionary fills). */
function lzwEncode(indices: Uint8Array, minCodeSize: number): number[] {
	const clearCode = 1 << minCodeSize;
	const endCode = clearCode + 1;
	const bw = new GifBitWriter();

	let dict: Map<string, number> = new Map();
	let dictSize: number = endCode + 1;
	let codeSize: number = minCodeSize + 1;

	const resetDict = () => {
		dict = new Map();
		for (let i = 0; i < clearCode; i++) dict.set(String(i), i);
		dictSize = endCode + 1;
		codeSize = minCodeSize + 1;
	};
	resetDict();
	bw.writeBits(clearCode, codeSize);

	let w = "";
	for (let i = 0; i < indices.length; i++) {
		const k = indices[i];
		const wk = w === "" ? String(k) : w + "," + k;
		if (dict.has(wk)) {
			w = wk;
			continue;
		}
		bw.writeBits(dict.get(w)!, codeSize);
		if (dictSize < 4096) {
			dict.set(wk, dictSize++);
			if (dictSize > 1 << codeSize && codeSize < 12) {
				codeSize++;
			}
		} else {
			bw.writeBits(clearCode, codeSize);
			resetDict();
		}
		w = String(k);
	}
	if (w !== "") bw.writeBits(dict.get(w)!, codeSize);
	bw.writeBits(endCode, codeSize);

	return bw.finish();
}

function writeSubBlocks(out: number[], data: number[]) {
	for (let i = 0; i < data.length; i += 255) {
		const chunk = data.slice(i, i + 255);
		out.push(chunk.length, ...chunk);
	}
	out.push(0x00);
}

function encodeGif(
	width: number,
	height: number,
	q: QuantizedFrames,
	delayCentiseconds: number
): Uint8Array {
	const out: number[] = [];

	// Header
	out.push(0x47, 0x49, 0x46, 0x38, 0x39, 0x61); // "GIF89a"

	// Logical Screen Descriptor
	const paletteSize = q.palette.length; // already a power of two
	const colorTableBits = Math.round(Math.log2(paletteSize)) - 1;
	out.push(width & 0xff, (width >> 8) & 0xff);
	out.push(height & 0xff, (height >> 8) & 0xff);
	out.push(0b1000_0000 | (0b111 << 4) | colorTableBits); // global color table, 8-bit color res
	out.push(0x00); // background color index
	out.push(0x00); // pixel aspect ratio

	// Global Color Table
	for (const [r, g, b] of q.palette) out.push(r, g, b);

	// NETSCAPE2.0 application extension — loop forever
	out.push(0x21, 0xff, 0x0b);
	out.push(...Array.from("NETSCAPE2.0", (c) => c.charCodeAt(0)));
	out.push(0x03, 0x01, 0x00, 0x00, 0x00);

	const minCodeSize = Math.max(2, Math.round(Math.log2(paletteSize)));

	for (const indices of q.indexedFrames) {
		// Graphic Control Extension
		const hasTransparency = q.transparentIndex !== undefined;
		out.push(0x21, 0xf9, 0x04);
		out.push((0b000 << 2) | (hasTransparency ? 0x01 : 0x00)); // disposal: unspecified
		out.push(delayCentiseconds & 0xff, (delayCentiseconds >> 8) & 0xff);
		out.push(hasTransparency ? q.transparentIndex! : 0x00);
		out.push(0x00);

		// Image Descriptor
		out.push(0x2c);
		out.push(0x00, 0x00, 0x00, 0x00); // left, top
		out.push(width & 0xff, (width >> 8) & 0xff);
		out.push(height & 0xff, (height >> 8) & 0xff);
		out.push(0x00); // no local color table

		// Image Data
		out.push(minCodeSize);
		const compressed = lzwEncode(indices, minCodeSize);
		writeSubBlocks(out, compressed);
	}

	out.push(0x3b); // trailer

	return new Uint8Array(out);
}

/** Builds the full animated-GIF snapshot: lays out N reveal frames (nodes
 * appearing hub-first) plus a handful of hold frames on the completed graph,
 * quantizes them to a shared palette, and encodes the result as a GIF. */
function buildGifSnapshot(
	nodes: GraphNode[],
	edges: GraphEdge[],
	settings: GraphGithubSyncSettings
): Uint8Array {
	const { width, height } = settings;
	const { edgeColor, backgroundColor } = effectiveColors(settings);
	const transparentBg = !backgroundColor || backgroundColor === "transparent";
	const geometry = computeRenderGeometry(nodes, width, height);
	const revealOrder = computeRevealOrder(nodes, edges);

	const canvas = document.createElement("canvas");
	canvas.width = width;
	canvas.height = height;
	const ctx = canvas.getContext("2d", { willReadFrequently: true });
	if (!ctx) throw new Error("could not get a 2D canvas context to render GIF frames");

	const nodesPerFrame = Math.max(1, settings.gifNodesPerFrame);
	const holdFrameCount = Math.max(0, settings.gifHoldFrames);
	const totalNodes = nodes.length;

	const frames: ImageData[] = [];
	const revealed = new Set<number>();

	// One sprouting "event" per frame (or a handful at once on big vaults,
	// via gifNodesPerFrame) — each new node already has its edge to an
	// earlier, already-visible node, since computeRevealOrder walks the
	// graph breadth-first. That's what makes it read as growth rather than
	// nodes just popping in.
	for (let cursor = 0; cursor < totalNodes; cursor += nodesPerFrame) {
		const justSprouted = new Set<number>();
		const end = Math.min(cursor + nodesPerFrame, totalNodes);
		for (let i = cursor; i < end; i++) {
			const idx = revealOrder[i];
			revealed.add(idx);
			justSprouted.add(idx);
		}
		frames.push(
			renderGifFrame(
				ctx,
				width,
				height,
				nodes,
				edges,
				geometry,
				revealed,
				justSprouted,
				edgeColor,
				backgroundColor,
				transparentBg
			)
		);
	}

	// Hold on the fully-revealed graph for a beat before it loops.
	if (holdFrameCount > 0 && frames.length > 0) {
		const finalFrame = frames[frames.length - 1];
		for (let i = 0; i < holdFrameCount; i++) frames.push(finalFrame);
	}

	const quantized = quantizeFrames(frames, width, height, transparentBg);
	const delayCentiseconds = Math.max(2, Math.round(settings.gifFrameDelayMs / 10));
	return encodeGif(width, height, quantized, delayCentiseconds);
}



/* -------------------------------------------------------------------------
 * Build the anonymized graph from the vault
 * ---------------------------------------------------------------------- */

async function buildGraph(
	app: App,
	settings: GraphGithubSyncSettings
): Promise<{ nodes: GraphNode[]; edges: GraphEdge[]; colorGroupCount: number; matchedCount: number; excludedCount: number }> {
	const usePreset = settings.colorMode === "preset";
	// Only bother reading the vault's graph.json color groups when we're
	// actually going to use them — preset mode never touches note content,
	// tags, or link names for coloring.
	const colorGroups = usePreset ? [] : await loadColorGroups(app);
	const preset = COLOR_PRESETS[settings.colorPreset] ?? COLOR_PRESETS[DEFAULT_COLOR_PRESET_KEY];
	let matchedCount = 0;

	const isExcluded = settings.respectExcludedFiles
		? await buildExcludeMatcher(app)
		: () => false;

	const allFiles = app.vault.getFiles();
	let excludedCount = 0;
	const files = allFiles.filter((f) => {
		if (isExcluded(f.path)) {
			excludedCount++;
			return false;
		}
		if (f.extension === "md") return true;
		return settings.includeAttachments;
	});

	const pathToIndex = new Map<string, number>();
	const nodes: GraphNode[] = [];

	files.forEach((f, i) => {
		pathToIndex.set(f.path, i);
	});

	// resolvedLinks: { sourcePath: { targetPath: count } }
	const resolved = app.metadataCache.resolvedLinks;

	const edgeSet = new Set<string>();
	const edges: GraphEdge[] = [];

	for (const file of files) {
		const targets = resolved[file.path];
		if (!targets) continue;
		for (const targetPath of Object.keys(targets)) {
			const targetIdx = pathToIndex.get(targetPath);
			const sourceIdx = pathToIndex.get(file.path);
			if (targetIdx === undefined || sourceIdx === undefined) continue;
			if (sourceIdx === targetIdx) continue;
			const key =
				sourceIdx < targetIdx
					? `${sourceIdx}-${targetIdx}`
					: `${targetIdx}-${sourceIdx}`;
			if (edgeSet.has(key)) continue;
			edgeSet.add(key);
			edges.push({ source: sourceIdx, target: targetIdx });
		}
	}

	const degree = new Array(files.length).fill(0);
	for (const e of edges) {
		degree[e.source]++;
		degree[e.target]++;
	}

	const contentCache = new Map<string, string>();

	for (const [i, f] of files.entries()) {
		if (!settings.includeOrphans && degree[i] === 0) continue;

		const cache = app.metadataCache.getFileCache(f);
		const tags: string[] = [];
		if (cache?.tags) tags.push(...cache.tags.map((t) => t.tag));
		if (cache?.frontmatter?.tags) {
			const fmTags = cache.frontmatter.tags;
			const arr = Array.isArray(fmTags) ? fmTags : [fmTags];
			for (const t of arr) tags.push(t.toString().startsWith("#") ? t : "#" + t);
		}

		const outgoingLinkNames = Object.keys(resolved[f.path] ?? {}).map((p) =>
			p.split("/").pop()!.replace(/\.md$/i, "")
		);

		let color: string;
		if (usePreset) {
			// Cycle through the preset's palette in file order. This doesn't
			// carry any meaning from the vault (no groups to match), it just
			// gives the snapshot visual variety instead of a single flat color.
			color = preset.palette[i % preset.palette.length];
		} else {
			color = settings.defaultNodeColor;
			for (const group of colorGroups) {
				if (
					await fileMatchesQuery(
						app,
						f,
						group.query,
						tags,
						outgoingLinkNames,
						contentCache
					)
				) {
					color = `rgba(${(group.color.rgb >> 16) & 255}, ${
						(group.color.rgb >> 8) & 255
					}, ${group.color.rgb & 255}, ${group.color.a})`;
					matchedCount++;
					break;
				}
			}
		}

		nodes.push({
			id: `n${i}`,
			x: 0,
			y: 0,
			vx: 0,
			vy: 0,
			degree: degree[i],
			color,
		});
	}

	// re-index edges/nodes together in case orphans were dropped
	if (!settings.includeOrphans) {
		const keptIndices = new Map<number, number>();
		let cursor = 0;
		files.forEach((_, i) => {
			if (degree[i] === 0) return;
			keptIndices.set(i, cursor++);
		});
		const filteredEdges = edges
			.filter((e) => keptIndices.has(e.source) && keptIndices.has(e.target))
			.map((e) => ({
				source: keptIndices.get(e.source)!,
				target: keptIndices.get(e.target)!,
			}));
		return { nodes, edges: filteredEdges, colorGroupCount: colorGroups.length, matchedCount, excludedCount };
	}

	return { nodes, edges, colorGroupCount: colorGroups.length, matchedCount, excludedCount };
}

/* -------------------------------------------------------------------------
 * GitHub publishing (uses Obsidian's requestUrl to avoid CORS issues)
 * ---------------------------------------------------------------------- */

function toBase64(str: string): string {
	// UTF-8 safe base64 encode
	const utf8 = unescape(encodeURIComponent(str));
	let binary = "";
	for (let i = 0; i < utf8.length; i++) binary += String.fromCharCode(utf8.charCodeAt(i));
	return btoa(binary);
}

function fromBase64(b64: string): string {
	const binary = atob(b64.replace(/\n/g, ""));
	let percentEncoded = "";
	for (let i = 0; i < binary.length; i++) {
		percentEncoded += "%" + binary.charCodeAt(i).toString(16).padStart(2, "0");
	}
	return decodeURIComponent(percentEncoded);
}

/** Binary-safe base64 encode for raw GIF bytes (toBase64 above assumes a
 * UTF-8 text string, which would corrupt arbitrary binary data). */
function bytesToBase64(bytes: Uint8Array): string {
	let binary = "";
	const chunkSize = 0x8000; // avoid blowing the call stack on String.fromCharCode(...bigArray)
	for (let i = 0; i < bytes.length; i += chunkSize) {
		binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
	}
	return btoa(binary);
}

/**
 * Returns true if the target repo is private, false if public, or undefined
 * if we couldn't tell (network error, token lacks access, etc). Used to warn
 * the user that embedding an image from a private repo in a public README
 * won't actually render for anyone but them — raw.githubusercontent.com
 * requires authentication for private repo content.
 */
async function isRepoPrivate(
	settings: GraphGithubSyncSettings
): Promise<boolean | undefined> {
	const url = `https://api.github.com/repos/${settings.repoOwner}/${settings.repoName}`;
	try {
		const res = await requestUrl({
			url,
			method: "GET",
			headers: {
				Authorization: `token ${settings.githubToken}`,
				Accept: "application/vnd.github+json",
			},
			throw: false,
		});
		if (res.status === 200) return !!res.json.private;
		return undefined;
	} catch {
		return undefined;
	}
}

async function getExistingFileSha(
	settings: GraphGithubSyncSettings,
	path: string
): Promise<string | undefined> {
	const url = `https://api.github.com/repos/${settings.repoOwner}/${settings.repoName}/contents/${path}?ref=${settings.branch}`;
	try {
		const res = await requestUrl({
			url,
			method: "GET",
			headers: {
				Authorization: `token ${settings.githubToken}`,
				Accept: "application/vnd.github+json",
			},
			throw: false,
		});
		if (res.status === 200) {
			return res.json.sha as string;
		}
		return undefined;
	} catch {
		return undefined;
	}
}

async function getExistingFileContent(
	settings: GraphGithubSyncSettings,
	path: string
): Promise<{ sha?: string; content?: string }> {
	const url = `https://api.github.com/repos/${settings.repoOwner}/${settings.repoName}/contents/${path}?ref=${settings.branch}`;
	try {
		const res = await requestUrl({
			url,
			method: "GET",
			headers: {
				Authorization: `token ${settings.githubToken}`,
				Accept: "application/vnd.github+json",
			},
			throw: false,
		});
		if (res.status === 200) {
			return { sha: res.json.sha, content: fromBase64(res.json.content) };
		}
		return {};
	} catch {
		return {};
	}
}

async function putFileRaw(
	settings: GraphGithubSyncSettings,
	path: string,
	contentBase64: string,
	sha: string | undefined,
	message: string
): Promise<{ status: number; json: any }> {
	const url = `https://api.github.com/repos/${settings.repoOwner}/${settings.repoName}/contents/${path}`;
	const body: Record<string, unknown> = {
		message,
		content: contentBase64,
		branch: settings.branch,
	};
	if (sha) body.sha = sha;

	const res = await requestUrl({
		url,
		method: "PUT",
		headers: {
			Authorization: `token ${settings.githubToken}`,
			Accept: "application/vnd.github+json",
			"Content-Type": "application/json",
		},
		body: JSON.stringify(body),
		throw: false,
	});
	return { status: res.status, json: res.json };
}

/**
 * Commits a file, and if GitHub rejects it with a SHA-conflict (409/422 —
 * something else changed the file between our GET and this PUT, e.g. the
 * command was triggered twice in quick succession), refetches the current
 * SHA and retries a couple of times before giving up.
 */
async function putFile(
	settings: GraphGithubSyncSettings,
	path: string,
	contentBase64: string,
	sha: string | undefined,
	message: string
) {
	let currentSha = sha;
	const maxAttempts = 3;

	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		const res = await putFileRaw(settings, path, contentBase64, currentSha, message);

		if (res.status >= 200 && res.status < 300) return;

		const isConflict =
			res.status === 409 ||
			(res.status === 422 &&
				typeof res.json?.message === "string" &&
				/does not match|sha/i.test(res.json.message));

		if (isConflict && attempt < maxAttempts) {
			console.warn(
				`Graph GitHub Sync: SHA conflict on ${path} (attempt ${attempt}/${maxAttempts}), refetching and retrying…`
			);
			currentSha = await getExistingFileSha(settings, path);
			await new Promise((resolve) => setTimeout(resolve, 400 * attempt));
			continue;
		}

		throw new Error(
			`GitHub API error (${res.status}): ${res.json?.message ?? "unknown error"}`
		);
	}
}

/* -------------------------------------------------------------------------
 * Plugin
 * ---------------------------------------------------------------------- */

export default class GraphGithubSyncPlugin extends Plugin {
	settings!: GraphGithubSyncSettings;
	private isPublishing = false;

	async onload() {
		await this.loadSettings();

		this.addCommand({
			id: "publish-graph-snapshot",
			name: "Publish anonymized graph snapshot to GitHub",
			callback: () => this.publish(),
		});

		this.addSettingTab(new GraphGithubSyncSettingTab(this.app, this));
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	async publish() {
		if (this.isPublishing) {
			new Notice(
				"Graph GitHub Sync: a publish is already in progress — please wait for it to finish."
			);
			return;
		}
		this.isPublishing = true;
		try {
			await this.doPublish();
		} finally {
			this.isPublishing = false;
		}
	}

	private async doPublish() {
		const s = this.settings;
		if (!s.githubToken || !s.repoOwner || !s.repoName) {
			new Notice(
				"Graph GitHub Sync: set your token, repo owner, and repo name in plugin settings first."
			);
			return;
		}

		if (s.updateReadme) {
			const priv = await isRepoPrivate(s);
			if (priv === true) {
				new Notice(
					`Graph GitHub Sync: heads up — ${s.repoOwner}/${s.repoName} is private. An embedded image from a private repo won't render for anyone else viewing your README, only for you. If you want this visible on your public profile, use a separate public repo (or your public ${s.repoOwner}/${s.repoOwner} profile repo) instead. Continuing anyway…`,
					15000
				);
			}
		}

		new Notice("Building anonymized graph…");
		let nodes: GraphNode[], edges: GraphEdge[];
		try {
			const built = await buildGraph(this.app, s);
			nodes = built.nodes;
			edges = built.edges;

			if (s.colorMode === "preset") {
				const presetLabel =
					COLOR_PRESETS[s.colorPreset]?.label ?? COLOR_PRESETS[DEFAULT_COLOR_PRESET_KEY].label;
				new Notice(
					`Graph GitHub Sync: colored nodes using the "${presetLabel}" preset.`,
					5000
				);
			} else if (built.colorGroupCount === 0) {
				new Notice(
					"Graph GitHub Sync: no color groups found in Graph view settings — all nodes will use the default color. Open Graph view → gear icon → Groups to add some, or switch to a built-in preset in plugin settings. (See console for details.)",
					10000
				);
			} else {
				new Notice(
					`Graph GitHub Sync: colored ${built.matchedCount}/${nodes.length} nodes using ${built.colorGroupCount} color group(s).`,
					6000
				);
			}

			if (s.respectExcludedFiles) {
				new Notice(
					built.excludedCount > 0
						? `Graph GitHub Sync: skipped ${built.excludedCount} excluded file(s).`
						: "Graph GitHub Sync: no files matched your Excluded files list.",
					5000
				);
			}
		} catch (e) {
			new Notice(`Graph GitHub Sync: failed to build graph — ${e}`);
			return;
		}

		if (nodes.length === 0) {
			new Notice("Graph GitHub Sync: no notes found to graph.");
			return;
		}

		layoutGraph(nodes, edges, s.width, s.height);

		const isGif = s.outputFormat === "gif";
		const outputPath = isGif ? s.gifPath : s.svgPath;

		let fileBase64: string;
		try {
			if (isGif) {
				if (nodes.length > 2000) {
					new Notice(
						`Graph GitHub Sync: rendering an animated GIF for ${nodes.length} notes — this may take a while. Raising "Nodes per frame" in settings speeds it up.`,
						8000
					);
				}
				new Notice("Rendering animated GIF frames…");
				const gifBytes = buildGifSnapshot(nodes, edges, s);
				fileBase64 = bytesToBase64(gifBytes);
			} else {
				const svg = renderSvg(nodes, edges, s);
				fileBase64 = toBase64(svg);
			}
		} catch (e) {
			new Notice(`Graph GitHub Sync: failed to render ${isGif ? "GIF" : "SVG"} — ${e}`);
			return;
		}

		try {
			new Notice(`Pushing ${outputPath} to GitHub…`);
			const existingSha = await getExistingFileSha(s, outputPath);
			await putFile(s, outputPath, fileBase64, existingSha, s.commitMessage);

			if (s.updateReadme) {
				await this.updateReadme(s, outputPath);
			}

			new Notice("Graph GitHub Sync: done ✅");
		} catch (e) {
			new Notice(`Graph GitHub Sync: publish failed — ${e}`);
		}
	}

	async updateReadme(s: GraphGithubSyncSettings, outputPath: string) {
		const { sha, content } = await getExistingFileContent(s, s.readmePath);
		if (content === undefined) {
			new Notice(
				`Graph GitHub Sync: couldn't read ${s.readmePath} to update it — check the path.`
			);
			return;
		}

		const rawImageUrl = `https://raw.githubusercontent.com/${s.repoOwner}/${s.repoName}/${s.branch}/${outputPath}?t=${Date.now()}`;
		const block = `${README_START_MARKER}\n![Graph snapshot](${rawImageUrl})\n${README_END_MARKER}`;

		let newContent: string;
		if (content.includes(README_START_MARKER) && content.includes(README_END_MARKER)) {
			const pattern = new RegExp(
				`${README_START_MARKER}[\\s\\S]*?${README_END_MARKER}`
			);
			newContent = content.replace(pattern, block);
		} else {
			newContent = content.trimEnd() + "\n\n" + block + "\n";
		}

		if (newContent === content) return; // nothing changed, skip an empty commit

		await putFile(
			s,
			s.readmePath,
			toBase64(newContent),
			sha,
			`${s.commitMessage} (README)`
		);
	}
}

/* -------------------------------------------------------------------------
 * Settings tab
 * ---------------------------------------------------------------------- */

class GraphGithubSyncSettingTab extends PluginSettingTab {
	plugin: GraphGithubSyncPlugin;

	constructor(app: App, plugin: GraphGithubSyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		const s = this.plugin.settings;

		containerEl.createEl("h2", { text: "Graph GitHub Sync" });
		containerEl.createEl("p", {
			text:
				"Publishes an anonymized snapshot of your graph (colors, node sizes, and connections only — no note names) to a GitHub repo.",
		});
		containerEl.createEl("p", {
			text:
				"⚠️ If you want this image visible on your public profile README, point this at a small, dedicated PUBLIC repo — not your (likely private) vault repo. Private-repo images don't render for other viewers; the plugin will warn you at publish time if it detects this.",
			cls: "setting-item-description",
		});

		new Setting(containerEl)
			.setName("GitHub personal access token")
			.setDesc(
				"Needs 'repo' scope (or fine-grained: Contents: read & write) on the target repo. Stored locally in your vault's plugin data."
			)
			.addText((text) => {
				text
					.setPlaceholder("ghp_…")
					.setValue(s.githubToken)
					.onChange(async (v) => {
						s.githubToken = v.trim();
						await this.plugin.saveSettings();
					});
				text.inputEl.type = "password";
				return text;
			})
			.addExtraButton((btn) => {
				btn
					.setIcon("eye")
					.setTooltip("Show token")
					.onClick(() => {
						const input = btn.extraSettingsEl.parentElement?.querySelector(
							"input"
						) as HTMLInputElement | null;
						if (!input) return;
						const showing = input.type === "text";
						input.type = showing ? "password" : "text";
						btn.setIcon(showing ? "eye" : "eye-off");
						btn.setTooltip(showing ? "Show token" : "Hide token");
					});
			});

		new Setting(containerEl)
			.setName("Repo owner")
			.setDesc("GitHub username or org, e.g. 'octocat'")
			.addText((text) =>
				text.setValue(s.repoOwner).onChange(async (v) => {
					s.repoOwner = v.trim();
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Repo name")
			.addText((text) =>
				text.setValue(s.repoName).onChange(async (v) => {
					s.repoName = v.trim();
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Branch")
			.addText((text) =>
				text.setValue(s.branch).onChange(async (v) => {
					s.branch = v.trim() || "main";
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Output format")
			.setDesc(
				"Static SVG, or an animated GIF that grows like a tree — one note sprouting in at a time from the existing structure, holds on the finished graph for a beat, then loops forever."
			)
			.addDropdown((drop) =>
				drop
					.addOption("svg", "Static SVG")
					.addOption("gif", "Animated GIF (nodes appear)")
					.setValue(s.outputFormat)
					.onChange(async (v) => {
						s.outputFormat = v as "svg" | "gif";
						await this.plugin.saveSettings();
						this.display();
					})
			);

		if (s.outputFormat === "gif") {
			new Setting(containerEl)
				.setName("GIF path in repo")
				.setDesc("e.g. assets/graph.gif")
				.addText((text) =>
					text.setValue(s.gifPath).onChange(async (v) => {
						s.gifPath = v.trim() || "assets/graph.gif";
						await this.plugin.saveSettings();
					})
				);

			new Setting(containerEl)
				.setName("Nodes per frame")
				.setDesc(
					"How many new notes sprout in at once, each frame. 1 = strictly one at a time, closest to watching the tree grow. Raise this on large vaults to shorten/speed up rendering."
				)
				.addText((text) =>
					text.setValue(String(s.gifNodesPerFrame)).onChange(async (v) => {
						const n = parseInt(v, 10);
						s.gifNodesPerFrame = Number.isFinite(n) && n > 0 ? n : DEFAULT_SETTINGS.gifNodesPerFrame;
						await this.plugin.saveSettings();
					})
				);

			new Setting(containerEl)
				.setName("Frame delay (ms)")
				.setDesc("How long each frame is shown before advancing.")
				.addText((text) =>
					text.setValue(String(s.gifFrameDelayMs)).onChange(async (v) => {
						const n = parseInt(v, 10);
						s.gifFrameDelayMs = Number.isFinite(n) && n > 0 ? n : DEFAULT_SETTINGS.gifFrameDelayMs;
						await this.plugin.saveSettings();
					})
				);

			new Setting(containerEl)
				.setName("Hold frames at end")
				.setDesc("Extra frames repeating the fully-revealed graph before the animation loops back to the start.")
				.addText((text) =>
					text.setValue(String(s.gifHoldFrames)).onChange(async (v) => {
						const n = parseInt(v, 10);
						s.gifHoldFrames = Number.isFinite(n) && n >= 0 ? n : DEFAULT_SETTINGS.gifHoldFrames;
						await this.plugin.saveSettings();
					})
				);
		} else {
			new Setting(containerEl)
				.setName("SVG path in repo")
				.setDesc("e.g. assets/graph.svg")
				.addText((text) =>
					text.setValue(s.svgPath).onChange(async (v) => {
						s.svgPath = v.trim() || "assets/graph.svg";
						await this.plugin.saveSettings();
					})
				);
		}

		new Setting(containerEl)
			.setName("Update README")
			.setDesc(
				`Also update a marker block in your README (${README_START_MARKER} … ${README_END_MARKER}) to embed the image. If markers aren't found, they'll be appended to the end of the file.`
			)
			.addToggle((toggle) =>
				toggle.setValue(s.updateReadme).onChange(async (v) => {
					s.updateReadme = v;
					await this.plugin.saveSettings();
					this.display();
				})
			);

		if (s.updateReadme) {
			new Setting(containerEl)
				.setName("README path in repo")
				.addText((text) =>
					text.setValue(s.readmePath).onChange(async (v) => {
						s.readmePath = v.trim() || "README.md";
						await this.plugin.saveSettings();
					})
				);
		}

		new Setting(containerEl)
			.setName("Commit message")
			.addText((text) =>
				text.setValue(s.commitMessage).onChange(async (v) => {
					s.commitMessage = v || DEFAULT_SETTINGS.commitMessage;
					await this.plugin.saveSettings();
				})
			);

		containerEl.createEl("h3", { text: "Graph appearance" });

		new Setting(containerEl)
			.setName("Include orphan notes")
			.setDesc("Notes with no links at all.")
			.addToggle((toggle) =>
				toggle.setValue(s.includeOrphans).onChange(async (v) => {
					s.includeOrphans = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Include attachments")
			.setDesc("Non-markdown files (images, PDFs, etc.) as nodes.")
			.addToggle((toggle) =>
				toggle.setValue(s.includeAttachments).onChange(async (v) => {
					s.includeAttachments = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Respect excluded files")
			.setDesc(
				"Skip notes/files matching your vault's Settings → Files & Links → Excluded files patterns, same as the core Graph view does."
			)
			.addToggle((toggle) =>
				toggle.setValue(s.respectExcludedFiles).onChange(async (v) => {
					s.respectExcludedFiles = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Color source")
			.setDesc(
				"Where node/edge/background colors come from: your vault's own Graph view color groups (gear icon → Groups), or one of the built-in presets below."
			)
			.addDropdown((drop) =>
				drop
					.addOption("vault", "Colors I'm using in the graph")
					.addOption("preset", "Built-in color preset")
					.setValue(s.colorMode)
					.onChange(async (v) => {
						s.colorMode = v as ColorMode;
						await this.plugin.saveSettings();
						this.display();
					})
			);

		if (s.colorMode === "preset") {
			new Setting(containerEl)
				.setName("Preset")
				.setDesc(
					"Cycles this palette across nodes and sets the background/edge colors. Doesn't require any color groups to be set up in Graph view."
				)
				.addDropdown((drop) => {
					for (const [key, preset] of Object.entries(COLOR_PRESETS)) {
						drop.addOption(key, preset.label);
					}
					drop.setValue(s.colorPreset).onChange(async (v) => {
						s.colorPreset = v;
						await this.plugin.saveSettings();
					});
				});
		} else {
			new Setting(containerEl)
				.setName("Default node color")
				.setDesc("Used for notes that don't match any graph color group.")
				.addText((text) =>
					text.setValue(s.defaultNodeColor).onChange(async (v) => {
						s.defaultNodeColor = v.trim() || DEFAULT_SETTINGS.defaultNodeColor;
						await this.plugin.saveSettings();
					})
				);

			new Setting(containerEl)
				.setName("Edge color")
				.addText((text) =>
					text.setValue(s.edgeColor).onChange(async (v) => {
						s.edgeColor = v.trim() || DEFAULT_SETTINGS.edgeColor;
						await this.plugin.saveSettings();
					})
				);

			new Setting(containerEl)
				.setName("Background color")
				.setDesc("Use 'transparent' for a transparent background.")
				.addText((text) =>
					text.setValue(s.backgroundColor).onChange(async (v) => {
						s.backgroundColor = v.trim() || "transparent";
						await this.plugin.saveSettings();
					})
				);
		}

		new Setting(containerEl)
			.setName("Image width (px)")
			.addText((text) =>
				text.setValue(String(s.width)).onChange(async (v) => {
					const n = parseInt(v, 10);
					s.width = Number.isFinite(n) && n > 0 ? n : DEFAULT_SETTINGS.width;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Image height (px)")
			.addText((text) =>
				text.setValue(String(s.height)).onChange(async (v) => {
					const n = parseInt(v, 10);
					s.height = Number.isFinite(n) && n > 0 ? n : DEFAULT_SETTINGS.height;
					await this.plugin.saveSettings();
				})
			);
	}
}
