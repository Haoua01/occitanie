// ============================================================================
// Configuration
// ============================================================================

const BANKS = [
  "BNP_Paribas",
  "BPCE",
  "Credit_Agricole",
  "Credit_Mutuel",
  "La_Banque_Postale",
  "Others",
  "SG",
  "camions-jaunes",
];

const BANK_LABELS = {
  "BNP_Paribas": "BNP Paribas",
  "BPCE": "BPCE",
  "Credit_Agricole": "Crédit Agricole",
  "Credit_Mutuel": "Crédit Mutuel",
  "La_Banque_Postale": "La Banque Postale",
  "Others": "Autres",
  "SG": "Société Générale",
  "camions-jaunes": "La Poste (camions jaunes)",
};



// Pour chaque type de score, on définit :
// - le fichier source
// - le code commune
// - la fonction qui retourne le nom de colonne pour une banque donnée
//   ('total' pour la colonne agrégée)
const SCORE_CONFIG = {
  couverture: {
    file: "data/couverture_1_05.geojson",
    codeField: "codgeo",
    columnFor: (bank) =>
      bank === "total" ? "score_total_avec_camions" : `score_${bank}`,
    label: "Score de couverture",
  },
  fca: {
    file: "data/fca_avec_1_01.geojson",
    codeField: "codgeo",
    columnFor: (bank) =>
      bank === "total" ? "score_total_haoua" : `${bank}_haoua`,
    label: "Score E2SFCA",
  },
};

// Palette de couleurs (5 classes, du moins accessible au plus accessible)
const COLOR_SCALE = ['#f7fbff', '#d0e1f2', '#8cc0dd', '#43a2ca', '#08306b'];

// Échelle de couleurs "Blues" pour les isochrones, selon isochrone_group (0-20 min)
const ISO_COLOR_STOPS = [
  [0,  '#08306b'],
  [1,  '#084594'],
  [2,  '#08519c'],
  [3,  '#2171b5'],
  [4,  '#2b8cbe'],
  [5,  '#4292c6'],
  [6,  '#4a98c9'],
  [7,  '#5aa3cf'],
  [8,  '#6baed6'],
  [9,  '#7db8da'],
  [10, '#8cc0dd'],
  [11, '#9ecae1'],
  [12, '#abd0e6'],
  [13, '#b7d7ea'],
  [14, '#c6dbef'],
  [15, '#d0e1f2'],
  [16, '#deebf7'],
  [17, '#e3eef9'],
  [18, '#edf4fc'],
  [19, '#f3f8fe'],
  [20, '#f7fbff'],
];

// Reproduit le comportement 'step' de Mapbox/MapLibre :
// renvoie la couleur du dernier seuil <= t
function isoColorForTime(t) {
  if (t === null || t === undefined || isNaN(t)) return "#cccccc";
  let color = ISO_COLOR_STOPS[0][1];
  for (const [threshold, c] of ISO_COLOR_STOPS) {
    if (t >= threshold) color = c;
    else break;
  }
  return color;
}

function isoStyle(feature) {
  const t = feature.properties ? feature.properties.isochrone_group : null;
  return {
    fillColor: isoColorForTime(t),
    color: "#666",
    weight: 0.8,
    opacity: 0.1,
    fillOpacity: 1,
  };
}

function buildIsoLegend(bank) {
  const sampleStops = [0, 4, 8, 12, 16, 20];
  let html = `<div class="legend-title">Temps de trajet — ${BANK_LABELS[bank]}</div>`;
  for (const t of sampleStops) {
    const color = isoColorForTime(t);
    const label = t === 20 ? "20+ min" : `${t} min`;
    html += `
      <div class="legend-row">
        <div class="legend-swatch" style="background:${color}"></div>
        <span>${label}</span>
      </div>`;
  }
  return html;
}

// ============================================================================
// État global
// ============================================================================

const map = L.map("map").setView([43.9, 2.0], 8); // centre approx. Occitanie

L.tileLayer('https://tile.jawg.io/jawg-light/{z}/{x}/{y}.png?access-token=PQCx6weWnnPoPsww8wKfKQ6zBSJpRIfq028ZlO093IXVhQ8ajSumQ5A8VuGGY7S6', {
  attribution: '<a href="https://www.jawg.io" target="_blank">&copy; Jawg Maps</a> &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  maxZoom: 18,
}).addTo(map);


let communeLayer = null;       // couche GeoJSON des communes (choroplèthe)
let dataCache = {};            // cache des geojson communes par type de score
let currentBreaks = null;      // bornes de classes courantes
let isochroneLayers = {};      // { bankKey: L.geoJSON } pour la commune sélectionnée
let selectedCommuneCode = null;

const scoreTypeSelect = document.getElementById("scoreType");
const bankSelect = document.getElementById("bankSelect");
const isoBankSelect = document.getElementById("isoBankSelect");
const hideCommunesToggle = document.getElementById("hideCommunesToggle");
const hideIsochronesToggle = document.getElementById("hideIsochronesToggle");
const legendDiv = document.getElementById("legend");
const isoLegendDiv = document.getElementById("iso-legend");
const infoDiv = document.getElementById("commune-info");
const toggleDiv = document.getElementById("isochrone-toggles");
const checkboxDiv = document.getElementById("isochrone-checkboxes");

let globalIsoLayer = null;     // L.layerGroup pour les isochrones affichées sur la zone visible
let globalIsoLoading = false;
const globalIsoCache = {};     // cache par "{bank}/{codgeo}" -> geojson ou null

// ============================================================================
// Chargement et affichage de la couche choroplèthe
// ============================================================================

async function loadScoreData(scoreType) {
  if (dataCache[scoreType]) return dataCache[scoreType];

  infoDiv.innerHTML = `<p class="loading">Chargement des données (${scoreType})...</p>`;
  const cfg = SCORE_CONFIG[scoreType];
  const res = await fetch(cfg.file);
  const geojson = await res.json();
  dataCache[scoreType] = geojson;
  return geojson;
}

function computeBreaks(geojson, column) {
  const values = geojson.features
    .map((f) => f.properties[column])
    .filter((v) => v !== null && v !== undefined && !isNaN(v));

  if (values.length === 0) return [0, 0.25, 0.5, 0.75, 1];

  // Jenks natural breaks (5 classes)
  const numClasses = 5;
  if (values.length <= numClasses) {
    values.sort((a, b) => a - b);
    return [values[0], ...values.slice(1), values[values.length - 1]];
  }

  const breaks = ss.jenks(values, numClasses); // renvoie numClasses+1 bornes (min...max)
  return breaks;
}

function getColor(value, breaks) {
  if (value === null || value === undefined || isNaN(value)) return "#cccccc";
  for (let i = 0; i < COLOR_SCALE.length; i++) {
    if (value <= breaks[i + 1] || i === COLOR_SCALE.length - 1) {
      return COLOR_SCALE[i];
    }
  }
  return COLOR_SCALE[COLOR_SCALE.length - 1];
}

function styleFeature(feature, column, breaks) {
  const value = feature.properties[column];
  return {
    fillColor: getColor(value, breaks),
    weight: 1,
    opacity: 0.1,
    color: "#666",
    fillOpacity: 1,
  };
}

function buildLegend(breaks, label) {
  let html = `<div class="legend-title">${label}</div>`;
  for (let i = 0; i < COLOR_SCALE.length; i++) {
    const from = breaks[i].toFixed(2);
    const to = breaks[i + 1].toFixed(2);
    html += `
      <div class="legend-row">
        <div class="legend-swatch" style="background:${COLOR_SCALE[i]}"></div>
        <span>${from} – ${to}</span>
      </div>`;
  }
  
  legendDiv.innerHTML = html;
}

async function renderChoropleth() {
  const scoreType = scoreTypeSelect.value;
  const bank = bankSelect.value;
  const cfg = SCORE_CONFIG[scoreType];
  const column = cfg.columnFor(bank);

  const geojson = await loadScoreData(scoreType);
  currentBreaks = computeBreaks(geojson, column);

  if (communeLayer) {
    map.removeLayer(communeLayer);
  }

  communeLayer = L.geoJSON(geojson, {
    style: (feature) => styleFeature(feature, column, currentBreaks),
    onEachFeature: (feature, layer) => {
      layer.on("click", () => onCommuneClick(feature, column, scoreType, bank));
      layer.on("mouseover", () => layer.setStyle({ weight: 2, color: "#222" }));
      layer.on("mouseout", () =>
        layer.setStyle(styleFeature(feature, column, currentBreaks))
      );
    },
  });

  if (!hideCommunesToggle.checked) {
    communeLayer.addTo(map);
  }


  const bankLabel = bank === "total" ? "Total" : BANK_LABELS[bank];
  buildLegend(currentBreaks, `${cfg.label} — ${bankLabel}`);

  if (!infoDiv.dataset.hasContent) {
    infoDiv.innerHTML = `<p>Cliquez sur une commune pour afficher ses scores.</p>`;
  }
}

// ============================================================================
// Panneau d'information sur une commune + isochrones
// ============================================================================

function formatScore(v) {
  if (v === null || v === undefined || isNaN(v)) return "—";
  return Number(v).toFixed(3);
}

async function onCommuneClick(feature, activeColumn, scoreType, bank) {
  const props = feature.properties;
  const codeInsee = props["codgeo"];
  selectedCommuneCode = codeInsee;
  infoDiv.dataset.hasContent = "true";

  const couvData = await loadScoreData("couverture");
  const fcaData = await loadScoreData("fca");

  const couvFeature = couvData.features.find((f) => f.properties.codgeo === codeInsee);
  const fcaFeature = fcaData.features.find((f) => f.properties.codgeo === codeInsee);

  let rows = "";
  for (const b of BANKS) {
    const couvVal = couvFeature ? couvFeature.properties[`score_${b}`] : null;
    const fcaVal = fcaFeature ? fcaFeature.properties[`${b}_haoua`] : null;
    rows += `
      <tr>
        <td>${BANK_LABELS[b]}</td>
        <td class="value">${formatScore(couvVal)}</td>
        <td class="value">${formatScore(fcaVal)}</td>
      </tr>`;
  }
  const couvTotal = couvFeature ? couvFeature.properties["score_total_avec_camions"] : null;
  const fcaTotal = fcaFeature ? fcaFeature.properties["score_total_haoua"] : null;
  rows += `
    <tr style="font-weight:600;">
      <td>Total</td>
      <td class="value">${formatScore(couvTotal)}</td>
      <td class="value">${formatScore(fcaTotal)}</td>
    </tr>`;

  const libgeo = props["libgeo"] || codeInsee;

  infoDiv.innerHTML = `
    <h3>${libgeo} (${codeInsee})</h3>
    <table>
      <tr><td></td><td class="value">Couverture</td><td class="value">E2SFCA</td></tr>
      ${rows}
    </table>
  `;

}

// ============================================================================
// Chargement et affichage des isochrones pour la commune sélectionnée
// (toutes banques, colorées par groupe bancaire — checkboxes)
// ============================================================================

function clearIsochrones() {
  for (const key in isochroneLayers) {
    map.removeLayer(isochroneLayers[key]);
  }
  isochroneLayers = {};
  checkboxDiv.innerHTML = "";
  toggleDiv.classList.add("hidden");
}

async function loadIsochrones(codeInsee) {
  

  toggleDiv.classList.remove("hidden");
  checkboxDiv.innerHTML = `<p class="loading">Chargement des isochrones...</p>`;

  const selectedBank = isoBankSelect.value;
  const banksToLoad = selectedBank ? [selectedBank] : BANKS;

  let firstBounds = null;
  let anyLoaded = false;
  let html = "";

  for (const bank of banksToLoad) {
    const url = `data/isochrones/${codeInsee}/${bank}.geojson`;
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      const geojson = await res.json();
      if (!geojson.features || geojson.features.length === 0) continue;

      const layer = L.geoJSON(geojson, {
        style: selectedBank ? isoStyle : {
          color: BANK_COLORS[bank],
          weight: 2,
          fillColor: BANK_COLORS[bank],
          fillOpacity: 0.15,
        },
      });

      isochroneLayers[bank] = layer;
      anyLoaded = true;

      const b = layer.getBounds();
      if (b.isValid()) {
        firstBounds = firstBounds ? firstBounds.extend(b) : b;
      }

      html += `
        <div class="iso-checkbox-row">
          <input type="checkbox" id="iso-${bank}" checked data-bank="${bank}">
          <span class="iso-color-dot" style="background:${BANK_COLORS[bank]}"></span>
          <label for="iso-${bank}">${BANK_LABELS[bank]}</label>
        </div>`;
    } catch (e) {
      // fichier manquant pour cette banque/commune : on ignore
    }
  }

  if (!anyLoaded) {
    checkboxDiv.innerHTML = `<p>Aucune isochrone disponible pour cette commune.</p>`;
    return;
  }

  checkboxDiv.innerHTML = html;

  if (selectedBank) {
    isoLegendDiv.innerHTML = buildIsoLegend(selectedBank);
  }

  for (const bank in isochroneLayers) {
    isochroneLayers[bank].addTo(map);
    const cb = document.getElementById(`iso-${bank}`);
    cb.addEventListener("change", (e) => {
      if (e.target.checked) {
        isochroneLayers[bank].addTo(map);
      } else {
        map.removeLayer(isochroneLayers[bank]);
      }
    });


      if (!hideIsochronesToggle.checked) {
    isochronLayers[bank].addTo(map);
  }
  }

  if (firstBounds && firstBounds.isValid()) {
    map.fitBounds(firstBounds, { maxZoom: 13 });
  }
}

// ============================================================================
// Filtre dropdown : isochrones d'une banque sur la zone visible,
// colorées selon isochrone_group (échelle Blues 0-20min)
// ============================================================================

async function refreshIsoBankLayer() {
  const bank = isoBankSelect.value;

  if (!bank) {
    clearIsoBankLayer();
    isoLegendDiv.innerHTML = "";
    return;
  }

  if (!communeLayer) return;
  if (globalIsoLoading) return;
  globalIsoLoading = true;

  if (!globalIsoLayer) {
    globalIsoLayer = L.layerGroup().addTo(map);
  }
  globalIsoLayer.clearLayers();

  const bounds = map.getBounds();
  const codes = [];
  communeLayer.eachLayer((layer) => {
    if (bounds.intersects(layer.getBounds())) {
      codes.push(layer.feature.properties["codgeo"]);
    }
  });

  const MAX_COMMUNES = 5000;
  const toLoad = codes.slice(0, MAX_COMMUNES);

  await Promise.all(
    toLoad.map(async (code) => {
      const cacheKey = `${bank}/${code}`;
      let geojson = globalIsoCache[cacheKey];

      if (geojson === undefined) {
        try {
          const res = await fetch(`data/isochrones/${code}/${bank}.geojson`);
          geojson = res.ok ? await res.json() : null;
        } catch {
          geojson = null;
        }
        globalIsoCache[cacheKey] = geojson;
      }

      if (geojson && geojson.features && geojson.features.length > 0) {
        L.geoJSON(geojson, { style: isoStyle }).addTo(globalIsoLayer);
      }
    })
  );

  globalIsoLoading = false;

  isoLegendDiv.innerHTML = buildIsoLegend(bank);


}

function clearIsoBankLayer() {
  if (globalIsoLayer) {
    globalIsoLayer.clearLayers();
  }
}

// ============================================================================
// Événements UI
// ============================================================================

scoreTypeSelect.addEventListener("change", renderChoropleth);
bankSelect.addEventListener("change", renderChoropleth);

isoBankSelect.addEventListener("change", refreshIsoBankLayer);

hideCommunesToggle.addEventListener("change", () => {
  if (!communeLayer) return;
  if (hideCommunesToggle.checked) {
    map.removeLayer(communeLayer);
  } else {
    communeLayer.addTo(map);
  }
});

hideIsochronesToggle.addEventListener("change", () => {
  if (!globalIsoLayer) return;
  if (hideIsochronesToggle.checked) {
    map.removeLayer(globalIsoLayer);
  } else {
    globalIsoLayer.addTo(map);
  }
});

map.on("moveend", () => {
  if (isoBankSelect.value) {
    refreshIsoBankLayer();
  }
});

// ============================================================================
// Initialisation
// ============================================================================

renderChoropleth();
