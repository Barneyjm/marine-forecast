// Same-origin API for the marine-forecast page. api.weather.gov sends no CORS
// header, requires a User-Agent, and no longer serves structured marine zone
// forecasts — so this Worker fetches NWS server-side and returns clean JSON.
// Anything that isn't /api/* falls through to the static assets in ./public.

const UA = "marine-forecast (https://github.com/Barneyjm/marine-forecast)";
const CORS = { "Access-Control-Allow-Origin": "*" };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const p = url.pathname;
    try {
      if (p === "/api/zones") return json(await zoneList());
      let m;
      if ((m = p.match(/^\/api\/forecast\/([A-Z]{3}\d{3})$/))) return json(await forecast(m[1]));
      if ((m = p.match(/^\/api\/alerts\/([A-Z]{3}\d{3})$/))) return json(await alerts(m[1]));
      if ((m = p.match(/^\/api\/tides\/([A-Z]{3}\d{3})$/))) return json(await tides(m[1]));
    } catch (e) {
      return json({ error: String(e && e.message || e) }, 502);
    }
    return env.ASSETS.fetch(request);
  },
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=120", ...CORS },
  });
}

function nws(path, ttl = 120) {
  return fetch("https://api.weather.gov" + path, {
    headers: { "User-Agent": UA, Accept: "application/geo+json" },
    cf: { cacheTtl: ttl, cacheEverything: true },
  });
}

// Searchable list of coastal marine zones — cached hard, it changes rarely.
async function zoneList() {
  const r = await nws("/zones?type=coastal", 86400);
  if (!r.ok) throw new Error("zone list HTTP " + r.status);
  const data = await r.json();
  const feats = data.features || [];
  const zones = feats
    .map((f) => ({ id: f.properties.id, name: f.properties.name }))
    .filter((z) => z.id && z.name)
    .sort((a, b) => a.name.localeCompare(b.name));
  return { zones };
}

async function alerts(zoneId) {
  const r = await nws("/alerts/active/zone/" + zoneId, 60);
  if (!r.ok) throw new Error("alerts HTTP " + r.status);
  return await r.json(); // shape: { features: [...] }
}

// Tides: the zone is an area, so take its geometry centroid, find the nearest
// NOAA CO-OPS tide-prediction station, and return upcoming high/low times.
async function tides(zoneId) {
  const meta = await (await nws("/zones/forecast/" + zoneId, 86400)).json();
  const c = centroid(meta.geometry);
  if (!c) return { station: null, predictions: [] };

  const st = await nearestTideStation(c);
  if (!st) return { station: null, predictions: [] };

  const predictions = await tidePredictions(st.id);
  return {
    station: { id: st.id, name: st.name, miles: Math.round(haversine(c, { lat: +st.lat, lon: +st.lng })) },
    predictions,
  };
}

function centroid(geo) {
  if (!geo || !geo.coordinates) return null;
  let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180, n = 0;
  const walk = (a) => {
    if (typeof a[0] === "number") {
      const lon = a[0], lat = a[1];
      if (lat < minLat) minLat = lat; if (lat > maxLat) maxLat = lat;
      if (lon < minLon) minLon = lon; if (lon > maxLon) maxLon = lon;
      n++;
    } else a.forEach(walk);
  };
  walk(geo.coordinates);
  return n ? { lat: (minLat + maxLat) / 2, lon: (minLon + maxLon) / 2 } : null;
}

async function nearestTideStation(c) {
  const r = await fetch(
    "https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations.json?type=tidepredictions",
    { cf: { cacheTtl: 604800, cacheEverything: true } }
  );
  if (!r.ok) return null;
  const data = await r.json();
  let best = null, bestD = Infinity;
  for (const s of data.stations || []) {
    const d = haversine(c, { lat: +s.lat, lon: +s.lng });
    if (d < bestD) { bestD = d; best = s; }
  }
  return best;
}

async function tidePredictions(id) {
  // Start a day back (UTC) so "now" is covered regardless of the station's
  // timezone; the client filters to upcoming events. Times come back local.
  const start = new Date(Date.now() - 24 * 3600 * 1000);
  const ymd = "" + start.getUTCFullYear() +
    String(start.getUTCMonth() + 1).padStart(2, "0") + String(start.getUTCDate()).padStart(2, "0");
  const url = "https://api.tidesandcurrents.noaa.gov/api/prod/datagetter" +
    "?product=predictions&application=marine-forecast&datum=MLLW&interval=hilo" +
    "&units=english&time_zone=lst_ldt&format=json&range=120&begin_date=" + ymd + "&station=" + id;
  const r = await fetch(url, { cf: { cacheTtl: 3600, cacheEverything: true } });
  if (!r.ok) return [];
  const data = await r.json();
  return (data.predictions || []).map((p) => ({ t: p.t, type: p.type, v: p.v }));
}

function haversine(a, b) {
  const R = 3959, toR = (x) => (x * Math.PI) / 180;
  const dLat = toR(b.lat - a.lat), dLon = toR(b.lon - a.lon);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toR(a.lat)) * Math.cos(toR(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

// Marine zone forecast now lives only inside the office's text product
// (Coastal Waters / Nearshore / Offshore). Find the office, pull the latest
// product, extract this zone's segment, parse it into periods.
async function forecast(zoneId) {
  const meta = await (await nws("/zones/forecast/" + zoneId, 86400)).json();
  const office = (meta.properties && meta.properties.cwa && meta.properties.cwa[0]) || null;
  const name = (meta.properties && meta.properties.name) || zoneId;
  if (!office) throw new Error("no forecast office for " + zoneId);

  for (const code of ["CWF", "NSH", "OFF"]) {
    const list = await (await nws(`/products/types/${code}/locations/${office}`, 120)).json();
    const latest = (list["@graph"] || [])[0];
    if (!latest) continue;
    const prod = await (await nws("/products/" + latest.id, 120)).json();
    const seg = findSegment(prod.productText || "", zoneId);
    if (seg) {
      return { properties: { updated: latest.issuanceTime, name, periods: parsePeriods(seg) } };
    }
  }
  return { properties: { updated: null, name, periods: [] } };
}

// A CWF/NSH/OFF product is a set of zone segments separated by "$$". Each
// segment opens with a UGC block (e.g. "ANZ234-020000-" or grouped like
// "ANZ230>236-231-"). Return the segment whose UGC block contains this zone.
function findSegment(text, zoneId) {
  for (const seg of text.split("$$")) {
    const m = seg.replace(/^\s+/, "").match(/^([\s\S]*?)-\d{6}-/);
    if (m && ugcHasZone(m[1].replace(/[\r\n]+/g, "-"), zoneId)) return seg;
  }
  return null;
}

function ugcHasZone(ugc, zoneId) {
  const prefix = zoneId.slice(0, 3), n = parseInt(zoneId.slice(3), 10);
  let cur = "";
  for (const tok of ugc.split("-")) {
    const t = tok.trim();
    const pm = t.match(/^([A-Z]{3})?(\d{3})(?:>(\d{3}))?$/);
    if (!pm) continue;
    if (pm[1]) cur = pm[1];
    if (cur !== prefix) continue;
    const lo = parseInt(pm[2], 10), hi = pm[3] ? parseInt(pm[3], 10) : lo;
    if (n >= lo && n <= hi) return true;
  }
  return false;
}

// Periods are lines like ".TODAY...SW winds 15 to 20 kt..." continuing over
// wrapped lines until the next period or the end of the segment. A leading
// "...HEADLINE..." (three dots) is not a period and is skipped.
function parsePeriods(seg) {
  const periods = [];
  let cur = null;
  for (const line of seg.split(/\r?\n/)) {
    const pm = line.match(/^\.([A-Z][A-Za-z0-9 '\/]*?)\.\.\.(.*)$/);
    if (pm) {
      if (cur) periods.push(cur);
      cur = { name: titleCase(pm[1]), detailedForecast: pm[2] };
    } else if (cur) {
      const t = line.trim();
      if (/^\$\$/.test(t) || /^&&/.test(t)) break;
      if (t) cur.detailedForecast += " " + t;
    }
  }
  if (cur) periods.push(cur);
  for (const p of periods) p.detailedForecast = p.detailedForecast.replace(/\s+/g, " ").trim();
  return periods;
}

function titleCase(s) {
  return s.trim().toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}
