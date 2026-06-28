const SDN_CSV_URL = 'https://data.opensanctions.org/datasets/latest/us_ofac_sdn/targets.simple.csv';
const TTL_MS = 24 * 60 * 60 * 1000;

let cache = null;
let inflight = null;

function normName(s) {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseCsv(text) {
  const rows = [];
  let field = '';
  let row = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else { inQuotes = false; }
      } else { field += c; }
    } else if (c === '"') { inQuotes = true;
    } else if (c === ',') { row.push(field); field = '';
    } else if (c === '\n') { row.push(field); rows.push(row); row = []; field = '';
    } else if (c === '\r') { }
    else { field += c; }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

async function loadList() {
  if (cache && Date.now() - cache.fetchedAt < TTL_MS) return cache;
  if (inflight) return inflight;

  inflight = (async () => {
    try {
      console.log('[sanctions] downloading OpenSanctions CSV...');
      const res = await fetch(SDN_CSV_URL, {
        signal: AbortSignal.timeout(30_000),
        headers: { Accept: 'text/csv' },
      });
      if (!res.ok) throw new Error('OpenSanctions HTTP ' + res.status);
      const text = await res.text();
      const rows = parseCsv(text);
      if (rows.length < 2) throw new Error('OpenSanctions CSV empty');

      const headers = rows[0];
      const idx = (col) => headers.indexOf(col);
      const i = {
        id: idx('id'), schema: idx('schema'), name: idx('name'),
        aliases: idx('aliases'), countries: idx('countries'),
        programs: idx('program_ids'), sanctions: idx('sanctions'),
        first_seen: idx('first_seen'), last_seen: idx('last_seen'),
      };

      const entries = [];
      const byNormName = new Map();

      for (let r = 1; r < rows.length; r++) {
        const row = rows[r];
        if (!row[i.name]) continue;
        const entry = {
          id: row[i.id] || '',
          schema: row[i.schema] || 'LegalEntity',
          name: row[i.name],
          aliases: (row[i.aliases] || '').split(';').map(s => s.trim()).filter(Boolean),
          countries: (row[i.countries] || '').split(';').map(s => s.trim()).filter(Boolean),
          programs: (row[i.programs] || '').split(';').map(s => s.trim()).filter(Boolean),
          sanctions: row[i.sanctions] || '',
          first_seen: i.first_seen >= 0 ? row[i.first_seen] : undefined,
          last_seen: i.last_seen >= 0 ? row[i.last_seen] : undefined,
        };
        entries.push(entry);

        const keys = new Set([entry.name, ...entry.aliases].map(normName));
        for (const key of keys) {
          if (!key) continue;
          const list = byNormName.get(key);
          if (list) list.push(entry);
          else byNormName.set(key, [entry]);
        }
      }

      console.log('[sanctions] loaded ' + entries.length + ' entries');
      cache = { fetchedAt: Date.now(), entries, byNormName };
      return cache;
    } catch (e) {
      console.warn('[sanctions] refresh failed, serving stale cache:', e.message);
      if (cache) return cache;
      throw e;
    } finally {
      inflight = null;
    }
  })();

  return inflight;
}

async function matchExact(query) {
  if (!query || query.length < 3) return [];
  const list = await loadList();
  return list.byNormName.get(normName(query)) ?? [];
}

async function search(query, opts) {
  opts = opts || {};
  if (!query || query.length < 4) return [];
  const list = await loadList();
  const q = normName(query);
  const limit = opts.limit || 50;

  const exactName = [];
  const exactAlias = [];
  const subName = [];
  const subAlias = [];
  const seen = new Set();

  const push = (bucket, e) => {
    if (seen.has(e.id)) return;
    if (opts.schema && e.schema !== opts.schema) return;
    seen.add(e.id);
    bucket.push(e);
  };

  for (const entry of list.entries) {
    const nameNorm = normName(entry.name);
    if (nameNorm === q) push(exactName, entry);
    else if (entry.aliases.some(a => normName(a) === q)) push(exactAlias, entry);
    else if (nameNorm.includes(q)) push(subName, entry);
    else if (entry.aliases.some(a => normName(a).includes(q))) push(subAlias, entry);
    if (seen.size >= limit * 4) break;
  }

  return [...exactName, ...exactAlias, ...subName, ...subAlias].slice(0, limit);
}

async function indexSize() {
  const list = await loadList();
  return list.entries.length;
}

module.exports = { search, matchExact, indexSize, loadList };
