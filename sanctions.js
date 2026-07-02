const DATASETS = {
  'us_ofac_sdn': { url: 'https://data.opensanctions.org/datasets/latest/us_ofac_sdn/targets.simple.csv', label: 'US OFAC SDN' },
  'eu_fsf': { url: 'https://data.opensanctions.org/datasets/latest/eu_fsf/targets.simple.csv', label: 'EU Consolidated' },
  'un_sc_sanctions': { url: 'https://data.opensanctions.org/datasets/latest/un_sc_sanctions/targets.simple.csv', label: 'UN Security Council' },
  'gb_hmt_sanctions': { url: 'https://data.opensanctions.org/datasets/latest/gb_hmt_sanctions/targets.simple.csv', label: 'UK HMT' },
  'pep_openpep': { url: 'https://data.opensanctions.org/datasets/latest/pep_openpep/targets.simple.csv', label: 'PEP (OpenSanctions)' },
};
const TTL_MS = 6 * 60 * 60 * 1000;

let caches = {};
let inflights = {};

function norm(s) {
  return s.toLowerCase().replace(/[^\p{L}\p{N}\s]+/gu, ' ').replace(/\s+/g, ' ').trim();
}

function editDist(a, b) {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  var prev = new Array(b.length + 1);
  var cur = new Array(b.length + 1);
  for (var i = 0; i <= b.length; i++) prev[i] = i;
  for (var i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (var j = 1; j <= b.length; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] : Math.min(prev[j - 1], Math.min(prev[j], cur[j - 1])) + 1;
    }
    var tmp = prev; prev = cur; cur = tmp;
  }
  return prev[b.length];
}

function score(a, b) {
  if (!a || !b) return 0;
  var an = norm(a), bn = norm(b);
  if (an === bn) return 1;
  if (an.includes(bn) || bn.includes(an)) return 0.9;
  var dist = editDist(an, bn);
  var maxLen = Math.max(an.length, bn.length);
  return maxLen === 0 ? 0 : 1 - dist / maxLen;
}

function normName(s) { return norm(s); }

function parseCsv(text) {
  var rows = [], field = '', row = [], inQuotes = false;
  for (var i = 0; i < text.length; i++) {
    var c = text[i];
    if (inQuotes) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; } }
      else { field += c; }
    } else if (c === '"') { inQuotes = true;
    } else if (c === ',') { row.push(field); field = '';
    } else if (c === '\n') { row.push(field); rows.push(row); row = []; field = '';
    } else if (c === '\r') { }
    else { field += c; }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

async function loadDataset(key) {
  var ds = DATASETS[key];
  if (!ds) throw new Error('Unknown dataset: ' + key);
  var cache = caches[key];
  if (cache && Date.now() - cache.fetchedAt < TTL_MS) return cache;
  if (inflights[key]) return inflights[key];

  inflights[key] = (async () => {
    try {
      console.log('[sanctions] loading ' + key + '...');
      var res = await fetch(ds.url, { signal: AbortSignal.timeout(60_000), headers: { Accept: 'text/csv' } });
      if (!res.ok) throw new Error(key + ' HTTP ' + res.status);
      var text = await res.text();
      var rows = parseCsv(text);
      if (rows.length < 2) throw new Error(key + ' empty');

      var h = rows[0], idx = function (col) { return h.indexOf(col); };
      var i = { id: idx('id'), schema: idx('schema'), name: idx('name'), aliases: idx('aliases'), countries: idx('countries'), programs: idx('program_ids') };

      var entries = [], byNorm = new Map();
      for (var r = 1; r < rows.length; r++) {
        var row = rows[r];
        if (!row[i.name]) continue;
        var entry = {
          id: row[i.id] || '', dataset: key, source: ds.label,
          schema: row[i.schema] || 'LegalEntity', name: row[i.name],
          aliases: (row[i.aliases] || '').split(';').map(function (s) { return s.trim(); }).filter(Boolean),
          countries: (row[i.countries] || '').split(';').map(function (s) { return s.trim(); }).filter(Boolean),
          programs: (row[i.programs] || '').split(';').map(function (s) { return s.trim(); }).filter(Boolean),
        };
        entries.push(entry);
        var keys = new Set([entry.name].concat(entry.aliases).map(normName));
        keys.forEach(function (k) { if (!k) return; var l = byNorm.get(k); if (l) l.push(entry); else byNorm.set(k, [entry]); });
      }

      console.log('[sanctions] ' + key + ': ' + entries.length + ' entries');
      caches[key] = { fetchedAt: Date.now(), entries: entries, byNorm: byNorm };
      return caches[key];
    } catch (e) {
      if (caches[key]) { console.warn('[sanctions] ' + key + ' refresh failed, serving stale'); return caches[key]; }
      throw e;
    } finally { inflights[key] = null; }
  })();

  return inflights[key];
}

async function loadAll() {
  var results = await Promise.allSettled(Object.keys(DATASETS).map(loadDataset));
  var total = 0, lists = [];
  results.forEach(function (r) { if (r.status === 'fulfilled' && r.value) { total += r.value.entries.length; lists.push(r.value); } });
  return { lists: lists, total: total };
}

function searchDataset(dataset, q, schema, limit) {
  if (!q || q.length < 2) return [];
  limit = limit || 25;
  var nq = norm(q);
  var exactName = [], exactAlias = [], highSim = [], lowSim = [], seen = new Set();
  var push = function (bucket, e) { if (seen.has(e.id)) return; if (schema && e.schema !== schema) return; seen.add(e.id); bucket.push(e); };

  dataset.entries.forEach(function (entry) {
    var nn = norm(entry.name);
    if (nn === nq) push(exactName, entry);
    else if (entry.aliases.some(function (a) { return norm(a) === nq; })) push(exactAlias, entry);
    else if (nn.includes(nq) || entry.aliases.some(function (a) { return norm(a).includes(nq); })) push(highSim, entry);
    else {
      var s = score(entry.name, q);
      if (s > 0.75) push(highSim, entry);
      else if (s > 0.6) push(lowSim, entry);
    }
    if (seen.size >= limit * 6) return;
  });

  return (exactName.concat(exactAlias).concat(highSim).concat(lowSim)).slice(0, limit);
}

async function search(q, opts) {
  opts = opts || {};
  var schema = opts.schema || null;
  var limit = opts.limit || 25;
  var datasets = opts.datasets || Object.keys(DATASETS);

  var results = [];
  for (var i = 0; i < datasets.length; i++) {
    try {
      var d = await loadDataset(datasets[i]);
      results = results.concat(searchDataset(d, q, schema, Math.ceil(limit / datasets.length) * 2));
    } catch (e) { /* skip failed dataset */ }
  }

  results.sort(function (a, b) {
    var sa = score(a.name, q), sb = score(b.name, q);
    return sb - sa;
  });
  return results.slice(0, limit);
}

async function searchAll(q, opts) {
  var sanc = await search(q, opts);
  return sanc;
}

async function batchScreen(names, opts) {
  opts = opts || {};
  var results = [];
  for (var i = 0; i < names.length; i++) {
    var name = (typeof names[i] === 'string' ? names[i] : names[i].name || names[i].toString()).trim();
    if (!name) continue;
    var matches = await search(name, { limit: opts.maxResults || 5 });
    results.push({
      query: name,
      risk: matches.length > 0 ? (score(matches[0].name, name) > 0.85 ? 'HIGH' : 'MEDIUM') : 'CLEAR',
      matches: matches.slice(0, opts.maxResults || 5),
    });
  }
  return results;
}

async function indexSize() {
  try { var r = await loadAll(); return r.total; } catch (e) { return 0; }
}

module.exports = { search, searchAll, batchScreen, indexSize, loadAll, loadDataset, DATASETS };
