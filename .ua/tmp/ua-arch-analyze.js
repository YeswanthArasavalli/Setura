#!/usr/bin/env node
// SETURA architecture analyzer: extracts structural patterns from file nodes + edges
// to inform layer assignment in Phase 2.

const fs = require('fs');
const path = require('path');

function main() {
  const inputPath = process.argv[2];
  const outputPath = process.argv[3];
  if (!inputPath || !outputPath) {
    process.stderr.write('Usage: ua-arch-analyze.js <input.json> <output.json>\n');
    process.exit(1);
  }

  const raw = fs.readFileSync(inputPath, 'utf8');
  const input = JSON.parse(raw);
  const fileNodes = input.fileNodes || [];
  const importEdges = input.importEdges || [];
  const allEdges = input.allEdges || [];

  // --- A. Directory Grouping ---
  // First, compute the common path prefix
  const paths = fileNodes.map(n => n.filePath || '').filter(p => p.length > 0);
  let commonPrefix = '';
  if (paths.length > 0) {
    const sorted = [...paths].sort();
    const first = sorted[0];
    const last = sorted[sorted.length - 1];
    let i = 0;
    while (i < first.length && i < last.length && first[i] === last[i]) {
      i++;
    }
    commonPrefix = first.substring(0, i);
    // Trim to last directory separator
    const lastSep = commonPrefix.lastIndexOf('/');
    if (lastSep >= 0) {
      commonPrefix = commonPrefix.substring(0, lastSep + 1);
    } else {
      commonPrefix = '';
    }
  }

  function groupFromFilePath(fp) {
    if (!fp) return '_root';
    let rest = fp;
    if (commonPrefix && fp.startsWith(commonPrefix)) {
      rest = fp.substring(commonPrefix.length);
    }
    // Skip leading slash
    if (rest.startsWith('/')) rest = rest.substring(1);
    const firstSep = rest.indexOf('/');
    if (firstSep < 0) {
      // File in root or flat — group by file type/pattern
      return groupFlatByPattern(fp);
    }
    return rest.substring(0, firstSep);
  }

  function groupFlatByPattern(fp) {
    const base = fp.split('/').pop() || fp;
    if (/\.(test|spec)\./.test(base) || /test[_-].*\./.test(base) || /[_-]test\./.test(base)) return 'test';
    if (/\.config\./.test(base) || /config\./.test(base)) return 'config';
    if (/Dockerfile|docker-compose/i.test(base)) return 'infrastructure';
    if (/\.md$/.test(base) || /\.rst$/.test(base)) return 'docs';
    if (/\.sql$/.test(base)) return 'data';
    if (/\.tf$/.test(base) || /\.tfvars$/.test(base)) return 'infrastructure';
    return 'root';
  }

  const directoryGroups = {};
  for (const node of fileNodes) {
    const g = groupFromFilePath(node.filePath || '');
    if (!directoryGroups[g]) directoryGroups[g] = [];
    directoryGroups[g].push(node.id);
  }

  // --- B. Node Type Grouping ---
  const nodeTypeGroups = {};
  for (const node of fileNodes) {
    const t = node.type || 'unknown';
    if (!nodeTypeGroups[t]) nodeTypeGroups[t] = [];
    nodeTypeGroups[t].push(node.id);
  }

  // --- C. Import Adjacency ---
  // Build a map: nodeId -> group
  const nodeToGroup = {};
  for (const node of fileNodes) {
    nodeToGroup[node.id] = groupFromFilePath(node.filePath || '');
  }

  const fanOut = {};
  const fanIn = {};
  const groupFanOut = {};   // group -> {otherGroup: count}
  const groupFanIn = {};
  for (const node of fileNodes) {
    fanOut[node.id] = 0;
    fanIn[node.id] = 0;
  }
  for (const edge of importEdges) {
    const src = edge.source;
    const tgt = edge.target;
    if (!(src in fanOut)) fanOut[src] = 0;
    if (!(tgt in fanIn)) fanIn[tgt] = 0;
    fanOut[src] = (fanOut[src] || 0) + 1;
    fanIn[tgt] = (fanIn[tgt] || 0) + 1;
    const srcG = nodeToGroup[src] || '_unknown';
    const tgtG = nodeToGroup[tgt] || '_unknown';
    if (!groupFanOut[srcG]) groupFanOut[srcG] = {};
    if (!groupFanIn[tgtG]) groupFanIn[tgtG] = {};
    groupFanOut[srcG][tgtG] = (groupFanOut[srcG][tgtG] || 0) + 1;
    groupFanIn[tgtG][srcG] = (groupFanIn[tgtG][srcG] || 0) + 1;
  }

  // --- D. Cross-Category Edges (using allEdges) ---
  const crossCategoryMap = {};
  // For each node, we need its type; we have fileNodes, but allEdges may reference sub-file nodes
  // We can pull the type from the fileNodes by id; for sub-file nodes (function/class/...) we
  // skip them in this analysis as the focus is file-level.
  for (const edge of allEdges) {
    const src = edge.source;
    const tgt = edge.target;
    const srcType = (fileNodes.find(n => n.id === src) || {}).type || 'unknown';
    const tgtType = (fileNodes.find(n => n.id === tgt) || {}).type || 'unknown';
    const key = `${srcType}->${tgtType}:${edge.type}`;
    if (!crossCategoryMap[key]) {
      crossCategoryMap[key] = { fromType: srcType, toType: tgtType, edgeType: edge.type, count: 0 };
    }
    crossCategoryMap[key].count += 1;
  }
  const crossCategoryEdges = Object.values(crossCategoryMap);

  // --- E. Inter-Group Import Frequency ---
  const interGroupMap = {};
  for (const edge of importEdges) {
    const srcG = nodeToGroup[edge.source];
    const tgtG = nodeToGroup[edge.target];
    if (!srcG || !tgtG) continue;
    if (srcG === tgtG) continue;
    const key = `${srcG}->${tgtG}`;
    if (!interGroupMap[key]) interGroupMap[key] = { from: srcG, to: tgtG, count: 0 };
    interGroupMap[key].count += 1;
  }
  const interGroupImports = Object.values(interGroupMap).sort((a, b) => b.count - a.count);

  // --- F. Intra-Group Import Density ---
  const intraGroupDensity = {};
  for (const g of Object.keys(directoryGroups)) {
    let internal = 0;
    let total = 0;
    for (const edge of importEdges) {
      const srcG = nodeToGroup[edge.source];
      const tgtG = nodeToGroup[edge.target];
      if (srcG === g || tgtG === g) {
        total += 1;
        if (srcG === g && tgtG === g) internal += 1;
      }
    }
    intraGroupDensity[g] = {
      internalEdges: internal,
      totalEdges: total,
      density: total > 0 ? internal / total : 0,
    };
  }

  // --- G. Directory Pattern Matching ---
  const patternMap = {
    api: ['routes', 'api', 'controllers', 'endpoints', 'handlers', 'controller', 'routers', 'blueprints', 'serializers'],
    service: ['services', 'core', 'lib', 'domain', 'logic', 'signals', 'internal', 'composables', 'mailers', 'jobs', 'channels', 'src/main/java'],
    data: ['models', 'db', 'data', 'persistence', 'repository', 'entities', 'migrations', 'entity', 'sql', 'database', 'schema'],
    ui: ['components', 'views', 'pages', 'ui', 'layouts', 'screens'],
    middleware: ['middleware', 'plugins', 'interceptors', 'guards'],
    utility: ['utils', 'helpers', 'common', 'shared', 'tools', 'pkg', 'templatetags'],
    config: ['config', 'constants', 'env', 'settings', 'management', 'commands', '.github', '.gitlab', '.circleci'],
    test: ['__tests__', 'test', 'tests', 'spec', 'specs', 'src/test/java'],
    types: ['types', 'interfaces', 'schemas', 'contracts', 'dtos', 'dto', 'request', 'response'],
    hooks: ['hooks'],
    state: ['store', 'state', 'reducers', 'actions', 'slices'],
    assets: ['assets', 'static', 'public'],
    entry: ['cmd', 'bin'],
    documentation: ['docs', 'documentation', 'wiki'],
    infrastructure: ['deploy', 'deployment', 'infra', 'infrastructure', 'k8s', 'kubernetes', 'helm', 'charts', 'terraform', 'tf', 'docker'],
    'ci-cd': ['.github', '.gitlab', '.circleci'],
  };
  const patternMatches = {};
  for (const g of Object.keys(directoryGroups)) {
    let matched = 'other';
    for (const [pattern, dirs] of Object.entries(patternMap)) {
      if (dirs.includes(g)) {
        matched = pattern;
        break;
      }
    }
    patternMatches[g] = matched;
  }

  // --- H. Deployment Topology ---
  const deploymentTopology = {
    hasDockerfile: false,
    hasCompose: false,
    hasK8s: false,
    hasTerraform: false,
    hasCI: false,
    infraFiles: [],
  };
  for (const node of fileNodes) {
    const fp = node.filePath || '';
    const base = fp.split('/').pop() || '';
    if (/^Dockerfile(\.|$)/i.test(base) || /^docker-compose(\.|$)/i.test(base)) {
      if (/^Dockerfile(\.|$)/i.test(base)) deploymentTopology.hasDockerfile = true;
      if (/^docker-compose/i.test(base)) deploymentTopology.hasCompose = true;
      deploymentTopology.infraFiles.push(fp);
    }
    if (/k8s|kubernetes|helm|charts/.test(fp)) {
      deploymentTopology.hasK8s = true;
      deploymentTopology.infraFiles.push(fp);
    }
    if (/\.tf$|\.tfvars$/.test(base)) {
      deploymentTopology.hasTerraform = true;
      deploymentTopology.infraFiles.push(fp);
    }
    if (/\.github\/workflows|\.gitlab-ci|Jenkinsfile|\.circleci/.test(fp)) {
      deploymentTopology.hasCI = true;
      deploymentTopology.infraFiles.push(fp);
    }
  }

  // --- I. Data Pipeline Detection ---
  const dataPipeline = {
    schemaFiles: [],
    migrationFiles: [],
    dataModelFiles: [],
    apiHandlerFiles: [],
  };
  for (const node of fileNodes) {
    const fp = node.filePath || '';
    if (/\.sql$/.test(fp)) {
      if (/migrations?\//.test(fp)) dataPipeline.migrationFiles.push(fp);
      else dataPipeline.schemaFiles.push(fp);
    }
    if (/\.graphql$|\.gql$|\.proto$/.test(fp)) dataPipeline.schemaFiles.push(fp);
    if (/\/models?\//.test(fp)) dataPipeline.dataModelFiles.push(fp);
    if (/\/functions\/.*\/index\.ts$/.test(fp)) dataPipeline.apiHandlerFiles.push(fp);
  }

  // --- J. Documentation Coverage ---
  let groupsWithDocs = 0;
  const undocumentedGroups = [];
  for (const g of Object.keys(directoryGroups)) {
    const hasDoc = directoryGroups[g].some(id => {
      const n = fileNodes.find(x => x.id === id);
      return n && n.type === 'document';
    });
    if (hasDoc) groupsWithDocs += 1;
    else undocumentedGroups.push(g);
  }
  const totalGroups = Object.keys(directoryGroups).length;
  const docCoverage = {
    groupsWithDocs,
    totalGroups,
    coverageRatio: totalGroups > 0 ? groupsWithDocs / totalGroups : 0,
    undocumentedGroups,
  };

  // --- K. Dependency Direction ---
  // For each pair (A, B), if A->B > B->A then A depends on B.
  const pairTotals = {};
  for (const ig of interGroupImports) {
    const key = [ig.from, ig.to].sort().join('::');
    if (!pairTotals[key]) pairTotals[key] = { a: ig.from, b: ig.to, aToB: 0, bToA: 0 };
    if (ig.from === pairTotals[key].a && ig.to === pairTotals[key].b) {
      pairTotals[key].aToB = ig.count;
    } else {
      pairTotals[key].bToA = ig.count;
    }
  }
  const dependencyDirection = [];
  for (const p of Object.values(pairTotals)) {
    if (p.aToB > p.bToA) dependencyDirection.push({ dependent: p.a, dependsOn: p.b, count: p.aToB });
    else if (p.bToA > p.aToB) dependencyDirection.push({ dependent: p.b, dependsOn: p.a, count: p.bToA });
  }

  // --- File Stats ---
  const filesPerGroup = {};
  for (const [g, ids] of Object.entries(directoryGroups)) filesPerGroup[g] = ids.length;
  const nodeTypeCounts = {};
  for (const [t, ids] of Object.entries(nodeTypeGroups)) nodeTypeCounts[t] = ids.length;
  const fileStats = {
    totalFileNodes: fileNodes.length,
    filesPerGroup,
    nodeTypeCounts,
  };

  const result = {
    scriptCompleted: true,
    commonPrefix,
    directoryGroups,
    nodeTypeGroups,
    crossCategoryEdges,
    interGroupImports,
    intraGroupDensity,
    patternMatches,
    deploymentTopology,
    dataPipeline,
    docCoverage,
    dependencyDirection,
    fileStats,
    fileFanIn: fanIn,
    fileFanOut: fanOut,
  };

  fs.writeFileSync(outputPath, JSON.stringify(result, null, 2));
  process.stdout.write(`Wrote results to ${outputPath}\n`);
  process.exit(0);
}

main();
