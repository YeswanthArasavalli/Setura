// Graph topology analyzer for tour building
// Reads a JSON graph (nodes, edges, layers), computes structural properties,
// writes results JSON.

const fs = require("fs");

function die(msg, code = 1) {
  console.error(msg);
  process.exit(code);
}

const inputPath = process.argv[2];
const outputPath = process.argv[3];
if (!inputPath || !outputPath) {
  die("Usage: node ua-tour-analyze.js <input.json> <output.json>");
}

let raw;
try {
  raw = fs.readFileSync(inputPath, "utf8");
} catch (e) {
  die("Cannot read input: " + e.message);
}

let graph;
try {
  graph = JSON.parse(raw);
} catch (e) {
  die("Cannot parse input JSON: " + e.message);
}

const nodes = graph.nodes || [];
const edges = graph.edges || [];
const layers = graph.layers || [];

// Build lookup
const nodeById = new Map();
for (const n of nodes) nodeById.set(n.id, n);

// Fan-in / Fan-out
const fanIn = new Map();
const fanOut = new Map();
for (const n of nodes) {
  fanIn.set(n.id, 0);
  fanOut.set(n.id, 0);
}
for (const e of edges) {
  if (fanIn.has(e.target)) fanIn.set(e.target, fanIn.get(e.target) + 1);
  if (fanOut.has(e.source)) fanOut.set(e.source, fanOut.get(e.source) + 1);
}

const fanInRanking = [...fanIn.entries()]
  .map(([id, c]) => ({ id, fanIn: c, name: nodeById.get(id)?.name || id }))
  .sort((a, b) => b.fanIn - a.fanIn)
  .slice(0, 20);

const fanOutRanking = [...fanOut.entries()]
  .map(([id, c]) => ({ id, fanOut: c, name: nodeById.get(id)?.name || id }))
  .sort((a, b) => b.fanOut - a.fanOut)
  .slice(0, 20);

// Entry-point scoring
const ENTRY_FILE_PATTERNS = [
  /^index\.(ts|js)$/, /^main\.(ts|js)$/, /^app\.(ts|js)$/, /^server\.(ts|js)$/,
  /^mod\.rs$/, /^main\.(go|py|rs)$/, /^manage\.py$/, /^app\.py$/,
  /^wsgi\.py$/, /^asgi\.py$/, /^run\.py$/, /^__main__\.py$/,
  /^Application\.java$/, /^Main\.java$/, /^Program\.cs$/, /^config\.ru$/,
  /^index\.php$/, /^App\.swift$/, /^Application\.kt$/, /^main\.(cpp|c)$/
];

function depth(p) {
  // project root = 0, src/ = 1
  const parts = p.split("/").filter(Boolean);
  if (parts.length <= 1) return 0;
  return parts.length - 1;
}

const candidates = [];
for (const n of nodes) {
  const meta = nodeById.get(n);
  let score = 0;
  if (n.type === "document" && n.filePath === "README.md") {
    score += 5;
  } else if (n.type === "document" && /\.md$/.test(n.filePath) && depth(n.filePath) === 0) {
    score += 2;
  } else if (n.type === "file" || n.type === "function") {
    const fname = (n.name || "").toLowerCase();
    if (ENTRY_FILE_PATTERNS.some(p => p.test(fname))) score += 3;
    if (depth(n.filePath) <= 1) score += 1;
    const allFanOuts = [...fanOut.values()].sort((a, b) => b - a);
    const cutoff = allFanOuts[Math.floor(allFanOuts.length * 0.1)] || 0;
    if ((fanOut.get(n.id) || 0) >= cutoff && cutoff > 0) score += 1;
    const allFanIns = [...fanIn.values()].sort((a, b) => a - b);
    const inCutoff = allFanIns[Math.floor(allFanIns.length * 0.25)] || 0;
    if ((fanIn.get(n.id) || 0) <= inCutoff) score += 1;
  }
  if (score > 0) {
    candidates.push({ id: n.id, score, name: n.name, type: n.type, summary: n.summary });
  }
}
candidates.sort((a, b) => b.score - a.score);
const entryPointCandidates = candidates.slice(0, 5);

// BFS from top CODE entry point (skip documents)
const topCodeEntry = (candidates.find(c => c.type === "file" || c.type === "function") || candidates[0]);
const startNode = topCodeEntry ? topCodeEntry.id : (nodes[0] && nodes[0].id);

const visited = new Set();
const depthMap = {};
const order = [];
const byDepth = {};

if (startNode) {
  const queue = [{ id: startNode, d: 0 }];
  while (queue.length) {
    const { id, d } = queue.shift();
    if (visited.has(id)) continue;
    visited.add(id);
    order.push(id);
    depthMap[id] = d;
    if (!byDepth[String(d)]) byDepth[String(d)] = [];
    byDepth[String(d)].push(id);
    // follow forward imports/calls
    for (const e of edges) {
      if (e.source === id && (e.type === "imports" || e.type === "calls")) {
        if (!visited.has(e.target)) {
          queue.push({ id: e.target, d: d + 1 });
        }
      }
    }
  }
}

const bfsTraversal = {
  startNode,
  order,
  depthMap,
  byDepth
};

// Non-code inventory
const nonCode = { documentation: [], infrastructure: [], data: [], config: [] };
for (const n of nodes) {
  const item = { id: n.id, name: n.name, type: n.type, summary: n.summary };
  if (n.type === "document") nonCode.documentation.push(item);
  else if (n.type === "service" || n.type === "pipeline" || n.type === "resource") nonCode.infrastructure.push(item);
  else if (n.type === "table" || n.type === "schema" || n.type === "endpoint") nonCode.data.push(item);
  else if (n.type === "config") nonCode.config.push(item);
}

// Clusters: pairs with bidirectional relationships
const forwardAdj = new Map();
for (const e of edges) {
  if (!forwardAdj.has(e.source)) forwardAdj.set(e.source, new Set());
  forwardAdj.get(e.source).add(e.target);
}
const bidirPairs = [];
for (const e of edges) {
  const rev = forwardAdj.get(e.target);
  if (rev && rev.has(e.source) && e.source < e.target) {
    bidirPairs.push([e.source, e.target]);
  }
}
// Group into clusters of 2-5 by shared neighbors
const clusterMap = new Map();
for (const [a, b] of bidirPairs) {
  const key = a < b ? `${a}|${b}` : `${b}|${a}`;
  if (!clusterMap.has(key)) clusterMap.set(key, { nodes: a < b ? [a, b] : [b, a], edgeCount: 0 });
  clusterMap.get(key).edgeCount += 2;
}
// Expand: add nodes connected to 2+ cluster members
for (const [, cl] of clusterMap) {
  for (const n of nodes) {
    if (cl.nodes.includes(n.id) || cl.nodes.length >= 5) continue;
    const outN = forwardAdj.get(n.id) || new Set();
    const inN = new Set();
    for (const e of edges) if (e.target === n.id) inN.add(e.source);
    let hits = 0;
    for (const m of cl.nodes) {
      if (outN.has(m) || inN.has(m)) hits++;
    }
    if (hits >= 2) {
      cl.nodes.push(n.id);
    }
  }
}
const clusters = [...clusterMap.values()]
  .filter(c => c.nodes.length >= 2 && c.nodes.length <= 5)
  .sort((a, b) => b.edgeCount - a.edgeCount)
  .slice(0, 10)
  .map(c => ({ nodes: c.nodes, edgeCount: c.edgeCount }));

// Layers
const layerList = layers.map(l => ({ id: l.id, name: l.name, description: l.description }));

// Node summary index
const nodeSummaryIndex = {};
for (const n of nodes) {
  nodeSummaryIndex[n.id] = { name: n.name, type: n.type, summary: n.summary };
}

const result = {
  scriptCompleted: true,
  entryPointCandidates,
  fanInRanking,
  fanOutRanking,
  bfsTraversal,
  nonCodeFiles: nonCode,
  clusters,
  layers: { count: layerList.length, list: layerList },
  nodeSummaryIndex,
  totalNodes: nodes.length,
  totalEdges: edges.length
};

fs.writeFileSync(outputPath, JSON.stringify(result, null, 2));
console.log("Wrote analysis to", outputPath);
console.log("Nodes:", nodes.length, "Edges:", edges.length, "Top entry:", entryPointCandidates[0]?.id);
