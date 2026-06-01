const DATA_URL = "data/mrds.json.gz";
const CLUSTER_RADIUS = 56;
const MAX_LAT = 85.05112878;

let data = null;
let records = [];
let namesLower = [];
let filterCacheKey = "";
let filterCache = { indexes: null, count: 0 };

function postStatus(message) {
  self.postMessage({ type: "status", message });
}

async function inflateGzip(buffer) {
  if (typeof DecompressionStream === "function") {
    const stream = new Blob([buffer]).stream().pipeThrough(new DecompressionStream("gzip"));
    return new Response(stream).text();
  }

  importScripts("https://cdnjs.cloudflare.com/ajax/libs/pako/2.1.0/pako.min.js");
  return self.pako.ungzip(new Uint8Array(buffer), { to: "string" });
}

function countOptions(dictionary, recordIndex) {
  const counts = new Map();

  for (const record of records) {
    const value = record[recordIndex];
    if (value >= 0) counts.set(value, (counts.get(value) || 0) + 1);
  }

  return Array.from(counts, ([value, count]) => ({
    value,
    count,
    label: dictionary[value],
  })).sort((a, b) => a.label.localeCompare(b.label));
}

function dictionaries() {
  return {
    commodities: data.c,
    statuses: data.s,
    states: data.st,
    countries: data.co,
  };
}

function buildOptions() {
  return {
    commodities: countOptions(data.c, 3),
    statuses: countOptions(data.s, 4),
    states: countOptions(data.st, 5),
    countries: countOptions(data.co, 6),
  };
}

async function loadData() {
  postStatus("Downloading compressed mineral records...");
  const response = await fetch(DATA_URL, { cache: "force-cache" });
  if (!response.ok) throw new Error(`Could not load ${DATA_URL}: ${response.status}`);

  const buffer = await response.arrayBuffer();
  postStatus("Decompressing mineral records...");
  const text = await inflateGzip(buffer);

  postStatus("Indexing mineral records...");
  data = JSON.parse(text);
  records = data.r || [];
  namesLower = records.map((record) => (record[2] || "").toLowerCase());

  self.postMessage({
    type: "loaded",
    total: records.length,
    dictionaries: dictionaries(),
    options: buildOptions(),
  });
}

function filterKey(filters) {
  return [
    filters.commodity,
    filters.status,
    filters.country,
    filters.state,
    filters.search || "",
  ].join("|");
}

function hasActiveFilters(filters) {
  return filters.commodity !== -1 ||
    filters.status !== -1 ||
    filters.country !== -1 ||
    filters.state !== -1 ||
    Boolean(filters.search);
}

function matchesFilters(record, index, filters) {
  if (filters.commodity !== -1 && record[3] !== filters.commodity) return false;
  if (filters.status !== -1 && record[4] !== filters.status) return false;
  if (filters.country !== -1 && record[6] !== filters.country) return false;
  if (filters.state !== -1 && record[5] !== filters.state) return false;
  if (filters.search && !namesLower[index].includes(filters.search)) return false;
  return true;
}

function getFilteredIndexes(filters) {
  const key = filterKey(filters);
  if (key === filterCacheKey) return filterCache;

  filterCacheKey = key;

  if (!hasActiveFilters(filters)) {
    filterCache = { indexes: null, count: records.length };
    return filterCache;
  }

  const indexes = [];
  for (let index = 0; index < records.length; index++) {
    if (matchesFilters(records[index], index, filters)) indexes.push(index);
  }

  filterCache = { indexes, count: indexes.length };
  return filterCache;
}

function clampLatitude(lat) {
  return Math.max(-MAX_LAT, Math.min(MAX_LAT, lat));
}

function project(lat, lng, zoom) {
  const scale = 256 * (2 ** zoom);
  const safeLat = clampLatitude(lat);
  const sin = Math.sin((safeLat * Math.PI) / 180);
  return {
    x: ((lng + 180) / 360) * scale,
    y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * scale,
  };
}

function isInsideBounds(lat, lng, bounds) {
  const west = Math.max(-180, bounds.west);
  const east = Math.min(180, bounds.east);
  const south = Math.max(-MAX_LAT, bounds.south);
  const north = Math.min(MAX_LAT, bounds.north);

  if (lat < south || lat > north) return false;
  if (west <= east) return lng >= west && lng <= east;
  return lng >= west || lng <= east;
}

function buildClusters(bounds, zoom, filters) {
  const filtered = getFilteredIndexes(filters);
  const source = filtered.indexes || records;
  const clusters = new Map();
  const usingIndexes = Boolean(filtered.indexes);

  for (let sourceIndex = 0; sourceIndex < source.length; sourceIndex++) {
    const recordIndex = usingIndexes ? source[sourceIndex] : sourceIndex;
    const record = records[recordIndex];
    const lat = record[0];
    const lng = record[1];

    if (!isInsideBounds(lat, lng, bounds)) continue;

    const point = project(lat, lng, zoom);
    const key = `${Math.floor(point.x / CLUSTER_RADIUS)}:${Math.floor(point.y / CLUSTER_RADIUS)}`;
    let cluster = clusters.get(key);

    if (!cluster) {
      cluster = { count: 0, latSum: 0, lngSum: 0, first: record };
      clusters.set(key, cluster);
    }

    cluster.count++;
    cluster.latSum += lat;
    cluster.lngSum += lng;
  }

  const items = [];
  for (const cluster of clusters.values()) {
    if (cluster.count === 1) {
      items.push({
        type: "point",
        lat: cluster.first[0],
        lng: cluster.first[1],
        record: cluster.first,
      });
      continue;
    }

    items.push({
      type: "cluster",
      lat: cluster.latSum / cluster.count,
      lng: cluster.lngSum / cluster.count,
      count: cluster.count,
    });
  }

  return { items, filteredCount: filtered.count };
}

self.addEventListener("message", async (event) => {
  const message = event.data;

  try {
    if (message.type === "load") {
      await loadData();
      return;
    }

    if (message.type === "query") {
      const result = buildClusters(message.bounds, message.zoom, message.filters);
      self.postMessage({
        type: "clusters",
        requestId: message.requestId,
        filteredCount: result.filteredCount,
        items: result.items,
      });
    }
  } catch (error) {
    self.postMessage({ type: "error", message: error.message || String(error) });
  }
});
