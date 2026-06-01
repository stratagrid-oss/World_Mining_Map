const STATUS_COLORS = {
  Producer: "#3cb371",
  "Past Producer": "#4a8ed4",
  Prospect: "#d4a53c",
  Occurrence: "#9b9a97",
  Plant: "#9b6ed4",
  Unknown: "#d4534a",
};

let map;
let markerLayer;
let dataWorker;
let dictionaryData = null;
let requestId = 0;
let dataReady = false;
let searchTimeout = null;

const filters = {
  commodity: -1,
  status: -1,
  country: -1,
  state: -1,
  search: "",
};

function formatNumber(value) {
  return Number(value || 0).toLocaleString();
}

function formatCompact(value) {
  if (value >= 1000000) return `${Math.round(value / 100000) / 10}m`;
  if (value >= 1000) return `${Math.round(value / 100) / 10}k`;
  return String(value);
}

function setLoadingStatus(message) {
  const status = document.getElementById("loading-status");
  if (status) status.textContent = message;
}

function hideLoading() {
  const loading = document.getElementById("loading");
  if (loading) loading.style.display = "none";
}

function showLoadingError(message) {
  const loading = document.getElementById("loading");
  if (!loading) return;
  loading.innerHTML = `<h2 style="color:#d4534a">Error</h2><p>${escapeHtml(message)}</p>`;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  }[char]));
}

function getColor(statusIndex) {
  if (!dictionaryData || statusIndex < 0) return "#9b9a97";
  return STATUS_COLORS[dictionaryData.statuses[statusIndex]] || "#9b9a97";
}

function populateSelect(selectId, items, defaultLabel) {
  const select = document.getElementById(selectId);
  select.innerHTML = `<option value="-1">${defaultLabel}</option>`;

  for (const item of items) {
    const option = document.createElement("option");
    option.value = item.value;
    option.textContent = `${item.label} (${formatNumber(item.count)})`;
    select.appendChild(option);
  }
}

function clusterIcon(count) {
  const size = count >= 10000 ? 54 : count >= 1000 ? 46 : 38;
  return L.divIcon({
    className: `cluster-marker ${count >= 10000 ? "large" : ""}`,
    html: `<span style="width:${size}px;height:${size}px">${formatCompact(count)}</span>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

function popupHtml(record) {
  const commodity = record[3] >= 0 ? dictionaryData.commodities[record[3]] : "-";
  const status = record[4] >= 0 ? dictionaryData.statuses[record[4]] : "-";
  const state = record[5] >= 0 ? dictionaryData.states[record[5]] : "-";
  const country = record[6] >= 0 ? dictionaryData.countries[record[6]] : "-";
  const depId = record[7];
  const url = depId ? `https://mrdata.usgs.gov/mrds/show-mrds.php?dep_id=${encodeURIComponent(depId)}` : "";

  let html = `<div class="popup-name">${escapeHtml(record[2] || "Unnamed")}</div>`;
  html += `<div class="popup-row"><b>Commodity:</b> ${escapeHtml(commodity)}</div>`;
  html += `<div class="popup-row"><b>Status:</b> ${escapeHtml(status)}</div>`;
  html += `<div class="popup-row"><b>Location:</b> ${escapeHtml(state)}, ${escapeHtml(country)}</div>`;
  html += `<div class="popup-row"><b>Coords:</b> ${escapeHtml(record[0])}, ${escapeHtml(record[1])}</div>`;
  if (url) html += `<div style="margin-top:6px"><a class="popup-link" href="${url}" target="_blank" rel="noreferrer">View on USGS -></a></div>`;
  return html;
}

function renderItems(items) {
  markerLayer.clearLayers();

  const batch = [];
  for (const item of items) {
    if (item.type === "cluster") {
      const marker = L.marker([item.lat, item.lng], { icon: clusterIcon(item.count), keyboard: false });
      marker.on("click", () => {
        map.setView([item.lat, item.lng], Math.min(map.getZoom() + 2, 18));
      });
      batch.push(marker);
      continue;
    }

    const marker = L.circleMarker([item.lat, item.lng], {
      radius: 5,
      fillColor: getColor(item.record[4]),
      color: "#0f1117",
      weight: 1,
      fillOpacity: 0.85,
    });
    marker.bindPopup(() => popupHtml(item.record), { maxWidth: 280 });
    batch.push(marker);
  }

  for (const layer of batch) markerLayer.addLayer(layer);
  document.getElementById("count-map").textContent = formatNumber(items.length);
}

function currentBounds() {
  const bounds = map.getBounds().pad(0.18);
  return {
    west: bounds.getWest(),
    east: bounds.getEast(),
    south: bounds.getSouth(),
    north: bounds.getNorth(),
  };
}

function requestRender() {
  if (!dataReady) return;
  const id = ++requestId;
  dataWorker.postMessage({
    type: "query",
    requestId: id,
    zoom: map.getZoom(),
    bounds: currentBounds(),
    filters: { ...filters },
  });
}

function initMap() {
  map = L.map("map", {
    center: [39, -98],
    zoom: 4,
    zoomControl: true,
    preferCanvas: true,
    maxZoom: 18,
    minZoom: 2,
    maxBounds: [[-85, -200], [85, 200]],
    maxBoundsViscosity: 0.8,
  });

  const streets = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "&copy; OpenStreetMap | Data: USGS MRDS",
    maxZoom: 19,
  }).addTo(map);

  const topo = L.tileLayer("https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png", {
    attribution: "&copy; OpenTopoMap | Data: USGS MRDS",
    maxZoom: 17,
  });

  const satellite = L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
    attribution: "&copy; Esri World Imagery | Data: USGS MRDS",
    maxZoom: 19,
  });

  L.control.layers({
    "Street Map": streets,
    Topographic: topo,
    Satellite: satellite,
  }, null, { position: "topright", collapsed: true }).addTo(map);

  markerLayer = L.layerGroup().addTo(map);
  map.on("moveend zoomend", requestRender);
  setTimeout(() => map.invalidateSize(), 200);
}

function initWorker() {
  dataWorker = new Worker("data-worker.js");

  dataWorker.addEventListener("message", (event) => {
    const message = event.data;

    if (message.type === "status") {
      setLoadingStatus(message.message);
      return;
    }

    if (message.type === "loaded") {
      dictionaryData = message.dictionaries;
      dataReady = true;

      document.getElementById("count-total").textContent = formatNumber(message.total);
      document.getElementById("count-filtered").textContent = formatNumber(message.total);
      populateSelect("filter-commodity", message.options.commodities, "All Commodities");
      populateSelect("filter-status", message.options.statuses, "All Statuses");
      populateSelect("filter-country", message.options.countries, "All Countries");
      populateSelect("filter-state", message.options.states, "All States");
      hideLoading();
      requestRender();
      return;
    }

    if (message.type === "clusters") {
      if (message.requestId !== requestId) return;
      document.getElementById("count-filtered").textContent = formatNumber(message.filteredCount);
      renderItems(message.items);
      return;
    }

    if (message.type === "error") {
      showLoadingError(message.message);
    }
  });

  dataWorker.postMessage({ type: "load" });
}

function bindControls() {
  document.getElementById("filter-commodity").addEventListener("change", (event) => {
    filters.commodity = Number(event.target.value);
    requestRender();
  });
  document.getElementById("filter-status").addEventListener("change", (event) => {
    filters.status = Number(event.target.value);
    requestRender();
  });
  document.getElementById("filter-country").addEventListener("change", (event) => {
    filters.country = Number(event.target.value);
    requestRender();
  });
  document.getElementById("filter-state").addEventListener("change", (event) => {
    filters.state = Number(event.target.value);
    requestRender();
  });

  document.getElementById("search-name").addEventListener("input", (event) => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
      filters.search = event.target.value.trim().toLowerCase();
      requestRender();
    }, 250);
  });

  document.getElementById("btn-reset").addEventListener("click", () => {
    filters.commodity = -1;
    filters.status = -1;
    filters.country = -1;
    filters.state = -1;
    filters.search = "";
    document.getElementById("filter-commodity").value = "-1";
    document.getElementById("filter-status").value = "-1";
    document.getElementById("filter-country").value = "-1";
    document.getElementById("filter-state").value = "-1";
    document.getElementById("search-name").value = "";
    requestRender();
  });

  document.getElementById("toggle-btn").addEventListener("click", () => {
    document.getElementById("panel").classList.toggle("collapsed");
    setTimeout(() => map.invalidateSize(), 350);
  });
}

document.addEventListener("DOMContentLoaded", () => {
  try {
    initMap();
    bindControls();
    initWorker();
  } catch (error) {
    showLoadingError(error.message || String(error));
    console.error(error);
  }
});
