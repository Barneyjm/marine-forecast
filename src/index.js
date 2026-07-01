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
