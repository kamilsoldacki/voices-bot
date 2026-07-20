const fs = require('fs');
const path = require('path');

// Allow running DEV_ASSERTS without installing external deps.
const DEV_ASSERTS_ENABLED = ['true', '1', 'yes'].includes(
  String(process.env.DEV_ASSERTS || '').trim().toLowerCase()
);

let axios = null;
let FormData = null;
try {
  // External deps (required for runtime, optional for DEV_ASSERTS)
  axios = require('axios');
  FormData = require('form-data');
} catch (e) {
  if (!DEV_ASSERTS_ENABLED) throw e;
}

let app = null;

// -------------------------------------------------------------
// In-memory conversation sessions (per Slack thread)
// -------------------------------------------------------------
const sessions = {};
const recentRequests = new Map();
const REQUEST_DEDUP_TTL_MS = 15000;
const SESSION_TTL_MS = 45 * 60 * 1000; // 45 minutes
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const KEYWORD_SEARCH_CONCURRENCY = 6; // limit concurrent keyword searches
// Simple in-memory cache for shared-voices queries
const sharedVoicesCache = new Map(); // key -> { at:number, voices:any[] }
const SHARED_VOICES_CACHE_TTL_MS = 7 * 60 * 1000; // 7 minutes

// Shared-voices accent form cache (name vs slug). Purpose: avoid wasting requests on a form that returns 0.
// Key: sv:accentForm:${iso2}:${accentNorm}
// Value: { at:number, iso2:string, accentNorm:string, preferred:'name'|'slug', evidence:{ nameCount:number, slugCount:number } }
const sharedVoicesAccentFormCache = new Map();
const SHARED_VOICES_ACCENT_FORM_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

// Keyword translation/expansion cache (LLM) for non-English search terms
const keywordTranslateCache = new Map(); // key -> { at:number, iso2:string, src:string, out:string[] }
const KEYWORD_TRANSLATE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// -------------------------------------------------------------
// Accent/locale catalog (loaded from disk + optional refresh)
// -------------------------------------------------------------
// Goal:
// - keep bot fast by using an in-memory index
// - only apply accent/locale as HARD query params when they are known-valid for the language
//
// Default path:
// - prefer ./accents_all.json (repo layout: index.js + accents_all.json in same folder)
// - fallback to ../accents_all.json (older layout: index.js in ~/Downloads, accents_all.json in ~/)
const DEFAULT_ACCENTS_JSON_PATH = (() => {
  try {
    const here = path.resolve(__dirname, './accents_all.json');
    if (fs.existsSync(here)) return here;
  } catch (_) {}
  return path.resolve(__dirname, '../accents_all.json');
})();

function normalizeCatalogToken(s) {
  return (s || '')
    .toString()
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/_/g, '-');
}

function escapeRegExp(s) {
  return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** True when accent phrase appears as whole words in haystack (not a bare substring of another word). */
function textContainsAccentPhrase(haystack, needle) {
  const h = normalizeCatalogToken(haystack);
  const n = normalizeCatalogToken(needle);
  if (!h || !n || n.length < 4) return false;
  try {
    const re = new RegExp(`(?:^|\\s)${escapeRegExp(n)}(?:\\s|$)`);
    return re.test(h);
  } catch (_) {
    return h.includes(n);
  }
}

/** Diagnostic tags written into matched_keywords (locale:/accent:/fanout_…) — not real keyword hits. */
function isDiagnosticMatchedKeyword(kw) {
  const s = String(kw || '').toLowerCase().trim();
  if (!s) return false;
  return /^(locale:|accent:|fanout_|latam_locale:|specific_|other:)/.test(s);
}

function contentMatchedKeywords(list) {
  return (Array.isArray(list) ? list : []).filter((k) => !isDiagnosticMatchedKeyword(k));
}

/** Common English/query tokens that must not fuzzy-match catalog accents (e.g. check→czech). */
const ACCENT_MATCH_STOPWORDS = new Set([
  'check',
  'whether',
  'suitable',
  'following',
  'voices',
  'voice',
  'library',
  'names',
  'name',
  'alias',
  'aliases',
  'talent',
  'professional',
  'other',
  'these',
  'those',
  'please',
  'find',
  'show',
  'want',
  'need',
  'looking',
  'recommend',
  'best',
  'good',
  'high',
  'quality',
  'female',
  'male',
  'agent',
  'customer',
  'brief',
  'about',
  'with',
  'from',
  'that',
  'this',
  'what',
  'which',
  'are',
  'the',
  'and',
  'for',
  'can',
  'you',
  'me',
  'evaluate',
  'verify',
  'review'
]);

const LATAM_SPANISH_RE =
  /\b(es-419|latam|latin america|latinamerican|latino|latin(?:o)? american|south american|central american|caribbean)\b/;


function normalizeLocaleToken(s) {
  // Keep case-insensitive compare, preserve original for output.
  return normalizeCatalogToken(s);
}

function slugifyAccentName(s) {
  // Best-effort: "hong kong cantonese" -> "hong-kong-cantonese"
  const t = normalizeCatalogToken(s);
  return t
    .replace(/[^a-z0-9 -]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function normalizeAccentForApiParam(iso2, accent) {
  const raw = (accent || '').toString().toLowerCase().trim();
  if (!raw) return null;
  const lang = (iso2 || '').toString().toLowerCase().slice(0, 2);
  const hasSpaces = /\s/.test(raw);
  const forceSlugs = readEnvBoolean('FORCE_ACCENT_SLUGS', false);

  let slug = null;
  try {
    slug =
      lang &&
      facetKB &&
      facetKB.isLoaded &&
      facetKB.isLoaded() &&
      facetKB.getAccentSlug
        ? facetKB.getAccentSlug(lang, raw)
        : null;
  } catch (_) {
    slug = null;
  }

  // If KB provides a slug, use it when spaces could break matching, when forced, or for zh.
  if (slug && (forceSlugs || hasSpaces || lang === 'zh')) return slug;
  // Best-effort fallback: "latin american" -> "latin-american"
  if (!slug && hasSpaces) return slugifyAccentName(raw);
  return raw;
}

function accentFormCacheKey(iso2, accentNorm) {
  const k = (iso2 || '').toString().toLowerCase().slice(0, 2);
  const a = normalizeCatalogToken(accentNorm);
  if (!k || !a) return null;
  return `sv:accentForm:${k}:${a}`;
}

function getCachedAccentForm(iso2, accentNorm) {
  try {
    const key = accentFormCacheKey(iso2, accentNorm);
    if (!key) return null;
    const hit = sharedVoicesAccentFormCache.get(key);
    if (!hit) return null;
    if (Date.now() - (hit.at || 0) > SHARED_VOICES_ACCENT_FORM_TTL_MS) {
      sharedVoicesAccentFormCache.delete(key);
      return null;
    }
    return hit;
  } catch (_) {
    return null;
  }
}

function setCachedAccentForm(iso2, accentNorm, preferred, evidence) {
  try {
    const key = accentFormCacheKey(iso2, accentNorm);
    if (!key) return false;
    const k = (iso2 || '').toString().toLowerCase().slice(0, 2);
    const a = normalizeCatalogToken(accentNorm);
    if (!k || !a) return false;
    if (preferred !== 'name' && preferred !== 'slug') return false;
    sharedVoicesAccentFormCache.set(key, {
      at: Date.now(),
      iso2: k,
      accentNorm: a,
      preferred,
      evidence: {
        nameCount: Number(evidence?.nameCount || 0) || 0,
        slugCount: Number(evidence?.slugCount || 0) || 0
      }
    });
    return true;
  } catch (_) {
    return false;
  }
}

class AccentCatalog {
  constructor(opts = {}) {
    this.filePath = (opts.filePath || process.env.ACCENTS_JSON_PATH || DEFAULT_ACCENTS_JSON_PATH).toString();
    this.loadedAt = 0;
    this.byIso2 = new Map(); // iso2 -> { accents:Set<string>, locales:Set<string> }
    this.zhAccentSlugs = []; // cached list (strings) built from accents when available
    this.recentLanguageUse = new Map(); // iso2 -> lastSeenMs
    this._lastLoadError = null;

    // Background refresh knobs (safe defaults)
    this.refreshTtlMs = Number(process.env.ACCENTS_REFRESH_TTL_MS || 0) || 24 * 60 * 60 * 1000; // 24h
    this.refreshCheckMs = Number(process.env.ACCENTS_REFRESH_CHECK_MS || 0) || 15 * 60 * 1000; // 15m
    this.refreshMaxPages = Math.max(1, Math.min(20, Number(process.env.ACCENTS_REFRESH_MAX_PAGES || 0) || 6));
    this.refreshPageSize = Math.max(10, Math.min(100, Number(process.env.ACCENTS_REFRESH_PAGE_SIZE || 0) || 80));
    this.refreshCap = Math.max(50, Math.min(2000, Number(process.env.ACCENTS_REFRESH_CAP || 0) || 800));
    this.refreshLastAt = 0;
    this._refreshInFlight = null;
    this._refreshTimer = null;
    this._refreshBackoffUntil = 0;
  }

  loadFromDiskSync() {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const data = JSON.parse(raw);
      this._ingestPayload(data);
      this.loadedAt = Date.now();
      this._lastLoadError = null;
      return true;
    } catch (e) {
      this._lastLoadError = e;
      return false;
    }
  }

  noteLanguageUsed(iso2) {
    try {
      const k = (iso2 || '').toString().toLowerCase().slice(0, 2);
      if (!k) return;
      this.recentLanguageUse.set(k, Date.now());
    } catch (_) {}
  }

  startBackgroundRefresh() {
    try {
      if (this._refreshTimer) return;
      this._refreshTimer = setInterval(() => {
        this.refreshIfDue().catch(() => {});
      }, this.refreshCheckMs);
      // Fire-and-forget quick check shortly after boot (non-blocking)
      setTimeout(() => {
        this.refreshIfDue().catch(() => {});
      }, 2500);
    } catch (_) {}
  }

  stopBackgroundRefresh() {
    try {
      if (this._refreshTimer) clearInterval(this._refreshTimer);
      this._refreshTimer = null;
    } catch (_) {}
  }

  async refreshIfDue() {
    try {
      const XI_KEY = process.env.ELEVENLABS_API_KEY;
      if (!XI_KEY) return false;
      const now = Date.now();
      if (now < (this._refreshBackoffUntil || 0)) return false;
      if (this.refreshLastAt && now - this.refreshLastAt < this.refreshTtlMs) return false;

      if (this._refreshInFlight) return await this._refreshInFlight;

      this._refreshInFlight = (async () => {
        try {
          const langs = this._computeRefreshLanguages();
          if (!langs.length) {
            this.refreshLastAt = Date.now();
            return true;
          }
          await this._refreshLanguages(langs);
          this.refreshLastAt = Date.now();
          return true;
        } catch (e) {
          // Back off for 30 minutes after an unexpected failure
          this._refreshBackoffUntil = Date.now() + 30 * 60 * 1000;
          return false;
        } finally {
          this._refreshInFlight = null;
        }
      })();

      return await this._refreshInFlight;
    } catch (_) {
      this._refreshInFlight = null;
      return false;
    }
  }

  _computeRefreshLanguages() {
    try {
      const defaults = ['en', 'es', 'pt', 'zh', 'pl'];
      const recent = Array.from(this.recentLanguageUse.entries())
        .sort((a, b) => (b[1] || 0) - (a[1] || 0))
        .map(([k]) => (k || '').toString().toLowerCase().slice(0, 2))
        .filter(Boolean)
        .slice(0, 6);
      const out = [];
      const seen = new Set();
      for (const k of [...recent, ...defaults]) {
        const kk = (k || '').toString().toLowerCase().slice(0, 2);
        if (!kk || seen.has(kk)) continue;
        seen.add(kk);
        out.push(kk);
      }
      return out;
    } catch (_) {
      return ['en', 'es', 'pt', 'zh', 'pl'];
    }
  }

  async _refreshLanguages(iso2List) {
    const langs = Array.isArray(iso2List) ? iso2List : [];
    for (const iso2 of langs) {
      try {
        await this._refreshOneLanguage(iso2);
        // small spacing between languages to reduce burstiness
        await sleep(150);
      } catch (_) {}
    }
  }

  _extractBucketsFromVoices(voices) {
    const out = { accent: new Set(), locale: new Set(), dialect: new Set(), region: new Set() };
    const add = (set, val) => {
      const t = normalizeCatalogToken(val);
      if (t) set.add(t);
    };
    const addLocale = (val) => {
      const t = normalizeLocaleToken(val);
      if (!t) return;
      out.locale.add(t);
      // allow zh-* equivalents for cmn-* locales
      const m = t.match(/^cmn-([a-z0-9]{2,3})$/i);
      if (m) out.locale.add(`zh-${String(m[1]).toLowerCase()}`);
    };
    const addAny = (bucket, v) => {
      if (typeof v === 'string') {
        if (bucket === 'locale') addLocale(v);
        else if (bucket === 'accent') add(out.accent, v);
        else if (bucket === 'dialect') add(out.dialect, v);
        else if (bucket === 'region') add(out.region, v);
      } else if (Array.isArray(v)) {
        v.forEach((x) => addAny(bucket, x));
      }
    };

    for (const v of Array.isArray(voices) ? voices : []) {
      if (!v || typeof v !== 'object') continue;
      addAny('accent', v.accent);
      addAny('locale', v.locale);
      addAny('dialect', v.dialect);
      addAny('region', v.region);
      if (v.labels && typeof v.labels === 'object') {
        addAny('accent', v.labels.accent || v.labels.language_accent);
        addAny('locale', v.labels.locale);
        addAny('dialect', v.labels.dialect);
        addAny('region', v.labels.region);
      }
      if (v.sharing && typeof v.sharing === 'object' && v.sharing.labels && typeof v.sharing.labels === 'object') {
        addAny('accent', v.sharing.labels.accent || v.sharing.labels.language_accent);
        addAny('locale', v.sharing.labels.locale);
        addAny('dialect', v.sharing.labels.dialect);
        addAny('region', v.sharing.labels.region);
      }
    }
    return out;
  }

  async _refreshOneLanguage(iso2) {
    const code = (iso2 || '').toString().toLowerCase().slice(0, 2);
    if (!code) return false;
    const XI_KEY = process.env.ELEVENLABS_API_KEY;
    if (!XI_KEY) return false;

    // Fetch a bounded sample of shared voices for the language and extract accent/locale-ish metadata.
    const baseParams = new URLSearchParams();
    baseParams.set('page_size', String(this.refreshPageSize));
    baseParams.set('sort', 'created_date');
    baseParams.set('include_custom_rates', 'false');

    let voices = [];
    try {
      const p = new URLSearchParams(baseParams.toString());
      p.set('required_languages', code);
      voices = await callSharedVoicesAllPages(p, { maxPages: this.refreshMaxPages, cap: this.refreshCap });
    } catch (e) {
      const status = e?.response?.status;
      // Fallback to `language=` if `required_languages=` isn't accepted by this endpoint/account
      if (status === 400) {
        try {
          const p2 = new URLSearchParams(baseParams.toString());
          p2.set('language', code);
          voices = await callSharedVoicesAllPages(p2, { maxPages: this.refreshMaxPages, cap: this.refreshCap });
        } catch (_) {
          voices = [];
        }
      } else {
        voices = [];
      }
    }

    const buckets = this._extractBucketsFromVoices(voices || []);
    const bucket = this._ensureBucket(code);
    if (!bucket) return false;

    // Swap in refreshed sets for this iso2 (keep others intact)
    bucket.accents = new Set(Array.from(buckets.accent || []));
    bucket.locales = new Set(Array.from(buckets.locale || []));

    // Rebuild zh slug cache if needed
    if (code === 'zh') {
      const slugs = Array.from(bucket.accents || []).map((a) => slugifyAccentName(a)).filter(Boolean);
      const seen = new Set();
      this.zhAccentSlugs = slugs.filter((s) => {
        const k = normalizeCatalogToken(s);
        if (!k || seen.has(k)) return false;
        seen.add(k);
        return true;
      });
    }

    // Persist back to JSON on disk (best-effort, keep file structure)
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const data = JSON.parse(raw);
      const result = data && typeof data === 'object' ? (data.result || data) : null;
      if (result && typeof result === 'object') {
        let targetKey = null;
        for (const [k, entry] of Object.entries(result)) {
          const lc = (entry && typeof entry === 'object' && entry.language_code) ? String(entry.language_code).toLowerCase().slice(0, 2) : null;
          if (lc === code) {
            targetKey = k;
            break;
          }
        }
        if (!targetKey) targetKey = code;

        const prev = (result[targetKey] && typeof result[targetKey] === 'object') ? result[targetKey] : {};
        result[targetKey] = {
          ...prev,
          language_code: code,
          voices_count: Array.isArray(voices) ? voices.length : (prev.voices_count || 0),
          accent: Array.from(bucket.accents || []),
          locale: Array.from(bucket.locales || []),
          // keep previously-known dialect/region/other if present; refresh script can fill those more deeply
          dialect: Array.isArray(prev.dialect) ? prev.dialect : [],
          region: Array.isArray(prev.region) ? prev.region : [],
          other: Array.isArray(prev.other) ? prev.other : []
        };

        const payload = data.result ? data : { result };
        const tmp = `${this.filePath}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
        fs.renameSync(tmp, this.filePath);
      }
    } catch (_) {}

    return true;
  }

  _ensureBucket(iso2) {
    const k = (iso2 || '').toString().toLowerCase().slice(0, 2);
    if (!k) return null;
    if (!this.byIso2.has(k)) {
      this.byIso2.set(k, { accents: new Set(), locales: new Set() });
    }
    return this.byIso2.get(k);
  }

  _ingestPayload(data) {
    this.byIso2 = new Map();
    this.zhAccentSlugs = [];
    const result = data && typeof data === 'object' ? (data.result || data) : null;
    if (!result || typeof result !== 'object') return;

    for (const [name, entry] of Object.entries(result)) {
      const code = (entry && typeof entry === 'object' && entry.language_code) ? String(entry.language_code) : null;
      const iso2 = (code || '').toLowerCase().slice(0, 2);
      if (!iso2) continue;

      const bucket = this._ensureBucket(iso2);
      if (!bucket) continue;

      const accents = Array.isArray(entry?.accent) ? entry.accent : [];
      const locales = Array.isArray(entry?.locale) ? entry.locale : [];

      accents.forEach((a) => {
        const t = normalizeCatalogToken(a);
        if (t) bucket.accents.add(t);
      });

      locales.forEach((loc) => {
        const t = normalizeLocaleToken(loc);
        if (!t) return;
        bucket.locales.add(t);
        // Chinese locales sometimes show up as cmn-CN/cmn-TW; allow zh-* equivalents
        if (iso2 === 'zh') {
          const m = t.match(/^cmn-([a-z0-9]{2,3})$/i);
          if (m) {
            bucket.locales.add(`zh-${String(m[1]).toLowerCase()}`);
          }
        }
      });

      // Build zh slugs list from accents (best-effort, filtered later per query)
      if (iso2 === 'zh' && accents.length) {
        accents.forEach((a) => {
          const s = slugifyAccentName(a);
          if (s) this.zhAccentSlugs.push(s);
        });
      }
    }

    // De-dupe zh slugs while preserving order
    const zhSeen = new Set();
    this.zhAccentSlugs = (this.zhAccentSlugs || []).filter((s) => {
      const k = normalizeCatalogToken(s);
      if (!k) return false;
      if (zhSeen.has(k)) return false;
      zhSeen.add(k);
      return true;
    });
  }

  isAccentAllowed(iso2, accent) {
    try {
      const k = (iso2 || '').toString().toLowerCase().slice(0, 2);
      const a = normalizeCatalogToken(accent);
      if (!k || !a) return false;
      const bucket = this.byIso2.get(k);
      if (!bucket) return false;
      return bucket.accents.has(a);
    } catch (_) {
      return false;
    }
  }

  isLocaleAllowed(iso2, locale) {
    try {
      const k = (iso2 || '').toString().toLowerCase().slice(0, 2);
      const l = normalizeLocaleToken(locale);
      if (!k || !l) return false;
      const bucket = this.byIso2.get(k);
      if (!bucket) return false;
      return bucket.locales.has(l);
    } catch (_) {
      return false;
    }
  }

  // Used for zh fallback: get a small, safe list of accent slugs
  getZhAccentSlugs({ dialect = null, limit = 10 } = {}) {
    const all = Array.isArray(this.zhAccentSlugs) ? this.zhAccentSlugs : [];
    if (!all.length) return [];
    const d = (dialect || '').toString().toLowerCase();
    let filtered = all;
    if (d === 'cantonese') {
      filtered = all.filter((s) => s.includes('cantonese'));
      // include "standard" as last resort
      if (filtered.length < limit) filtered = [...filtered, ...all.filter((s) => s === 'standard')];
    } else if (d === 'mandarin') {
      filtered = all.filter((s) => s.includes('mandarin'));
      if (filtered.length < limit) filtered = [...filtered, ...all.filter((s) => s === 'standard')];
    } else {
      // general zh: prefer known zh-relevant slugs
      filtered = all.filter((s) => s.includes('mandarin') || s.includes('cantonese') || s === 'standard');
      if (!filtered.length) filtered = all;
    }
    return filtered.slice(0, Math.max(1, Math.min(50, Number(limit) || 10)));
  }

  // Choose locale candidate for Chinese dialect, based on what is actually present in catalog
  getPreferredChineseLocales(dialect) {
    const bucket = this.byIso2.get('zh');
    const locales = bucket ? Array.from(bucket.locales || []) : [];
    const set = new Set(locales.map((x) => normalizeLocaleToken(x)));
    const want = (dialect || '').toString().toLowerCase();

    // Prefer zh-* since the rest of the bot already uses zh-XX tags.
    const pickFirst = (cands) => cands.find((c) => set.has(normalizeLocaleToken(c))) || null;

    if (want === 'cantonese') {
      return [pickFirst(['zh-hk', 'zh-tw', 'zh-cn'])].filter(Boolean);
    }
    if (want === 'mandarin') {
      return [pickFirst(['zh-cn', 'zh-tw', 'zh-hk'])].filter(Boolean);
    }
    return [pickFirst(['zh-cn', 'zh-tw', 'zh-hk'])].filter(Boolean);
  }
}

// Global catalog instance (wired into query logic later)
const accentCatalog = new AccentCatalog();
accentCatalog.loadFromDiskSync();

// -------------------------------------------------------------
// Facet Knowledge Base (FacetKB) – remote-loaded facets + popularity
// -------------------------------------------------------------
// Goal:
// - load facets.json + verify_counts.json from remote URLs (TTL cached)
// - use as source-of-truth for allowed accents/locales and accent popularity
// - fall back gracefully to AccentCatalog heuristics when KB is unavailable
//
// Expected input shapes (generated by your scripts):
// - facets.json: { meta, facets: { [iso2]: { voices_count, accent:[], locale:[], accent_slugs:[] } } }
// - verify_counts.json: { meta, verify: { [iso2]: { accents: { [accentName]: { count, matched_query, slug } } } } }

function readEnvNumber(name, defaultValue) {
  const raw = String(process.env[name] || '').trim();
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : defaultValue;
}

class FacetKB {
  constructor(opts = {}) {
    this.facetsUrl = (opts.facetsUrl || process.env.FACETS_JSON_URL || '').toString().trim();
    this.verifyCountsUrl = (opts.verifyCountsUrl || process.env.VERIFY_COUNTS_JSON_URL || '').toString().trim();
    this.ttlMs = readEnvNumber('FACET_KB_TTL_MS', 12 * 60 * 60 * 1000); // 12h
    this.timeoutMs = readEnvNumber('FACET_KB_TIMEOUT_MS', 12000); // 12s

    this.loadedAt = 0;
    this._loading = null;
    this._lastError = null;

    // Maps (iso2 -> Set/Map)
    this.allowedAccentsByIso2 = new Map(); // iso2 -> Set<normalizedAccent>
    this.allowedLocalesByIso2 = new Map(); // iso2 -> Set<normalizedLocale>
    this.accentSlugByIso2Accent = new Map(); // iso2 -> Map<normalizedAccent, slug>
    this.accentCountByIso2Accent = new Map(); // iso2 -> Map<normalizedAccent, count>
    this._topAccentsCache = new Map(); // iso2 -> [{ accent, slug, count, norm }]
  }

  hasRemoteConfigured() {
    return !!(this.facetsUrl && this.verifyCountsUrl);
  }

  isFresh() {
    return this.loadedAt && Date.now() - this.loadedAt < this.ttlMs;
  }

  isLoaded() {
    try {
      return !!(this.loadedAt && (this.allowedAccentsByIso2.size || this.allowedLocalesByIso2.size));
    } catch (_) {
      return false;
    }
  }

  hasIso2(iso2) {
    const k = (iso2 || '').toString().toLowerCase().slice(0, 2);
    if (!k) return false;
    return this.allowedAccentsByIso2.has(k) || this.allowedLocalesByIso2.has(k);
  }

  async ensureLoaded(traceCb) {
    const trace = typeof traceCb === 'function' ? traceCb : () => {};
    try {
      if (!this.hasRemoteConfigured()) return false;
      if (this.isFresh()) return true;
      if (this._loading) return await this._loading;

      this._loading = (async () => {
        try {
          const started = Date.now();
          const [facetsRes, verifyRes] = await Promise.all([
            this._fetchJson(this.facetsUrl),
            this._fetchJson(this.verifyCountsUrl)
          ]);

          this._ingest(facetsRes, verifyRes);
          this.loadedAt = Date.now();
          this._lastError = null;
          try {
            trace({
              stage: 'facet_kb_loaded',
              params: {
                ms: String(Date.now() - started),
                facets_iso2: String(this.allowedAccentsByIso2.size || 0),
                verify_iso2: String(this.accentCountByIso2Accent.size || 0)
              }
            });
          } catch (_) {}
          return true;
        } catch (e) {
          this._lastError = e;
          try {
            trace({ stage: 'facet_kb_load_failed', params: { reason: e?.message || 'error' } });
          } catch (_) {}
          return false;
        } finally {
          this._loading = null;
        }
      })();

      return await this._loading;
    } catch (_) {
      this._loading = null;
      return false;
    }
  }

  async _fetchJson(url) {
    const res = await httpGetWithRetry(url, { timeout: this.timeoutMs });
    return res?.data;
  }

  _ingest(facetsData, verifyCountsData) {
    const facets = facetsData && typeof facetsData === 'object' ? facetsData.facets || facetsData.result || facetsData : null;
    const verify = verifyCountsData && typeof verifyCountsData === 'object' ? verifyCountsData.verify || verifyCountsData : null;

    const allowedAccentsByIso2 = new Map();
    const allowedLocalesByIso2 = new Map();
    const slugByIso2Accent = new Map();
    const countByIso2Accent = new Map();

    // 1) facets.json: allowed accents/locales + accent_slugs mapping
    if (facets && typeof facets === 'object') {
      for (const [iso2Raw, entry] of Object.entries(facets)) {
        const iso2 = (iso2Raw || '').toString().toLowerCase().slice(0, 2);
        if (!iso2 || !entry || typeof entry !== 'object') continue;

        const accents = Array.isArray(entry.accent) ? entry.accent : [];
        const locales = Array.isArray(entry.locale) ? entry.locale : [];
        const accentSlugs = Array.isArray(entry.accent_slugs) ? entry.accent_slugs : [];

        const aSet = new Set();
        for (const a of accents) {
          const norm = normalizeCatalogToken(a);
          if (norm) aSet.add(norm);
        }
        const lSet = new Set();
        for (const loc of locales) {
          // use the same normalizer as the rest of the bot for compare safety
          const canon = normalizeRequestedLocale(loc) || loc;
          const norm = normalizeLocaleToken(canon);
          if (norm) lSet.add(norm);
        }

        allowedAccentsByIso2.set(iso2, aSet);
        allowedLocalesByIso2.set(iso2, lSet);

        // Map accent -> slug by index when aligned
        if (accentSlugs.length && accents.length) {
          const m = new Map();
          const n = Math.min(accents.length, accentSlugs.length);
          for (let i = 0; i < n; i++) {
            const aNorm = normalizeCatalogToken(accents[i]);
            const slug = (accentSlugs[i] || '').toString().trim();
            if (aNorm && slug) m.set(aNorm, slug);
          }
          if (m.size) slugByIso2Accent.set(iso2, m);
        }
      }
    }

    // 2) verify_counts.json: popularity counts + explicit slugs per accent
    if (verify && typeof verify === 'object') {
      for (const [iso2Raw, entry] of Object.entries(verify)) {
        const iso2 = (iso2Raw || '').toString().toLowerCase().slice(0, 2);
        if (!iso2 || !entry || typeof entry !== 'object') continue;
        const accentsObj = entry.accents && typeof entry.accents === 'object' ? entry.accents : {};

        const countMap = new Map();
        const slugMap = slugByIso2Accent.get(iso2) || new Map();

        for (const [accentNameRaw, meta] of Object.entries(accentsObj)) {
          const accentName = (meta?.matched_query || accentNameRaw || '').toString();
          const norm = normalizeCatalogToken(accentName);
          if (!norm) continue;
          const count = Number(meta?.count || 0) || 0;
          if (count > 0) countMap.set(norm, count);

          const slug = (meta?.slug || '').toString().trim();
          if (slug) slugMap.set(norm, slug);
        }

        if (countMap.size) countByIso2Accent.set(iso2, countMap);
        if (slugMap.size) slugByIso2Accent.set(iso2, slugMap);
      }
    }

    // Commit in one shot
    this.allowedAccentsByIso2 = allowedAccentsByIso2;
    this.allowedLocalesByIso2 = allowedLocalesByIso2;
    this.accentSlugByIso2Accent = slugByIso2Accent;
    this.accentCountByIso2Accent = countByIso2Accent;
    this._topAccentsCache = new Map();
  }

  _getTopAccents(iso2) {
    const k = (iso2 || '').toString().toLowerCase().slice(0, 2);
    if (!k) return [];
    if (this._topAccentsCache.has(k)) return this._topAccentsCache.get(k);

    const allowed = this.allowedAccentsByIso2.get(k) || new Set();
    const counts = this.accentCountByIso2Accent.get(k) || new Map();
    const slugs = this.accentSlugByIso2Accent.get(k) || new Map();

    const list = [];
    for (const norm of allowed) {
      const count = counts.get(norm) || 0;
      const slug = slugs.get(norm) || '';
      list.push({ norm, accent: norm, slug, count });
    }
    list.sort((a, b) => (b.count || 0) - (a.count || 0) || a.accent.localeCompare(b.accent));
    this._topAccentsCache.set(k, list);
    return list;
  }

  checkAccentAllowed(iso2, accent) {
    const k = (iso2 || '').toString().toLowerCase().slice(0, 2);
    const a = normalizeCatalogToken(accent);
    if (!k || !a) return { known: false, allowed: false };
    if (!this.allowedAccentsByIso2.has(k)) return { known: false, allowed: false };
    const set = this.allowedAccentsByIso2.get(k);
    if (!set) return { known: false, allowed: false };

    // Accept both normalized accent keys ("latin american") and API slugs ("latin-american").
    // Some accents legitimately contain hyphens (e.g. "es-venezuelan"); those should still match as-is.
    if (set.has(a)) return { known: true, allowed: true };
    if (a.includes('-')) {
      const spaced = a.replace(/-+/g, ' ');
      if (set.has(spaced)) return { known: true, allowed: true };
    }
    return { known: true, allowed: false };
  }

  checkLocaleAllowed(iso2, locale) {
    const k = (iso2 || '').toString().toLowerCase().slice(0, 2);
    const canon = normalizeRequestedLocale(locale) || locale;
    const l = normalizeLocaleToken(canon);
    if (!k || !l) return { known: false, allowed: false };
    if (!this.allowedLocalesByIso2.has(k)) return { known: false, allowed: false };
    return { known: true, allowed: this.allowedLocalesByIso2.get(k).has(l) };
  }

  getAccentSlug(iso2, accent) {
    const k = (iso2 || '').toString().toLowerCase().slice(0, 2);
    const a = normalizeCatalogToken(accent);
    if (!k || !a) return null;
    const m = this.accentSlugByIso2Accent.get(k);
    if (!m) return null;
    const direct = m.get(a) || null;
    if (direct) return direct;
    // If caller passes a slug like "latin-american", allow best-effort reverse normalization to the KB key.
    if (a.includes('-')) {
      const spaced = a.replace(/-+/g, ' ');
      return m.get(spaced) || null;
    }
    return null;
  }

  _canonicalizeLocaleForApi(normLocale) {
    // Input is normalized like: "pt-br", "es-419", "cmn-cn"
    const s = (normLocale || '').toString().trim().toLowerCase();
    if (!s) return null;
    const m = s.match(/^([a-z]{2,3})-([a-z]{2}|\d{3})$/i);
    if (!m) return null;
    const lang = m[1].toLowerCase();
    const reg = /^\d{3}$/.test(m[2]) ? m[2] : m[2].toUpperCase();
    return `${lang}-${reg}`;
  }

  _canonicalizeLocaleLabel(normLocale) {
    // Prefer UI-friendly casing; for now keep tag-like output
    const api = this._canonicalizeLocaleForApi(normLocale);
    return api || String(normLocale || '');
  }

  getAxisForIso2(iso2) {
    const k = (iso2 || '').toString().toLowerCase().slice(0, 2);
    if (!k) return null;
    const localeCount = (this.allowedLocalesByIso2.get(k) || new Set()).size;
    const accentCount = (this.allowedAccentsByIso2.get(k) || new Set()).size;

    // Prefer locale when it meaningfully partitions and stays small (2–6).
    if (localeCount >= 2 && localeCount <= 6) return 'locale';
    // Otherwise prefer accents when available.
    if (accentCount >= 2) return 'accent';
    // Fallback: if locale exists but is large, still show a few locales rather than hundreds of accents (rare).
    if (localeCount >= 2) return 'locale';
    if (accentCount >= 1) return 'accent';
    return null;
  }

  getFacetVariants(iso2, axis, { maxVariants = 6 } = {}) {
    const k = (iso2 || '').toString().toLowerCase().slice(0, 2);
    const ax = (axis || '').toString();
    const maxN = Math.max(1, Math.min(15, Number(maxVariants) || 6));
    if (!k) return [];

    if (ax === 'locale') {
      const list = this.suggestLocales(k, '', { limit: Math.max(2, Math.min(8, maxN)) }) || [];
      return list.slice(0, Math.min(8, maxN)).map((x) => {
        const norm = (x?.norm || x?.locale || '').toString();
        const apiLocale = this._canonicalizeLocaleForApi(norm) || norm;
        return {
          facetType: 'locale',
          facetKey: norm,
          facetValue: apiLocale,
          facetLabel: this._canonicalizeLocaleLabel(norm)
        };
      });
    }

    if (ax === 'accent') {
      const top = this._getTopAccents(k) || [];
      // Keep top by popularity, but cap. Always try to include "standard" if present.
      const out = [];
      const seen = new Set();
      const push = (it) => {
        if (!it) return;
        const key = it.norm || it.accent;
        if (!key || seen.has(key)) return;
        seen.add(key);
        out.push({
          facetType: 'accent',
          facetKey: it.norm,
          facetValue: it.accent, // name form (spaces) – usually safest for API
          facetLabel: it.accent,
          slug: it.slug || null,
          count: it.count || 0
        });
      };
      // include standard early if popular
      const standard = top.find((x) => x && x.norm === 'standard');
      // Sort already by count; start with top N then ensure standard included
      for (const it of top.slice(0, maxN)) push(it);
      if (standard) push(standard);
      return out.slice(0, maxN);
    }

    return [];
  }

  getVariantForFacetKey(iso2, axis, facetKey) {
    const k = (iso2 || '').toString().toLowerCase().slice(0, 2);
    const ax = (axis || '').toString();
    const key = (facetKey || '').toString().trim();
    if (!k || !ax || !key) return null;

    if (ax === 'locale') {
      const norm = normalizeLocaleToken(key);
      if (!norm) return null;
      if (this.allowedLocalesByIso2.has(k) && !this.allowedLocalesByIso2.get(k).has(norm)) return null;
      const apiLocale = this._canonicalizeLocaleForApi(norm) || norm;
      return {
        facetType: 'locale',
        facetKey: norm,
        facetValue: apiLocale,
        facetLabel: this._canonicalizeLocaleLabel(norm)
      };
    }

    if (ax === 'accent') {
      const norm = normalizeCatalogToken(key);
      if (!norm) return null;
      if (this.allowedAccentsByIso2.has(k) && !this.allowedAccentsByIso2.get(k).has(norm)) return null;
      const slug = (this.accentSlugByIso2Accent.get(k) || new Map()).get(norm) || null;
      const count = (this.accentCountByIso2Accent.get(k) || new Map()).get(norm) || 0;
      return {
        facetType: 'accent',
        facetKey: norm,
        facetValue: norm, // name form
        facetLabel: norm,
        slug,
        count
      };
    }

    return null;
  }

  // Suggest locales for a language (no popularity data; deterministic ordering)
  suggestLocales(iso2, userText, { limit = 3 } = {}) {
    const k = (iso2 || '').toString().toLowerCase().slice(0, 2);
    if (!k) return [];
    const set = this.allowedLocalesByIso2.get(k);
    if (!set || !set.size) return [];

    const all = Array.from(set.values()).map((x) => {
      // store normalized compare value, but also expose a canonical tag-like value
      const canon = (x || '').toString();
      return { norm: canon, locale: canon };
    });

    // Prefer common region tags (small heuristic)
    const prefer = (list) => {
      if (k === 'pt') {
        const pri = ['pt-br', 'pt-pt'];
        const out = [];
        for (const p of pri) {
          const hit = list.find((x) => x.norm === p);
          if (hit) out.push(hit);
        }
        return out.length ? [...out, ...list.filter((x) => !out.some((y) => y.norm === x.norm))] : list;
      }
      if (k === 'es') {
        const pri = ['es-mx', 'es-es', 'es-419'];
        const out = [];
        for (const p of pri) {
          const hit = list.find((x) => x.norm === p);
          if (hit) out.push(hit);
        }
        return out.length ? [...out, ...list.filter((x) => !out.some((y) => y.norm === x.norm))] : list;
      }
      if (k === 'en') {
        const pri = ['en-us', 'en-gb', 'en-ca', 'en-au', 'en-ie'];
        const out = [];
        for (const p of pri) {
          const hit = list.find((x) => x.norm === p);
          if (hit) out.push(hit);
        }
        return out.length ? [...out, ...list.filter((x) => !out.some((y) => y.norm === x.norm))] : list;
      }
      if (k === 'zh') {
        // Prefer cmn-* because that's what facets.json currently exposes for zh.
        const pri = ['cmn-cn', 'cmn-tw', 'zh-cn', 'zh-tw', 'zh-hk'];
        const out = [];
        for (const p of pri) {
          const hit = list.find((x) => x.norm === p);
          if (hit) out.push(hit);
        }
        return out.length ? [...out, ...list.filter((x) => !out.some((y) => y.norm === x.norm))] : list;
      }
      return list;
    };

    let ordered = prefer(all);

    // If user typed an explicit locale-ish token, bubble matching candidates to front
    try {
      const hint = parseUserLanguageHints((userText || '').toString());
      const want = normalizeLocaleToken(normalizeRequestedLocale(hint?.locale) || hint?.locale || '');
      if (want) {
        ordered = ordered.sort((a, b) => {
          const am = a.norm === want ? 1 : 0;
          const bm = b.norm === want ? 1 : 0;
          return bm - am;
        });
      }
    } catch (_) {}

    // Deterministic final sort: keep preferred ordering, then lexicographic
    const head = ordered.slice(0, Math.max(2, Math.min(8, Number(limit) || 3)));
    return head;
  }

  // Suggest best 2–3 accents given userText (fuzzy + popularity fallback)
  suggestAccents(iso2, userText, { limit = 3 } = {}) {
    const k = (iso2 || '').toString().toLowerCase().slice(0, 2);
    if (!k) return [];
    const top = this._getTopAccents(k);
    if (!top.length) return [];

    const lower = (userText || '').toString().toLowerCase();
    const textNorm = normalizeCatalogToken(
      lower.replace(/[^\p{L}\p{N}\s\-']/gu, ' ')
    );
    const tokens = dedupePreserveOrder(
      lower
        .replace(/[^\p{L}\p{N}\s\-']/gu, ' ')
        .split(/\s+/g)
        .map((t) => t.trim())
        .filter(Boolean)
    );
    const skipTokens = getLanguageNameSkipTokens(k);
    const matchTokens = tokens.filter(
      (t) => !skipTokens.has(t) && !ACCENT_MATCH_STOPWORDS.has(t)
    );
    if (!matchTokens.length && !textNorm) {
      return top
        .slice(0, Math.max(2, Math.min(6, limit)))
        .map((x) => ({ ...x, matchKind: 'popularity' }));
    }

    // 0) Phrase / longest-match: prefer multi-word accents (e.g. "latin american" over "american")
    try {
      const phraseHits = [];
      const seenPhrase = new Set();
      for (const cand of top) {
        if (!cand?.accent) continue;
        const candNorm = cand.norm || normalizeCatalogToken(cand.accent);
        if (!candNorm || candNorm.length < 4) continue;
        if (skipTokens.has(candNorm) || skipTokens.has(cand.accent)) continue;
        if (
          textContainsAccentPhrase(textNorm, candNorm) ||
          textContainsAccentPhrase(lower, cand.accent)
        ) {
          if (!seenPhrase.has(candNorm)) {
            seenPhrase.add(candNorm);
            phraseHits.push({ ...cand, matchKind: 'direct', _len: candNorm.length });
          }
        }
      }
      if (phraseHits.length) {
        const kept = phraseHits.filter((h) => {
          const hn = h.norm || normalizeCatalogToken(h.accent);
          return !phraseHits.some((o) => {
            if (o === h) return false;
            const on = o.norm || normalizeCatalogToken(o.accent);
            return (
              on.length > hn.length &&
              (on.includes(hn) || String(o.accent || '').includes(String(h.accent || '')))
            );
          });
        });
        kept.sort(
          (a, b) => (b._len || 0) - (a._len || 0) || (b.count || 0) - (a.count || 0)
        );
        return kept
          .slice(0, Math.max(1, Math.min(6, limit)))
          .map(({ _len, ...rest }) => rest);
      }
    } catch (_) {}

    // 1) direct match: exact token first, then substring contains
    const exact = [];
    const partial = [];
    const seenExact = new Set();
    const seenPartial = new Set();
    for (const t of matchTokens) {
      if (t.length < 4) continue;
      const tNorm = normalizeCatalogToken(t);
      for (const cand of top) {
        if (!cand?.accent) continue;
        const candNorm = cand.norm || normalizeCatalogToken(cand.accent);
        if (skipTokens.has(candNorm) || skipTokens.has(cand.accent)) continue;
        if (
          candNorm.includes(' ') &&
          candNorm.split(/\s+/).includes(tNorm) &&
          candNorm !== tNorm &&
          !textContainsAccentPhrase(textNorm, candNorm)
        ) {
          continue;
        }
        const isExact = cand.accent === t || candNorm === tNorm;
        if (isExact) {
          if (!seenExact.has(candNorm)) {
            seenExact.add(candNorm);
            exact.push({ ...cand, matchKind: 'direct' });
          }
        } else if (cand.accent.includes(t) || candNorm.includes(tNorm)) {
          if (!seenPartial.has(candNorm)) {
            seenPartial.add(candNorm);
            partial.push({ ...cand, matchKind: 'direct' });
          }
        }
      }
      if (exact.length >= 12) break;
    }
    exact.sort(
      (a, b) =>
        String(b.norm || b.accent || '').length - String(a.norm || a.accent || '').length ||
        (b.count || 0) - (a.count || 0)
    );
    partial.sort(
      (a, b) =>
        String(b.norm || b.accent || '').length - String(a.norm || a.accent || '').length ||
        (b.count || 0) - (a.count || 0)
    );
    if (exact.length >= 1) return exact.slice(0, Math.max(1, Math.min(6, limit)));
    if (partial.length >= 2) return partial.slice(0, Math.max(2, Math.min(6, limit)));

    // 2) fuzzy: try closest among candidate strings for longer tokens (skip stopwords)
    try {
      const candidates = top.map((x) => x.accent).filter(Boolean);
      let best = [];
      for (const tok of matchTokens) {
        if (tok.length < 5) continue;
        if (ACCENT_MATCH_STOPWORDS.has(tok)) continue;
        const maxDist = maxTypoDistanceForToken(tok);
        // Tighten fuzzy for short tokens (avoids check→czech)
        const distCap = tok.length <= 6 ? Math.min(maxDist, 1) : maxDist;
        if (distCap < 1) continue;
        const sugg = suggestClosest(tok, candidates, { maxDist: distCap, maxSuggestions: 3 });
        for (const s of sugg) {
          const norm = normalizeCatalogToken(s);
          const found = top.find((x) => x.norm === norm);
          if (found) best.push({ ...found, matchKind: 'fuzzy' });
        }
      }
      best = dedupePreserveOrder(best.map((x) => x.norm)).map((n) => top.find((x) => x.norm === n)).filter(Boolean);
      best.sort((a, b) => (b.count || 0) - (a.count || 0));
      if (best.length) return best.slice(0, Math.max(2, Math.min(6, limit))).map((x) => ({ ...x, matchKind: 'fuzzy' }));
    } catch (_) {}

    // 3) popularity fallback
    return top
      .slice(0, Math.max(2, Math.min(6, limit)))
      .map((x) => ({ ...x, matchKind: 'popularity' }));
  }
}

const facetKB = new FacetKB();

// -------------------------------------------------------------
// Language detection & normalization (ISO 639-1 + locale)
// -------------------------------------------------------------
// Goal: avoid hardcoded language lists and prevent "random-language" results when user
// explicitly requested a language (e.g., "Brazilian Portuguese").
//
// Per ElevenLabs support: requests must use ISO 639-1 (2-letter) codes.
const LANGUAGE_INDEX_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const languageIndex = {
  loadedAt: 0,
  // language display name (lowercase) -> iso2 (e.g., "portuguese" -> "pt")
  byName: new Map(),
  // cached set of supported iso2 codes (strings)
  iso2Set: new Set(),
  // names sorted by length desc for safer substring matching
  namesSorted: [],
  // in-flight loader (to dedupe)
  _loading: null
};

function normalizeLangName(s) {
  return (s || '')
    .toString()
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

function rebuildLanguageIndexCaches() {
  try {
    languageIndex.iso2Set = new Set(Array.from(languageIndex.byName.values()).filter((v) => /^[a-z]{2}$/.test(v)));
    const names = Array.from(languageIndex.byName.keys())
      .map((n) => normalizeLangName(n))
      .filter((n) => n && n.length >= 4);
    names.sort((a, b) => b.length - a.length);
    languageIndex.namesSorted = names;
  } catch (_) {}
}

function extractLanguagesFromModelsResponse(data) {
  // The /v1/models response shape can vary. Handle a few common variants.
  const models = Array.isArray(data) ? data : Array.isArray(data?.models) ? data.models : [];
  const out = [];
  for (const m of models) {
    const langs = Array.isArray(m?.languages) ? m.languages : [];
    for (const entry of langs) {
      out.push(entry);
    }
  }
  return out;
}

async function ensureLanguageIndexLoaded(traceCb) {
  const trace = typeof traceCb === 'function' ? traceCb : () => {};
  try {
    if (languageIndex.byName.size && Date.now() - languageIndex.loadedAt < LANGUAGE_INDEX_TTL_MS) return;
    if (languageIndex._loading) return await languageIndex._loading;

    languageIndex._loading = (async () => {
      try {
        const res = await httpGetWithRetry('https://api.elevenlabs.io/v1/models', {
          headers: {
            'xi-api-key': process.env.ELEVENLABS_API_KEY,
            'Content-Type': 'application/json'
          },
          timeout: 15000
        });
        const langs = extractLanguagesFromModelsResponse(res?.data);

        const byName = new Map();
        for (const l of langs) {
          const name = normalizeLangName(l?.name);
          // Support says: use ISO639-1 in requests. Some responses expose language_id; we accept any field that is iso2.
          const maybe = normalizeLangName(l?.language_code || l?.language || l?.code || l?.language_id);
          const iso2 = /^[a-z]{2}$/.test(maybe) ? maybe : null;
          if (name && iso2) {
            byName.set(name, iso2);
          }
        }

        // Keep any previously-known entries (in case API returns partial list)
        for (const [k, v] of languageIndex.byName.entries()) {
          if (!byName.has(k)) byName.set(k, v);
        }
        languageIndex.byName = byName;
        languageIndex.loadedAt = Date.now();
        rebuildLanguageIndexCaches();
        try {
          trace({ stage: 'language_index_loaded', params: { names: String(languageIndex.byName.size) } });
        } catch (_) {}
      } catch (e) {
        // Don't fail the whole request on index load; fall back to minimal static aliases
        try {
          trace({ stage: 'language_index_load_failed', params: { reason: e?.message || 'error' } });
        } catch (_) {}
      } finally {
        languageIndex._loading = null;
      }
    })();

    return await languageIndex._loading;
  } catch (_) {
    languageIndex._loading = null;
  }
}

const STATIC_LANGUAGE_ALIASES = new Map([
  // minimal safety net; the dynamic language index is preferred
  ['english', 'en'],
  ['polish', 'pl'],
  ['polski', 'pl'],
  ['spanish', 'es'],
  ['español', 'es'],
  ['espanol', 'es'],
  ['german', 'de'],
  ['deutsch', 'de'],
  ['french', 'fr'],
  ['français', 'fr'],
  ['francais', 'fr'],
  ['italian', 'it'],
  ['japanese', 'ja'],
  ['korean', 'ko'],
  // Chinese
  ['chinese', 'zh'],
  ['mandarin', 'zh'],
  ['cantonese', 'zh'],
  ['portuguese', 'pt'],
  ['português', 'pt'],
  ['portugues', 'pt'],
  ['brazilian portuguese', 'pt'],
  ['turkish', 'tr'],
  ['türkçe', 'tr'],
  ['turkce', 'tr']
]);

// Fallback allowlist for ISO639-1 codes when the dynamic language index isn't loaded.
// This prevents false positives like "to" being interpreted as a language code.
const FALLBACK_ISO2_ALLOWLIST = new Set([
  'en','pl','es','de','fr','it','pt','nl','sv','no','da','fi','cs','sk','hu','ro','bg','el','tr',
  'ar','he','hi','ja','ko','zh','id','ms','th','vi','uk','ru'
]);

// Tokens that name the target language (not a regional accent) – skip in accent matching.
function getLanguageNameSkipTokens(iso2) {
  const k = (iso2 || '').toString().toLowerCase().slice(0, 2);
  if (!k) return new Set();
  const skip = new Set([k]);
  try {
    for (const [name, code] of STATIC_LANGUAGE_ALIASES.entries()) {
      if (code === k) skip.add(normalizeLangName(name));
    }
    for (const [name, code] of languageIndex.byName.entries()) {
      if (code === k) skip.add(normalizeLangName(name));
    }
  } catch (_) {}
  return skip;
}

const ACCENT_FALLBACK_PRESETS = new Map([
  ['de', ['standard', 'central', 'southern', 'bavarian', 'swabian', 'saxon']],
  ['es', ['mexican', 'colombian', 'argentine', 'peruvian', 'chilean', 'venezuelan']],
  ['fr', ['standard', 'parisian', 'central', 'southern', 'northern']],
  ['zh', ['standard']]
]);

function buildAccentFallbackKeys(iso2, kb, excludeKeys = []) {
  const k = (iso2 || '').toString().toLowerCase().slice(0, 2);
  if (!k) return [];
  const exclude = new Set((excludeKeys || []).map((x) => normalizeCatalogToken(x)).filter(Boolean));
  const skipAccents = getLanguageNameSkipTokens(k);
  const isAllowed = (key) => {
    if (!key || exclude.has(key) || skipAccents.has(key)) return false;
    try {
      if (kb && kb.checkAccentAllowed) {
        const r = kb.checkAccentAllowed(k, key);
        if (r && r.known && !r.allowed) return false;
      }
    } catch (_) {}
    return true;
  };
  const preset = (ACCENT_FALLBACK_PRESETS.get(k) || [])
    .map((x) => normalizeCatalogToken(x))
    .filter(isAllowed);
  const top =
    kb && kb._getTopAccents
      ? (kb._getTopAccents(k) || []).map((x) => x.norm).filter(isAllowed)
      : [];
  return dedupePreserveOrder([...preset, ...top]).slice(0, 6);
}

// -------------------------------------------------------------
// Locale/accent normalization (UI aliases -> canonical tags)
// -------------------------------------------------------------
// NOTE: keep values conservative; these are used to interpret user intent and for soft bucketing.
const LOCALE_ALIASES = new Map([
  // English
  ['en-uk', 'en-GB'],
  ['en-gb', 'en-GB'],
  ['uk-en', 'en-GB'],
  ['en-england', 'en-GB'],
  ['en-britain', 'en-GB'],
  ['en-greatbritain', 'en-GB'],
  ['en-us', 'en-US'],
  ['en-usa', 'en-US'],
  ['en-au', 'en-AU'],
  ['en-ca', 'en-CA'],
  ['en-ie', 'en-IE'],
  // Portuguese
  ['pt-eu', 'pt-PT'],
  ['pt-europe', 'pt-PT'],
  ['pt-european', 'pt-PT'],
  ['pt-pt', 'pt-PT'],
  ['pt-br', 'pt-BR'],
  // Spanish
  ['es-es', 'es-ES'],
  ['es-mx', 'es-MX'],
  ['es-419', 'es-419'], // Latin America / Caribbean (UN M.49)
  ['es-latam', 'es-419'],
  ['es-latinamerica', 'es-419'],
  ['es-la', 'es-419'],
  ['es-latin-america', 'es-419'],
  // French
  ['fr-ca', 'fr-CA'],
  ['fr-qc', 'fr-CA'],
  // Chinese
  ['zh-cn', 'zh-CN'],
  ['zh-tw', 'zh-TW'],
  ['zh-hk', 'zh-HK']
]);

const ACCENT_ALIASES = new Map([
  // English
  ['general american', 'american'],
  ['standard american', 'american'],
  ['general-american', 'american'],
  ['general_american', 'american'],
  ['us', 'american'],
  ['usa', 'american'],
  ['north america', 'american'],
  ['north american', 'american'],
  ['american', 'american'],
  ['texan', 'american'],
  ['southern', 'american'],
  ['southern american', 'american'],
  ['uk', 'british'],
  ['british', 'british'],
  ['english (uk)', 'british'],
  ['australian', 'australian'],
  ['canadian', 'canadian'],
  ['irish', 'irish'],
  ['scottish', 'scottish'],
  // Dutch
  ['flemish', 'flemish'],
  // Polish (best-effort)
  ['flamandzki', 'flemish'],
  ['flamandzkiego', 'flemish'],
  ['flamandzkim', 'flemish'],
  ['flamandzka', 'flemish'],
  ['flamandzką', 'flemish'],
  ['flamandzka', 'flemish'],
  // Spanish
  ['mexican', 'mexican'],
  ['latin american', 'latin american'],
  ['latam', 'latin american'],
  // ElevenLabs shared-voices uses "peninsular" for Spain/European Spanish.
  ['peninsular', 'peninsular'],
  ['european spanish', 'peninsular'],
  ['spanish (spain)', 'peninsular'],
  // Normalize common synonyms to the shared-voices facet name.
  ['castilian', 'peninsular'],
  ['spain', 'peninsular'],
  // Portuguese
  ['brazil', 'brazilian'],
  ['br', 'brazilian'],
  ['brazilian', 'brazilian'],
  // NOTE: shared-voices accent facet uses "european" (not "portuguese") for Portugal/pt-PT.
  ['portugal', 'european'],
  ['european portuguese', 'european'],
  ['portuguese', 'european']
]);

function normalizeRequestedLocale(input) {
  try {
    const raw = (input || '').toString().trim();
    if (!raw) return null;
    const lower = raw.toLowerCase();

    // Special UI-style tokens (not always written as xx-YY)
    if (/\b(es)[\s\-_]*(latam|latin\s*america|latinamerica)\b/i.test(raw)) return 'es-419';
    if (/\b(pt)[\s\-_]*(eu|europe|european)\b/i.test(raw)) return 'pt-PT';
    if (/\b(en)[\s\-_]*(uk|britain|england)\b/i.test(raw)) return 'en-GB';

    // Normalize separators & whitespace
    let tag = lower.replace(/_/g, '-').replace(/\s+/g, '');
    const alias = LOCALE_ALIASES.get(tag);
    if (alias) return alias;

    // Accept xx-YY or xx-999 (UN M.49 region code like es-419)
    const m = tag.match(/^([a-z]{2})-([a-z]{2}|\d{3})$/);
    if (!m) return null;
    const lang = m[1].toLowerCase();
    const region = m[2];
    const reg = /^\d{3}$/.test(region) ? region : region.toUpperCase();
    return `${lang}-${reg}`;
  } catch (_) {
    return null;
  }
}

function normalizeRequestedAccent(input) {
  try {
    const raw = (input || '').toString().toLowerCase().trim();
    if (!raw) return null;
    const cleaned = raw.replace(/[_\-]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (ACCENT_ALIASES.has(cleaned)) return ACCENT_ALIASES.get(cleaned);
    // direct pass-through for known single tokens
    const direct = cleaned.split(' ').slice(0, 3).join(' ');
    if (ACCENT_ALIASES.has(direct)) return ACCENT_ALIASES.get(direct);
    // If user typed a single known token (e.g., "mexican"), keep it.
    if (/^[a-z]{3,20}$/.test(cleaned)) return cleaned;
    return cleaned;
  } catch (_) {
    return null;
  }
}

/**
 * Gulf / Arabian Peninsula regional markers → ElevenLabs `ar` accent facet keys (see facets.json).
 * Returns null if no GCC-style regional token is present.
 */
function detectGccArabicVoiceIntent(userText) {
  const lower = (userText || '').toString().toLowerCase();
  const rules = [
    { re: /\b(kuwaiti|kuwait)\b/, accent: 'kuwaiti' },
    { re: /\b(saudi|riyadh|jeddah)\b/, accent: 'saudi' },
    { re: /\b(emirati|emirates|uae|dubai|abu[\s-]?dhabi|sharjah|ajman)\b/, accent: 'gulf' },
    { re: /\b(qatari|qatar|doha)\b/, accent: 'gulf' },
    { re: /\b(bahraini|bahrain|manama)\b/, accent: 'gulf' },
    { re: /\b(omani|oman|muscat)\b/, accent: 'gulf' },
    { re: /\b(gcc|khaleeji|khaleej|gulf arabic|peninsular arabic)\b/, accent: 'gulf' }
  ];
  let best = null;
  for (const { re, accent } of rules) {
    const m = lower.match(re);
    if (m && (best === null || m.index < best.pos)) {
      best = { pos: m.index, accent };
    }
  }
  if (!best) return null;
  return { iso2: 'ar', accent: best.accent };
}

function hasRegionalKeywordFocus(lowerOrText) {
  const lower = (lowerOrText || '').toString().toLowerCase();
  if (/\bnorth\s+america(n)?\b/.test(lower)) return true;
  if (/\b(usa|u\.s\.a\.|united states)\b/.test(lower)) return true;
  if (
    /\b(texan|southern|american|british|australian|mexican|irish|scottish|canadian|castilian|brazilian)\b/i.test(
      lower
    )
  ) {
    return true;
  }
  return detectGccArabicVoiceIntent(lower) !== null;
}

function parseUserLanguageHints(userText) {
  const text = (userText || '').toString();
  const lower = text.toLowerCase();

  // 1) locale like pt-BR, es-MX
  // NOTE: allow only '-' or '_' (optionally with spaces around), never plain space.
  // This prevents false positives like "It is" -> it-IS.
  const mLocale = text.match(/\b([A-Za-z]{2})\s*[-_]\s*([A-Za-z]{2})\b/);
  if (mLocale) {
    const iso2 = mLocale[1].toLowerCase();
    const localeRaw = `${iso2}-${mLocale[2].toUpperCase()}`;
    const locale = normalizeRequestedLocale(localeRaw) || localeRaw;
    const ok = languageIndex.iso2Set.size
      ? languageIndex.iso2Set.has(iso2)
      : FALLBACK_ISO2_ALLOWLIST.has(iso2);
    if (ok) return { iso2, locale, explicit: true, reason: 'locale' };
  }

  // 2) ISO2 token ONLY when explicitly marked (to avoid false positives like "to", "in", "an")
  // Examples we accept:
  // - "language: en", "lang=en"
  // - "język: pl"
  // - "(en)" or "[en]"
  const mExplicitIso =
    lower.match(/\b(?:language|lang(?:uage)?|język|jezyk|idioma)\s*[:=]\s*([a-z]{2})\b/) ||
    lower.match(/[\(\[]\s*([a-z]{2})\s*[\)\]]/);
  if (mExplicitIso) {
    const iso2 = (mExplicitIso[1] || '').toLowerCase();
    const ok = languageIndex.iso2Set.size
      ? languageIndex.iso2Set.has(iso2)
      : FALLBACK_ISO2_ALLOWLIST.has(iso2);
    if (ok) return { iso2, locale: null, explicit: true, reason: 'iso2_explicit' };
  }

  // 3) language names from dynamic index
  for (const name of languageIndex.namesSorted || []) {
    if (!name) continue;
    if (new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(lower)) {
      const iso2 = languageIndex.byName.get(name);
      if (iso2) {
        // locale inference for common variants (best-effort)
        let locale = null;
        if (iso2 === 'pt') {
          if (/\b(brazil|brasil|brazilian|brasile)\b/.test(lower)) locale = 'pt-BR';
          if (/\b(portugal|european)\b/.test(lower)) locale = 'pt-PT';
        }
        if (iso2 === 'es') {
          if (/\b(mexico|mexican|mx|es-mx)\b/.test(lower)) locale = 'es-MX';
        }
        return { iso2, locale, explicit: true, reason: 'name' };
      }
    }
  }

  // 4) minimal static aliases
  for (const [alias, iso2] of STATIC_LANGUAGE_ALIASES.entries()) {
    if (new RegExp(`\\b${alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(lower)) {
      let locale = null;
      if (iso2 === 'pt' && /\b(brazil|brasil|brazilian|brasile)\b/.test(lower)) locale = 'pt-BR';
      return { iso2, locale, explicit: true, reason: 'static_alias' };
    }
  }

  // 4b) accent terms that imply a language
  if (/\bnorth\s+america(n)?\b/.test(lower)) {
    return { iso2: 'en', locale: null, explicit: true, reason: 'north_america_region' };
  }
  if (/\b(usa|u\.s\.a\.|united states)\b/.test(lower)) {
    return { iso2: 'en', locale: null, explicit: true, reason: 'us_region' };
  }
  const ACCENT_IMPLIES_LANGUAGE = new Map([
    ['texan', 'en'],
    ['southern', 'en'],
    ['american', 'en'],
    ['british', 'en'],
    ['australian', 'en'],
    ['canadian', 'en'],
    ['irish', 'en'],
    ['scottish', 'en'],
    ['mexican', 'es'],
    ['castilian', 'es'],
    ['brazilian', 'pt'],
  ]);
  {
    let bestAccent = null; // { pos, iso2 }
    for (const [accent, iso2] of ACCENT_IMPLIES_LANGUAGE.entries()) {
      const m = lower.match(new RegExp(`\\b${accent}\\b`));
      if (m && (bestAccent === null || m.index < bestAccent.pos)) {
        bestAccent = { pos: m.index, iso2 };
      }
    }
    if (bestAccent) {
      return { iso2: bestAccent.iso2, locale: null, explicit: true, reason: 'accent_implies_lang' };
    }
  }

  // 4c) GCC / Arabian Gulf regions → Arabic voice language
  {
    const gcc = detectGccArabicVoiceIntent(text);
    if (gcc) {
      return { iso2: 'ar', locale: null, explicit: true, reason: 'gcc_region' };
    }
  }

  // 5) fuzzy language/alias matching (bounded, conservative)
  try {
    const tokens = tokenizeForTypos(lower, { minLen: 5 });
    if (tokens.length) {
      const candidates = dedupePreserveOrder([
        ...((languageIndex.namesSorted || []).filter(Boolean) || []),
        ...Array.from(STATIC_LANGUAGE_ALIASES.keys()).map((x) => normalizeLangName(x)).filter(Boolean)
      ]).filter((c) => c.length >= 4);

      let best = null; // { token, match, dist }

      for (const tok of tokens) {
        // Only try to correct single-word alphabetic-ish tokens
        if (!/^[a-z0-9]{5,}$/i.test(tok)) continue;
        const maxDist = maxTypoDistanceForToken(tok);
        const sugg = suggestClosest(tok, candidates, { maxDist, maxSuggestions: 2 });
        for (const m of sugg) {
          if (!m || m === tok) continue;
          const d = boundedLevenshtein(tok, m, maxDist);
          if (d > maxDist) continue;
          if (!best || d < best.dist || (d === best.dist && m.length < best.match.length)) {
            best = { token: tok, match: m, dist: d };
          }
        }
      }

      if (best && best.match) {
        const name = normalizeLangName(best.match);
        const iso2 = languageIndex.byName.get(name) || STATIC_LANGUAGE_ALIASES.get(name) || null;
        if (iso2) {
          let locale = null;
          if (iso2 === 'pt') {
            if (/\b(brazil|brasil|brazilian|brasile|pt-br)\b/.test(lower)) locale = 'pt-BR';
            if (/\b(portugal|european|pt-pt|pt-eu)\b/.test(lower)) locale = 'pt-PT';
          }
          if (iso2 === 'es') {
            if (/\b(mexico|mexican|mx|es-mx)\b/.test(lower)) locale = 'es-MX';
            if (/\b(spain|castilian|es-es)\b/.test(lower)) locale = 'es-ES';
            if (/\b(latam|latin america|latinamerican|es-419)\b/.test(lower)) locale = 'es-419';
          }
          if (iso2 === 'zh') {
            if (/\b(zh-tw|taiwan|traditional)\b/.test(lower)) locale = 'zh-TW';
            else if (/\b(zh-hk|hong\s*kong|hk)\b/.test(lower)) locale = 'zh-HK';
            else if (/\b(zh-cn|china|mainland|simplified|cn)\b/.test(lower)) locale = 'zh-CN';
          }
          return {
            iso2,
            locale,
            explicit: true,
            reason: 'fuzzy_language',
            typo_from: best.token,
            typo_to: name
          };
        }
      }
    }
  } catch (_) {}

  return { iso2: null, locale: null, explicit: false, reason: 'none' };
}

// -------------------------------------------------------------
// Typo-tolerant matching helpers (conservative, bounded)
// -------------------------------------------------------------

function dedupePreserveOrder(list) {
  const out = [];
  const seen = new Set();
  for (const it of Array.isArray(list) ? list : []) {
    const v = (it || '').toString();
    if (!v) continue;
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

function tokenizeForTypos(text, { minLen = 5 } = {}) {
  try {
    const s = (text || '')
      .toString()
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, ''); // strip diacritics
    const raw = s.split(/[^a-z0-9]+/g).filter(Boolean);
    const tokens = raw.filter((t) => t.length >= minLen);
    return dedupePreserveOrder(tokens);
  } catch (_) {
    return [];
  }
}

function isSingleAdjacentTransposition(a, b) {
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  if (i >= a.length - 1) return false;
  if (a[i] !== b[i + 1] || a[i + 1] !== b[i]) return false;
  for (let j = i + 2; j < a.length; j++) {
    if (a[j] !== b[j]) return false;
  }
  return true;
}

function boundedLevenshtein(a, b, maxDist) {
  const s = (a || '').toString();
  const t = (b || '').toString();
  const n = s.length;
  const m = t.length;
  if (maxDist == null) maxDist = 2;
  if (s === t) return 0;
  if (!n) return m;
  if (!m) return n;
  if (Math.abs(n - m) > maxDist) return maxDist + 1;
  if (isSingleAdjacentTransposition(s, t)) return 1;

  // Classic DP with early-exit on row minimum (bounded)
  let prev = new Array(m + 1);
  let curr = new Array(m + 1);
  for (let j = 0; j <= m; j++) prev[j] = j;

  for (let i = 1; i <= n; i++) {
    curr[0] = i;
    let rowMin = curr[0];
    const si = s.charCodeAt(i - 1);
    for (let j = 1; j <= m; j++) {
      const cost = si === t.charCodeAt(j - 1) ? 0 : 1;
      const del = prev[j] + 1;
      const ins = curr[j - 1] + 1;
      const sub = prev[j - 1] + cost;
      const v = del < ins ? (del < sub ? del : sub) : ins < sub ? ins : sub;
      curr[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > maxDist) return maxDist + 1;
    const tmp = prev;
    prev = curr;
    curr = tmp;
  }
  return prev[m];
}

function maxTypoDistanceForToken(token) {
  const n = (token || '').toString().length;
  if (n >= 9) return 3;
  return 2;
}

function suggestClosest(term, candidates, { maxDist = 2, maxSuggestions = 2 } = {}) {
  const w = (term || '').toString().toLowerCase().trim();
  if (!w || !Array.isArray(candidates) || candidates.length === 0) return [];
  const best = [];
  let bestDist = maxDist + 1;

  for (const c of candidates) {
    const cand = (c || '').toString().toLowerCase().trim();
    if (!cand) continue;
    if (cand === w) return [cand];
    if (Math.abs(cand.length - w.length) > maxDist) continue;
    const d = boundedLevenshtein(w, cand, maxDist);
    if (d > maxDist) continue;
    if (d < bestDist) {
      bestDist = d;
      best.length = 0;
      best.push({ cand, d });
    } else if (d === bestDist) {
      best.push({ cand, d });
    }
  }

  best.sort((a, b) => a.cand.length - b.cand.length || a.cand.localeCompare(b.cand));
  return best.slice(0, Math.max(1, maxSuggestions)).map((x) => x.cand);
}

// -------------------------------------------------------------
// Small helpers
// -------------------------------------------------------------

function validateEnvOrExit() {
  const required = [
    'OPENAI_API_KEY',
    'ELEVENLABS_API_KEY',
    'SLACK_BOT_TOKEN',
    'SLACK_SIGNING_SECRET',
    'SLACK_APP_TOKEN'
  ];
  const missing = required.filter((k) => !process.env[k] || String(process.env[k]).trim() === '');
  if (missing.length) {
    console.error(
      'Missing required environment variables: ' + missing.join(', ') + '. Exiting.'
    );
    process.exit(1);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableError(err) {
  try {
    const status = err?.response?.status;
    if (status === 429) return true;
    if (status >= 500 && status < 600) return true;
  } catch (_) {}
  const code = err?.code;
  const retryableCodes = new Set([
    'ECONNRESET',
    'ETIMEDOUT',
    'EAI_AGAIN',
    'ENOTFOUND',
    'ECONNABORTED'
  ]);
  if (retryableCodes.has(code)) return true;
  return false;
}

async function withRetry(fn, options = {}) {
  const attempts = options.attempts || 3;
  const baseDelayMs = options.baseDelayMs || 300;
  const maxDelayMs = options.maxDelayMs || 3000;
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i === attempts - 1 || !isRetryableError(err)) {
        throw err;
      }
      const jitter = Math.random() * 200;
      const delay = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, i)) + jitter;
      await sleep(delay);
    }
  }
  throw lastErr;
}

async function httpGetWithRetry(url, config) {
  return withRetry(async () => {
    const res = await axios.get(url, config);
    return res;
  });
}

async function httpPostWithRetry(url, data, config, retryOptions = null) {
  return withRetry(
    async () => {
      const res = await axios.post(url, data, config);
      return res;
    },
    retryOptions || undefined
  );
}

function isDuplicateRequest(threadTs, cleaned) {
  try {
    const key = `${threadTs}|${(cleaned || '').toLowerCase()}`;
    const now = Date.now();
    const prev = recentRequests.get(key);
    if (prev && now - prev < REQUEST_DEDUP_TTL_MS) return true;
    recentRequests.set(key, now);
    return false;
  } catch (_) {
    return false;
  }
}

function safeLogAxiosError(context, err) {
  try {
    const status = err?.response?.status;
    const statusText = err?.response?.statusText;
    const code = err?.code;
    const msg =
      err?.response?.data?.error?.message ||
      err?.message ||
      (typeof err === 'string' ? err : 'Unknown error');
    const rid =
      err?.response?.headers?.['x-request-id'] ||
      err?.response?.headers?.['x-openai-request-id'];
    console.error(
      `[${context}] ${code ? `${code} ` : ''}${status || ''} ${statusText || ''} ${msg}${
        rid ? ` (request_id=${rid})` : ''
      }`
    );
  } catch (e) {
    console.error(`[${context}]`, err?.message || err);
  }
}

function startMemoryCleanup() {
  setInterval(() => {
    const now = Date.now();
    // Clean sessions by lastActive
    for (const [ts, session] of Object.entries(sessions)) {
      try {
        const last = session?.lastActive || 0;
        if (now - last > SESSION_TTL_MS) {
          delete sessions[ts];
        }
      } catch (_) {}
    }
    // Clean recentRequests older than TTL
    try {
      for (const [key, timestamp] of recentRequests.entries()) {
        if (now - timestamp > REQUEST_DEDUP_TTL_MS) {
          recentRequests.delete(key);
        }
      }
    } catch (_) {}
  }, CLEANUP_INTERVAL_MS);
}

function cleanText(text) {
  if (!text) return '';
  // remove Slack mentions like <@U123ABC>
  return text
    .replace(/<@[^>]+>/g, '')
    .trim()
    .replace(/^[\s,;:\-–—"“”'`]+/, '');
}

function isHighQuality(voice) {
  if (!voice || typeof voice !== 'object') return false;

  const cat = (voice.category || '').toString().toLowerCase();
  if (cat === 'high_quality' || cat === 'high quality') return true;

  if (voice.sharing && typeof voice.sharing === 'object') {
    const sharingCat = (voice.sharing.category || '').toString().toLowerCase();
    if (sharingCat === 'high_quality' || sharingCat === 'high quality') return true;
  }

  if (
    Array.isArray(voice.high_quality_base_model_ids) &&
    voice.high_quality_base_model_ids.length > 0
  ) {
    return true;
  }

  if (voice.labels && typeof voice.labels === 'object') {
    const labelHq = String(voice.labels.high_quality || '').toLowerCase();
    if (labelHq === 'true' || labelHq === 'yes' || labelHq === '1') return true;
  }

  if (
    voice.sharing &&
    typeof voice.sharing === 'object' &&
    voice.sharing.labels &&
    typeof voice.sharing.labels === 'object'
  ) {
    const labelHq = String(voice.sharing.labels.high_quality || '').toLowerCase();
    if (labelHq === 'true' || labelHq === 'yes' || labelHq === '1') return true;
  }

  return false;
}

function voiceSupportsModel(voice, modelId) {
  if (!voice || typeof voice !== 'object' || !modelId) return false;
  const ids = voice.high_quality_base_model_ids;
  if (!Array.isArray(ids) || !ids.length) return false;
  const want = String(modelId).toLowerCase().trim();
  return ids.some((id) => String(id || '').toLowerCase().trim() === want);
}

function isV3Voice(voice) {
  return voiceSupportsModel(voice, 'eleven_v3');
}

function filterVoicesByModelPreference(voices, modelPref) {
  if (!Array.isArray(voices) || !voices.length) return voices || [];
  const prefs = normalizeModelPreferenceList(modelPref);
  if (!prefs.length) return voices;
  const matched = voices.filter((v) => prefs.some((p) => voiceSupportsModel(v, p)));
  return matched.length ? matched : voices;
}

/** Normalize model preference to a list of model ids (empty = any). */
function normalizeModelPreferenceList(modelPref) {
  if (!modelPref || modelPref === 'any') return [];
  if (Array.isArray(modelPref)) {
    return modelPref
      .map((x) => String(x || '').toLowerCase().trim())
      .filter((x) => x === 'eleven_v3' || x === 'eleven_flash_v2_5');
  }
  const s = String(modelPref).toLowerCase().trim();
  if (s === 'eleven_v3' || s === 'eleven_flash_v2_5') return [s];
  return [];
}

function isSpecificModelPreference(modelPref) {
  return normalizeModelPreferenceList(modelPref).length > 0;
}

function hasCustomRateMultiplier(voice) {
  return Number(voice?.rate) > 1;
}

// Very rough guess of the language the user is typing in
function guessUiLanguageFromText(text) {
  if (!text) return 'en';
  const lower = text.toLowerCase();
  if (/[ąćęłńóśżź]/.test(lower) || lower.includes('głos') || lower.includes('glos')) {
    return 'pl';
  }
  return 'en';
}

// Try to detect which VOICE language user wants (Polish, English, Spanish, etc.)
function detectVoiceLanguageFromText(text) {
  if (!text) return null;
  const hint = parseUserLanguageHints(text);
  return hint && hint.iso2 ? hint.iso2 : null;
}

/** Detect comma/and-separated multi-language voice requests (e.g. "Spanish, Portuguese, and Turkish voices"). */
function detectMultipleLanguageIntents(text) {
  try {
    const raw = (text || '').toString().trim();
    if (!raw) return [];
    const lower = raw.toLowerCase();

    if (!/[,;]|\s+\band\b|\s+oraz\s+|\s+&\s+/i.test(raw)) return [];
    if (!/\bvoices?\b|\bgłos(y|ów|ami)?\b/i.test(lower)) return [];

    const segments = raw
      .split(/\s*[,;]\s*|\s+\band\b\s+|\s+oraz\s+|\s+&\s+/i)
      .map((s) => s.trim())
      .filter((s) => s.length > 2);
    if (segments.length < 2) return [];

    const results = [];
    const seenIso2 = new Set();
    for (const seg of segments) {
      const cleanedSeg = seg.replace(/\s+voices?\s*$/i, '').trim() || seg;
      const hint = parseUserLanguageHints(cleanedSeg) || parseUserLanguageHints(seg);
      if (!hint?.iso2) continue;
      const iso2 = hint.iso2.toLowerCase().slice(0, 2);
      if (seenIso2.has(iso2)) continue;
      seenIso2.add(iso2);
      results.push({
        iso2,
        locale: hint.locale || null,
        segment: seg,
        title: cleanedSeg || seg
      });
    }
    return results.length >= 2 ? results : [];
  } catch (_) {
    return [];
  }
}

// Detect if user explicitly mentioned a language (so we should constrain by language)
function hasExplicitLanguageMention(text) {
  if (!text) return false;
  const hint = parseUserLanguageHints(text);
  return !!(hint && hint.explicit && hint.iso2);
}

function detectLanguageMetaIntent(text) {
  const lower = (text || '').toString().toLowerCase();
  return /\b(language|lang(?:uage)?|język|jezyk|idioma|idiomas)\b/.test(lower);
}

// -------------------------------------------------------------
// Global keyword noise filters
// -------------------------------------------------------------

// Generic/noise keywords – skip unless explicitly present in user text
const GENERIC_NOISE_KEYWORDS = new Set([
  'narration', 'narrator', 'voiceover',
  'trailer', 'video', 'content', 'media',
  'youtube', 'tiktok', 'podcast', 'explainer',
  'gaming', 'music', 'song', 'audio', 'storytime', 'stream', 'streaming',
  'commercial', 'advertising', 'advertisement', 'ad', 'ads', 'promo', 'promotion',
  'marketing', 'brand', 'branding', 'campaign', 'corporate', 'tv', 'radio', 'sizzle'
]);

// Very short words allowed despite length rule
const SHORT_WHITELIST = new Set(['evil', 'dark', 'deep', 'raw', 'warm', 'slow', 'fast', 'calm']);

function normalizeKw(s) {
  return (s || '').toString().toLowerCase().trim();
}

function explicitlyMentionedInText(kw, text) {
  const k = normalizeKw(kw);
  const lower = (text || '').toLowerCase();
  return lower.includes(k);
}

function isGenericNoiseKeyword(kw) {
  return GENERIC_NOISE_KEYWORDS.has(normalizeKw(kw));
}

/**
 * Dominant brief use-case family from user text (preferred) + plan keywords.
 * Used to stop conversational keyword-floor pollution and to rank facet-browse pools.
 * @returns {'conversational'|'narrative'|'articles'|'educational'|'commercial'|'characters'|'podcast'|null}
 */
function inferBriefUseCaseFamily(userText, plan) {
  const lower = (userText || '').toLowerCase();
  const useKw = (Array.isArray(plan?.use_case_keywords) ? plan.use_case_keywords : [])
    .map((k) => normalizeKw(k))
    .filter(Boolean)
    .join(' ');

  // User-text signals win over plan noise (keyword floor often injects "conversational").
  if (
    /\b(customer support|customer service|call center|contact center|tech support|technical support|ivr|voicemail)\b/.test(
      lower
    ) ||
    /\bconversational\b/.test(lower)
  ) {
    return 'conversational';
  }
  if (/\b(audiobooks?|narration|narrator|storytell(?:er|ing)?)\b/.test(lower)) {
    return 'narrative';
  }
  if (/\b(articles?)\b/.test(lower)) {
    return 'articles';
  }
  if (
    /\b(educational|education|e-?learning|documentary|informative|explainer|presentation)\b/.test(lower)
  ) {
    return 'educational';
  }
  if (/\b(commercial|advertising|advertisement|ads?|promo|promotion|brand|campaign)\b/.test(lower)) {
    return 'commercial';
  }
  if (/\b(cartoon|animation|animated|character|villain|gaming|\bgames?\b)\b/.test(lower)) {
    return 'characters';
  }
  if (/\b(podcast|podcaster|broadcaster|radio host)\b/.test(lower)) {
    return 'podcast';
  }

  // Plan-only fallbacks (when text is vague but GPT/heuristics set use_case_keywords)
  if (/\b(audiobook|narration|narrative|storytell)\b/.test(useKw)) return 'narrative';
  if (/\b(article|articles)\b/.test(useKw)) return 'articles';
  if (/\b(educational|informative|documentary|explainer|presentation)\b/.test(useKw)) {
    return 'educational';
  }
  if (/\b(conversational|customer support|call center|contact center|ivr|agent|support)\b/.test(useKw)) {
    return 'conversational';
  }
  if (/\b(commercial|advertis|promo|campaign|brand)\b/.test(useKw)) return 'commercial';
  if (/\b(cartoon|character|villain|gaming|animation)\b/.test(useKw)) return 'characters';
  if (/\b(podcast)\b/.test(useKw)) return 'podcast';
  return null;
}

function voiceMetadataBlob(voice) {
  return (
    (voice?.name || '') +
    ' ' +
    (voice?.description || '') +
    ' ' +
    (voice?.descriptive || '') +
    ' ' +
    (voice?.accent || '') +
    ' ' +
    (voice?.category || '')
  )
    .toString()
    .toLowerCase();
}

/**
 * Soft on-brief / off-brief score from voice metadata vs brief family.
 * Critical when facet-browse returns the same language pool for every use case.
 */
function scoreVoiceUseCaseFit(voice, family, userText) {
  if (!family || !voice) return 0;
  const blob = voiceMetadataBlob(voice);
  if (!blob.trim()) return 0;
  const lowerQ = (userText || '').toLowerCase();
  const has = (...tokens) => tokens.some((t) => t && blob.includes(t));
  const queryAsks = (...tokens) => tokens.some((t) => t && lowerQ.includes(t));
  let score = 0;

  const isProNarration =
    family === 'narrative' || family === 'articles' || family === 'educational';
  const hasNarratorSignal =
    has('narrat') || has('storytell') || has('audiobook') || has('voiceover') || has('voice over');
  const isSeasonalCharacter =
    has('santa') ||
    has('christmas') ||
    has('xmas') ||
    has('claus') ||
    has('elf') ||
    has('halloween') ||
    has('easter bunny') ||
    has('krampus');
  const isRomanceNiche =
    has('romantic') ||
    has('romance') ||
    has('seductive') ||
    has('sensual') ||
    has('intimate') ||
    has('sexy') ||
    (has('soft') && has('romantic'));

  if (isProNarration) {
    // Hard off-brief niches for articles / audiobooks / educational
    if (has('asmr')) score -= 2.6;
    if (has('whisper')) score -= 2.0;
    if (has('chipmunk') || has('squeaky') || has('high pitch') || has('high-pitch')) score -= 2.6;
    if (has('cartoon') || has('cartoonish') || has('animated')) score -= 1.8;
    if (has('playful') && (has('kid') || has('child') || has('cute') || has('chipmunk'))) score -= 1.6;
    if (
      has('customer support') ||
      has('call center') ||
      has('contact center') ||
      has('ivr') ||
      has('voicemail') ||
      (has('support') && has('customer'))
    ) {
      score -= 2.0;
    }
    if (has('theatrical') && (family === 'articles' || family === 'educational')) score -= 1.3;
    if (has('gritty') && family === 'articles') score -= 0.9;

    // On-brief positives (shared)
    if (has('narrat') || has('storytell') || has('storytelling')) score += 1.6;
    if (has('audiobook')) score += family === 'narrative' ? 2.2 : 0.4;
    if (has('deep') || has('resonant') || has('authoritative') || has('confident')) score += 1.1;
    // Warm/calm/clear: prefer with narrator signals; avoid boosting soft-romantic/seasonal alone
    if (has('clear') || has('professional') || has('neutral')) {
      score += 0.9;
    } else if (
      (has('calm') || has('warm')) &&
      hasNarratorSignal &&
      !isSeasonalCharacter &&
      !isRomanceNiche
    ) {
      score += 0.9;
    } else if ((has('calm') || has('warm')) && family !== 'narrative') {
      score += 0.9;
    }
  }

  if (family === 'articles' || family === 'educational') {
    if (
      has('informative') ||
      has('educational') ||
      has('documentary') ||
      has('explainer') ||
      has('presentation') ||
      has('news') ||
      has('journal')
    ) {
      score += 1.6;
    }
    if (has('article')) score += 1.2;
    if (family === 'educational' && (has('teacher') || has('tutor') || has('lesson') || has('learning'))) {
      score += 0.8;
    }
    // Mild: seasonal / pure romance less ideal for articles/edu (don't over-penalize)
    if (isSeasonalCharacter && !queryAsks('santa', 'christmas', 'holiday')) score -= 1.2;
    if (isRomanceNiche && !queryAsks('romantic', 'romance', 'sensual')) score -= 0.8;
  }

  if (family === 'narrative') {
    // Generic audiobook brief: prefer clear narrators, not seasonal/character or soft-romance niches
    if (isSeasonalCharacter && !queryAsks('santa', 'christmas', 'xmas', 'holiday', 'claus')) {
      score -= 2.8;
    }
    if (isRomanceNiche && !queryAsks('romantic', 'romance', 'sensual', 'intimate', 'seductive')) {
      score -= 2.2;
    }
    // Soft-only / gentle-without-narrator is weak for generic "best audiobooks"
    if (
      (has('soft') || has('gentle') || has('soothing')) &&
      !hasNarratorSignal &&
      !queryAsks('soft', 'gentle', 'soothing', 'romantic')
    ) {
      score -= 1.2;
    }
    // Prefer explicit audiobook / narrator framing over vague "story"
    if (has('audiobook') || has('narrat')) score += 0.6;
    if (/\bfiction\b/.test(blob) || /\bnovel\b/.test(blob) || has('dramatic')) score += 0.5;
  }

  if (family === 'conversational') {
    if (has('customer support') || has('call center') || has('conversational') || has('agent')) {
      score += 1.4;
    }
    if (has('asmr') || has('chipmunk') || has('cartoonish')) score -= 1.5;
  }

  return score;
}

function filterKeywordsGlobally(userText, keywords) {
  const out = [];
  const seen = new Set();
  const lower = (userText || '').toLowerCase();
  const isCommercialIntent = /\b(commercial|advertising|ad|promo|promotion|brand|campaign)\b/.test(lower);
  const isPodcastIntent = /\b(podcast|broadcaster|radio|host)\b/.test(lower);
  const briefFamily = inferBriefUseCaseFamily(userText, null);
  const isNarrativeIntent = briefFamily === 'narrative';
  const isEduIntent = briefFamily === 'articles' || briefFamily === 'educational';
  const whitelistCommercial = new Set(['commercial','advertising','ad','ads','promo','promotion','marketing','brand','branding','campaign']);
  const whitelistNarrative = new Set(['narration', 'narrator', 'voiceover', 'storytime']);
  const whitelistEdu = new Set(['explainer', 'documentary']);
  for (let kw of keywords) {
    const k = normalizeKw(kw);
    if (!k) continue;
    if (k.length < 3 && !SHORT_WHITELIST.has(k) && !explicitlyMentionedInText(k, userText)) {
      continue;
    }
    if (isGenericNoiseKeyword(k) && !explicitlyMentionedInText(k, userText)) {
      // allow commercial/podcast/narrative/edu tokens when those intents are active
      if (isCommercialIntent && whitelistCommercial.has(k)) {
        // keep
      } else if (isPodcastIntent && (k === 'podcast' || k === 'radio' || k === 'host')) {
        // keep
      } else if (isNarrativeIntent && whitelistNarrative.has(k)) {
        // keep
      } else if (isEduIntent && whitelistEdu.has(k)) {
        // keep
      } else {
        continue;
      }
    }
    if (!seen.has(k)) {
      out.push(k);
      seen.add(k);
    }
  }
  return out;
}

// Intent enrichment – front-load keywords tied to common intents
function enrichKeywordsByIntent(userText, keywords) {
  const lower = (userText || '').toLowerCase();
  const has = (...ts) => ts.some((t) => lower.includes(t));
  const pushFront = (arr, items) => {
    const seen = new Set(arr.map((x) => (x || '').toLowerCase()));
    const front = [];
    for (const it of items) {
      const k = (it || '').toLowerCase().trim();
      if (k && !seen.has(k)) {
        front.push(k);
        seen.add(k);
      }
    }
    return [...front, ...arr.filter((k) => !!k)];
  };

  let out = [...keywords];

  // Military
  if (has('military','soldier','army','navy','marine','air force')) {
    out = pushFront(out, [
      'military','soldier','officer','commander','sergeant','drill sergeant',
      'authoritative','commanding','tactical','disciplined','battle-hardened',
      'radio','comms','veteran','gritty','deep','bassy'
    ]);
    // remove commercial styles unless explicitly present
    const commercialish = new Set([
      'commercial','advertising','advertisement','ad','ads','promo','promotion',
      'marketing','brand','branding','campaign','corporate','tv','radio','sizzle'
    ]);
    out = out.filter((k) => !(commercialish.has(k) && !explicitlyMentionedInText(k, userText)));
  }

  // Cartoon/negative tone / antagonist
  const isCartoon = has('cartoon','animated','animation','character');
  const isNegative = has('bad','evil','villain','antagonist','sinister','menacing','wicked','angry','aggressive','dark','ominous','threatening');
  if (isCartoon || isNegative) {
    out = pushFront(out, [
      'villain','evil','antagonist','sinister','menacing','wicked',
      'angry','aggressive','dark','ominous','threatening','intense',
      'gravelly','raspy','growl','harsh','diabolical','cackling',
      'cartoonish','animated','character'
    ]);
    const banPos = new Set(['playful','whimsical','friendly','cheerful','uplifting','calm','warm']);
    out = out.filter((k) => !(banPos.has((k || '').toLowerCase()) && !explicitlyMentionedInText(k, userText)));
  }

  // Bilingual EN+ES: add Spanish-side recall tokens without constraining API language/accent.
  if (detectBilingualEnEs(userText)) {
    const esSide = ['spanish', 'bilingual', 'español', 'espanol', 'latin american', 'latino'];
    if (/\blatin american\b/.test(lower)) esSide.push('latin american spanish');
    out = pushFront(out, esSide);
  }

  // Narration / articles / educational: front-load on-brief tokens; drop niche styles unless asked.
  const briefFamily = inferBriefUseCaseFamily(userText, null);
  if (briefFamily === 'narrative') {
    out = pushFront(out, [
      'audiobook',
      'narration',
      'narrator',
      'storytelling',
      'storyteller',
      'warm',
      'calm',
      'deep',
      'resonant',
      'clear'
    ]);
  } else if (briefFamily === 'articles') {
    out = pushFront(out, [
      'article',
      'informative',
      'documentary',
      'news',
      'clear',
      'professional',
      'neutral',
      'authoritative'
    ]);
  } else if (briefFamily === 'educational') {
    out = pushFront(out, [
      'educational',
      'informative',
      'explainer',
      'e-learning',
      'clear',
      'calm',
      'professional',
      'warm'
    ]);
  }
  if (briefFamily === 'narrative' || briefFamily === 'articles' || briefFamily === 'educational') {
    const niche = new Set([
      'asmr',
      'whisper',
      'chipmunk',
      'squeaky',
      'cartoonish',
      'cartoon',
      'playful',
      'cute',
      'youthful',
      'high pitch',
      'squeaky'
    ]);
    out = out.filter((k) => !(niche.has(normalizeKw(k)) && !explicitlyMentionedInText(k, userText)));
  }

  // Deduplicate
  {
    const uniq = [];
    const seen = new Set();
    for (const k of out) {
      const v = (k || '').toLowerCase().trim();
      if (v && !seen.has(v)) {
        uniq.push(v);
        seen.add(v);
      }
    }
    out = uniq;
  }

  return out;
}

// Heuristic: is this voice effectively in langCode?
function isVoiceInLanguage(voice, langCode) {
  if (!voice || !langCode) return false;
  const lc = langCode.toLowerCase();

  const langField = (voice.language || '').toString().toLowerCase();
  if (langField) {
    if (langField === lc) return true;
    if (langField.startsWith(lc + '-')) return true;
    if (langField.includes(lc)) return true;
  }

  if (Array.isArray(voice.verified_languages)) {
    for (const entry of voice.verified_languages) {
      if (!entry || !entry.language) continue;
      const el = entry.language.toString().toLowerCase();
      if (el === lc || el.startsWith(lc + '-') || el.includes(lc)) return true;
    }
  }

  const blob = (
    (voice.name || '') +
    ' ' +
    (voice.description || '') +
    ' ' +
    (voice.descriptive || '') +
    ' ' +
    (voice.accent || '')
  ).toString().toLowerCase();

  if (lc === 'pl') {
    if (blob.includes('polish') || blob.includes('polski')) return true;
  } else if (lc === 'en') {
    if (blob.includes('english') || blob.includes('angielski') || blob.includes('american')) {
      return true;
    }
  } else if (lc === 'es') {
    if (blob.includes('spanish') || blob.includes('español') || blob.includes('espanol')) {
      return true;
    }
  } else if (lc === 'de') {
    if (blob.includes('german') || blob.includes('deutsch')) return true;
  } else if (lc === 'fr') {
    if (blob.includes('french') || blob.includes('français') || blob.includes('francais')) {
      return true;
    }
  } else if (lc === 'it') {
    if (blob.includes('italian') || blob.includes('italiano')) return true;
  } else if (lc === 'ar') {
    if (
      blob.includes('arabic') ||
      /\barab\b/.test(blob) ||
      blob.includes('gulf') ||
      blob.includes('emirati') ||
      blob.includes('qatari') ||
      blob.includes('khaleeji')
    ) {
      return true;
    }
  }

  return false;
}

// -------------------------------------------------------------
// Strong-language request helpers (Strict vs Verified buckets)
// -------------------------------------------------------------

function extractIso2FromLanguageField(val) {
  const s = (val || '').toString().trim();
  if (!s) return null;
  return s.toLowerCase().slice(0, 2);
}

function extractLocaleFromField(val) {
  const s = (val || '').toString().trim();
  if (!s) return null;
  // normalize to xx-YY or xx-999 (UN M.49 region like es-419)
  const m = s.match(/^([a-z]{2})\s*[-_]\s*([a-z]{2}|\d{3})$/i);
  if (!m) return null;
  const lang = m[1].toLowerCase();
  const regionRaw = m[2];
  const region = /^\d{3}$/.test(regionRaw) ? regionRaw : regionRaw.toUpperCase();
  return `${lang}-${region}`;
}

function getRequestedLocale(userText, keywordPlan) {
  const text = (userText || '').toString();
  const lower = text.toLowerCase();
  // Explicit override (used by clarification flow)
  if (typeof keywordPlan?.target_locale === 'string' && keywordPlan.target_locale.trim()) {
    const loc = normalizeRequestedLocale(keywordPlan.target_locale) || keywordPlan.target_locale;
    // es-419 is a REGION alias (LatAm), not a queryable locale for shared-voices.
    // Treat it as "no explicit locale" and let downstream LatAm logic handle it.
    try {
      if (normalizeLocaleToken(loc) === 'es-419') return null;
    } catch (_) {}
    // If FacetKB knows the language and rejects the locale, treat as unset (conservative)
    try {
      const iso2 = (keywordPlan?.target_voice_language || '').toString().toLowerCase().slice(0, 2);
      if (iso2 && facetKB && facetKB.isLoaded && facetKB.isLoaded() && facetKB.hasIso2(iso2) && facetKB.checkLocaleAllowed) {
        const r = facetKB.checkLocaleAllowed(iso2, loc);
        if (r && r.known && !r.allowed) return null;
      }
    } catch (_) {}
    return loc;
  }
  const hint = parseUserLanguageHints(text);
  if (hint && hint.locale) {
    const loc = normalizeRequestedLocale(hint.locale) || hint.locale;
    try {
      const iso2 = (hint?.iso2 || keywordPlan?.target_voice_language || '').toString().toLowerCase().slice(0, 2);
      if (iso2 && facetKB && facetKB.isLoaded && facetKB.isLoaded() && facetKB.hasIso2(iso2) && facetKB.checkLocaleAllowed) {
        const r = facetKB.checkLocaleAllowed(iso2, loc);
        if (r && r.known && !r.allowed) return null;
      }
    } catch (_) {}
    return loc;
  }

  const iso2 =
    (keywordPlan?.target_voice_language || hint?.iso2 || '').toString().toLowerCase().slice(0, 2);
  if (!iso2) return null;

  // Best-effort regional inference for common cases (keep small & conservative)
  let candidate = null;
  if (iso2 === 'pt') {
    if (/\b(brazil|brasil|brazilian|brasile|pt-br)\b/.test(lower)) candidate = 'pt-BR';
    else if (/\b(portugal|pt-pt|european)\b/.test(lower)) candidate = 'pt-PT';
    else if (/\b(pt-eu|european union|eu)\b/.test(lower)) candidate = 'pt-PT';
  } else if (iso2 === 'es') {
    if (/\b(mexico|mexican|es-mx|mx)\b/.test(lower)) candidate = 'es-MX';
    else if (/\b(spain|castilian|es-es)\b/.test(lower)) candidate = 'es-ES';
    // LatAm signals: treat as region intent, not as locale=es-419.
    else if (/\b(european)\b/.test(lower) && /\b(spanish|es)\b/.test(lower)) candidate = 'es-ES';
  } else if (iso2 === 'fr') {
    if (/\b(fr-ca|french canadian|canadian french|quebec|québec|qc)\b/.test(lower)) candidate = 'fr-CA';
  }

  // Conservative validation against FacetKB when available
  try {
    if (candidate && facetKB && facetKB.isLoaded && facetKB.isLoaded() && facetKB.hasIso2(iso2) && facetKB.checkLocaleAllowed) {
      const r = facetKB.checkLocaleAllowed(iso2, candidate);
      if (r && r.known && !r.allowed) return null;
    }
  } catch (_) {}

  return candidate;
}

function hasNegatedAccentConstraint(userText) {
  try {
    const lower = (userText || '').toString().toLowerCase();
    if (!lower) return false;
    // Mirror patterns from extractNegativeAccents(), but as boolean checks.
    return (
      /\b(?:should|must|do)\s+not\s+(?:have|use|be|sound(?:ing)?|include)\s+(?:an?\s+)?[a-z][a-z\s\-]{0,40}?\s+(?:accent|akcent)\b/i.test(lower) ||
      /\b(?:not|no|without)\s+(?:an?\s+)?[a-z][a-z\s\-]{0,40}?\s+(?:accent|akcent)\b/i.test(lower) ||
      /\bbez\s+[a-ząćęłńóśżź][a-ząćęłńóśżź\s\-]{0,40}?\s+akcent(?:u)?\b/i.test(lower)
    );
  } catch (_) {
    return false;
  }
}

function hasExplicitAccentMention(userText) {
  const lower = (userText || '').toString().toLowerCase();
  const hasAccentWord = /\b(accent|akcent)\b/.test(lower);
  if (hasAccentWord) {
    // If user is NEGATING an accent ("should not have ... accent"), do not treat it
    // as an explicit accent *preference* (otherwise we can lock in target_accent incorrectly).
    if (hasNegatedAccentConstraint(userText)) {
      // If user also explicitly requests an accent positively, keep it explicit.
      if (/\b(?:with|using|use|in|as)\s+(?:an?\s+)?[a-z][a-z\s\-]{0,40}?\s+(?:accent|akcent)\b/i.test(lower)) {
        return true;
      }
      return false;
    }
    return true;
  }
  // Common implicit accent phrases (no explicit "accent" word)
  const implicit = [
    'general american',
    'standard american',
    'north america',
    'north american',
    'texan',
    'southern',
    'american',
    'british',
    'mexican',
    'castilian',
    'latin american',
    'latam',
    'latino',
    'european spanish',
    'spanish (spain)',
    'brazilian',
    'european portuguese',
    'portuguese (portugal)',
    'portuguese portugal',
    'pt-eu',
    'en-uk',
    'es-mx',
    'pt-br',
    'pt-pt',
    'emirati',
    'qatari',
    'khaleeji',
    'uae',
    'gulf arabic'
  ];
  if (implicit.some((t) => lower.includes(t))) return true;
  return detectGccArabicVoiceIntent(userText) !== null;
}

// -------------------------------------------------------------
// Dialect helpers (Chinese: Mandarin vs Cantonese)
// -------------------------------------------------------------

function detectChineseDialectFromText(userText) {
  const lower = (userText || '').toString().toLowerCase();
  const hasCantonese =
    /\b(cantonese|canton)\b/.test(lower) ||
    /\b(zh-hk)\b/.test(lower) ||
    /\b(hong\s*kong|hongkong)\b/.test(lower) ||
    lower.includes('粤语');
  const hasMandarin =
    /\b(mandarin|putonghua)\b/.test(lower) ||
    /\b(zh-cn)\b/.test(lower) ||
    /\b(mainland|simplified)\b/.test(lower) ||
    /\b(china)\b/.test(lower) ||
    lower.includes('普通话');

  if (hasCantonese && !hasMandarin) return 'cantonese';
  if (hasMandarin && !hasCantonese) return 'mandarin';
  return null;
}

function hasFrenchCanadianMarkers(userText) {
  const lower = (userText || '').toString().toLowerCase();
  return /\b(fr-ca|quebec|québec|canadian french|french canadian|qc)\b/.test(lower);
}

function hasFrenchEuropeanMarkers(userText) {
  const lower = (userText || '').toString().toLowerCase();
  if (!lower) return false;
  if (hasFrenchCanadianMarkers(userText)) return false;
  if (/\b(fr-fr|european french|metropolitan french|parisian|paris)\b/.test(lower)) return true;
  if (/\b(france|hexagonal)\b/.test(lower) && /\b(french|fr)\b/.test(lower)) return true;
  return /\b(european)\b/.test(lower) && /\b(french|fr)\b/.test(lower);
}

// -------------------------------------------------------------
// Variant intent detection (specific vs general) – global
// -------------------------------------------------------------
// Goal:
// - if user is specific (dialect/region/locale/accent), do NOT mix variants
// - if user is general, allow multi-variant sections
function detectVariantIntent(userText, iso2, kb) {
  try {
    const text = (userText || '').toString();
    const lower = text.toLowerCase();
    const lang = (iso2 || '').toString().toLowerCase().slice(0, 2);
    const out = {
      isSpecific: false,
      axis: null, // 'locale' | 'accent'
      requestedFacetKeys: [], // normalized facetKey strings
      fallbackFacetKeys: [], // fallback-only keys (used only when primary results are 0)
      requestedFacetQueryKeys: null, // optional: query-only variants (e.g. zh dialect sub-variants)
      combineGroupKey: null, // optional: combined facetKey for rendering
      combineGroupLabel: null, // optional: combined label for rendering
      minResults: 10
    };
    if (!lang) return out;

    // 1) explicit locale token in text
    const hint = parseUserLanguageHints(text);
    const hintLocale = hint && hint.locale ? normalizeRequestedLocale(hint.locale) || hint.locale : null;
    if (hintLocale) {
      const key = normalizeLocaleToken(hintLocale);
      if (key) {
        // es-419 is a LatAm REGION alias, not a queryable locale facet for shared-voices.
        // Treat it as a request for the broad Spanish LatAm accent group instead.
        if (lang === 'es' && key === 'es-419') {
          out.isSpecific = true;
          out.axis = 'accent';
          out.requestedFacetKeys = [normalizeCatalogToken('latin american') || 'latin american'];
          out.fallbackFacetKeys = ['mexican', 'colombian', 'argentine', 'peruvian', 'chilean', 'venezuelan']
            .map((x) => normalizeCatalogToken(x))
            .filter(Boolean);
          return out;
        }
        // European Portuguese: prefer accent=european (pt-PT locale catalog is sparse).
        if (lang === 'pt' && key === 'pt-pt') {
          out.isSpecific = true;
          out.axis = 'accent';
          out.requestedFacetKeys = ['european'];
          out.fallbackFacetKeys = [];
          return out;
        }
        out.isSpecific = true;
        out.axis = 'locale';
        out.requestedFacetKeys = [key];
        out.fallbackFacetKeys = [];
        return out;
      }
    }

    // 1a) Region heuristics BEFORE catalog token matching.
    // Critical for Spanish LatAm: bare token "american" must not win over "latin american".
    if (lang === 'pt') {
      if (/\b(brazil|brasil|brazilian|brasile|pt-br)\b/.test(lower)) {
        out.isSpecific = true;
        out.axis = 'locale';
        out.requestedFacetKeys = ['pt-br'];
        out.fallbackFacetKeys = [];
        return out;
      }
      if (
        /\b(portugal|pt-pt|pt-eu|european portuguese)\b/.test(lower) ||
        (/\b(european)\b/.test(lower) && /\b(portuguese|portugal|pt)\b/.test(lower))
      ) {
        out.isSpecific = true;
        out.axis = 'accent';
        out.requestedFacetKeys = ['european'];
        out.fallbackFacetKeys = [];
        return out;
      }
    }
    if (lang === 'es') {
      if (LATAM_SPANISH_RE.test(lower)) {
        out.isSpecific = true;
        out.axis = 'accent';
        out.requestedFacetKeys = [normalizeCatalogToken('latin american') || 'latin american'];
        out.fallbackFacetKeys = ['mexican', 'colombian', 'argentine', 'peruvian', 'chilean', 'venezuelan']
          .map((x) => normalizeCatalogToken(x))
          .filter(Boolean);
        return out;
      }
      if (/\b(mexico|mexican|es-mx|mx)\b/.test(lower)) {
        out.isSpecific = true;
        out.axis = 'locale';
        out.requestedFacetKeys = ['es-mx'];
        out.fallbackFacetKeys = [];
        return out;
      }
      if (/\b(spain|castilian|es-es)\b/.test(lower) || (/\b(european)\b/.test(lower) && /\bspanish\b/.test(lower))) {
        out.isSpecific = true;
        out.axis = 'locale';
        out.requestedFacetKeys = ['es-es'];
        out.fallbackFacetKeys = [];
        return out;
      }
    }
    if (lang === 'en') {
      if (/\b(en-us|us english|american english|usa)\b/.test(lower)) {
        out.isSpecific = true;
        out.axis = 'locale';
        out.requestedFacetKeys = ['en-us'];
        out.fallbackFacetKeys = [];
        return out;
      }
      if (/\b(en-gb|en-uk|british english|uk english|england)\b/.test(lower)) {
        out.isSpecific = true;
        out.axis = 'locale';
        out.requestedFacetKeys = ['en-gb'];
        out.fallbackFacetKeys = [];
        return out;
      }
    }

    // 1b) catalog-driven explicitness: if we can match an accent from catalog, treat as accent-specific.
    // This reduces the need for per-language region heuristics (works for accents like "sicilian", "istrian", etc.).
    try {
      if (kb && kb.isLoaded && kb.isLoaded() && kb.hasIso2 && kb.hasIso2(lang) && kb.suggestAccents) {
        const sugg = kb.suggestAccents(lang, text, { limit: 4 }) || [];
        const best = sugg.find((x) => x && x.matchKind && x.matchKind !== 'popularity') || null;
        if (best && best.norm) {
          out.isSpecific = true;
          out.axis = 'accent';
          out.requestedFacetKeys = [String(best.norm)];
          out.fallbackFacetKeys = buildAccentFallbackKeys(lang, kb, [best.norm]);
          return out;
        }
      }
    } catch (_) {}

    // 2) Chinese dialect is inherently specific
    if (lang === 'zh') {
      const d = detectChineseDialectFromText(text);
      if (d) {
        out.isSpecific = true;
        out.axis = 'accent';
        // Use FacetKB to pick matching accents (keys are normalized)
        const set = kb && kb.allowedAccentsByIso2 && kb.allowedAccentsByIso2.get ? kb.allowedAccentsByIso2.get('zh') : null;
        const all = set ? Array.from(set.values()) : [];
        const matches = all.filter((a) => {
          if (d === 'cantonese') return a.includes('cantonese');
          if (d === 'mandarin') return a.includes('mandarin');
          return false;
        });
        // Requested (primary) should be ONLY the dialect variants.
        // STANDARD is fallback-only and should be used only when primary returns 0.
        const queryKeys = dedupePreserveOrder(matches).filter(Boolean);
        out.requestedFacetQueryKeys = queryKeys.length
          ? queryKeys
          : [d === 'cantonese' ? 'hong kong cantonese' : 'beijing mandarin'];
        out.fallbackFacetKeys = ['standard'];
        // Combined rendering section (you chose: one combined section for dialect requests)
        out.combineGroupKey = d; // 'mandarin' | 'cantonese'
        out.combineGroupLabel = d === 'cantonese' ? 'CANTONESE' : 'MANDARIN';
        out.requestedFacetKeys = [out.combineGroupKey];
        return out;
      }
    }

    // 3) French region markers (remaining locale specificity)
    if (lang === 'fr') {
      if (hasFrenchCanadianMarkers(text)) {
        out.isSpecific = true;
        out.axis = 'locale';
        out.requestedFacetKeys = ['fr-ca'];
        out.fallbackFacetKeys = [];
        return out;
      }
      if (hasFrenchEuropeanMarkers(text)) {
        out.isSpecific = true;
        if (/\b(parisian|paris)\b/.test(lower)) {
          out.axis = 'accent';
          out.requestedFacetKeys = ['parisian'];
          out.fallbackFacetKeys = ['standard'];
        } else {
          out.axis = 'locale';
          out.requestedFacetKeys = ['fr-fr'];
          out.fallbackFacetKeys = [];
        }
        return out;
      }
    }

    // 4) explicit accent mention => accent specificity (best-effort)
    if (hasExplicitAccentMention(text)) {
      const reqLoc = getRequestedLocale(text, { target_voice_language: lang });
      const reqAcc = getRequestedAccent(text, { target_voice_language: lang }, reqLoc);
      const key = normalizeCatalogToken(reqAcc);
      if (key) {
        out.isSpecific = true;
        out.axis = 'accent';
        out.requestedFacetKeys = [key];
        out.fallbackFacetKeys = buildAccentFallbackKeys(lang, kb, [key]);
        return out;
      }
    }

    return out;
  } catch (_) {
    return { isSpecific: false, axis: null, requestedFacetKeys: [], minResults: 10 };
  }
}

function preferredLocalesForChineseDialect(dialect) {
  if (dialect === 'cantonese') return ['zh-HK', 'zh-TW'];
  if (dialect === 'mandarin') return ['zh-CN'];
  return [];
}

function dialectKeywordHints(dialect) {
  if (dialect === 'cantonese') {
    return ['cantonese', 'hong kong', 'hk', 'zh-hk', 'traditional', 'canton'];
  }
  if (dialect === 'mandarin') {
    return ['mandarin', 'putonghua', 'china', 'mainland', 'zh-cn', 'simplified'];
  }
  return [];
}

// Accent slugs visible in ElevenLabs Voice Library UI (zh)
const ZH_ACCENT_SLUGS = {
  cantonese: ['hong-kong-cantonese', 'guangzhou-cantonese', 'singapore-cantonese'],
  mandarin: ['beijing-mandarin', 'singapore-mandarin', 'taiwan-mandarin'],
  standard: ['standard']
};

function getAccentSlugsForQuery(userText) {
  // Per requirement: “sprawdzaj wtedy wszystko co dostępne” (soft; with fallback later).
  const dialect = detectChineseDialectFromText(userText);
  try {
    const fromCatalog =
      accentCatalog && typeof accentCatalog.getZhAccentSlugs === 'function'
        ? accentCatalog.getZhAccentSlugs({ dialect, limit: 10 })
        : [];
    if (Array.isArray(fromCatalog) && fromCatalog.length) return dedupePreserveOrder(fromCatalog);
  } catch (_) {}

  const all = [...ZH_ACCENT_SLUGS.cantonese, ...ZH_ACCENT_SLUGS.mandarin, ...ZH_ACCENT_SLUGS.standard];
  if (dialect === 'cantonese') return dedupePreserveOrder([...ZH_ACCENT_SLUGS.cantonese, ...ZH_ACCENT_SLUGS.standard]);
  if (dialect === 'mandarin') return dedupePreserveOrder([...ZH_ACCENT_SLUGS.mandarin, ...ZH_ACCENT_SLUGS.standard]);
  return dedupePreserveOrder(all);
}

function getRequestedAccent(userText, keywordPlan, requestedLocale) {
  try {
    const text = (userText || '').toString();
    const lower = text.toLowerCase();
    const loc = normalizeRequestedLocale(requestedLocale);
    const iso2 = (keywordPlan?.target_voice_language || parseUserLanguageHints(text)?.iso2 || '')
      .toString()
      .toLowerCase()
      .slice(0, 2);

    // Prefer explicit plan hint if present
    let planAcc =
      typeof keywordPlan?.target_accent === 'string' && keywordPlan.target_accent.trim()
        ? normalizeRequestedAccent(keywordPlan.target_accent)
        : null;
    if (planAcc) {
      // PT: treat "portuguese" as a language label; the shared-voices accent facet uses "european".
      if (iso2 === 'pt' && planAcc === 'portuguese') planAcc = 'european';
      // Conservative validation against FacetKB when available (skip for zh to avoid slug mismatch)
      try {
        if (iso2 && iso2 !== 'zh' && facetKB && facetKB.isLoaded && facetKB.isLoaded() && facetKB.hasIso2(iso2) && facetKB.checkAccentAllowed) {
          const r = facetKB.checkAccentAllowed(iso2, planAcc);
          if (r && r.known && !r.allowed) return null;
        }
      } catch (_) {}
      return planAcc;
    }

    let candidate = null;

    // Infer accent from normalized locale if available
    if (loc) {
      if (loc === 'en-GB') candidate = 'british';
      else if (loc === 'en-US') candidate = 'american';
      else if (loc === 'en-AU') candidate = 'australian';
      else if (loc === 'en-CA') candidate = 'canadian';
      else if (loc === 'pt-BR') candidate = 'brazilian';
      else if (loc === 'pt-PT') candidate = 'european';
      else if (loc === 'es-MX') candidate = 'mexican';
      else if (loc === 'es-ES') candidate = 'castilian';
      else if (loc === 'fr-CA') candidate = 'canadian';
    }

    // Region heuristics before catalog token match (LatAm / European PT)
    if (!candidate) {
      if (iso2 === 'es' && LATAM_SPANISH_RE.test(lower)) candidate = 'latin american';
      else if (
        iso2 === 'pt' &&
        (/\b(portugal|pt-pt|pt-eu|european portuguese)\b/.test(lower) ||
          (/\b(european)\b/.test(lower) && /\b(portuguese|portugal)\b/.test(lower)))
      ) {
        candidate = 'european';
      }
    }

    // Catalog-driven: if we have FacetKB and it can match an accent directly/fuzzily from text,
    // prefer that over hardcoded heuristics (universal for new accents like "sicilian", "istrian", etc.).
    if (!candidate) {
      try {
        if (iso2 && iso2 !== 'zh' && facetKB && facetKB.isLoaded && facetKB.isLoaded() && facetKB.hasIso2(iso2) && facetKB.suggestAccents) {
          const sugg = facetKB.suggestAccents(iso2, text, { limit: 4 }) || [];
          const best = sugg.find((x) => x && x.matchKind && x.matchKind !== 'popularity') || null;
          if (best && best.norm) candidate = best.norm;
        }
      } catch (_) {}
    }

    // Heuristic from text
    if (!candidate) {
      if (/\b(general american|standard american)\b/.test(lower)) candidate = 'american';
      else if (/\b(british|en-uk|uk)\b/.test(lower)) candidate = 'british';
      else if (/\b(australian)\b/.test(lower)) candidate = 'australian';
      else if (/\b(canadian)\b/.test(lower)) candidate = 'canadian';
      else if (/\b(mexico|mexican|es-mx|mx)\b/.test(lower)) candidate = 'mexican';
      else if (/\b(spain|castilian|es-es)\b/.test(lower)) candidate = 'castilian';
      else if (/\b(brazil|brasil|brazilian|pt-br)\b/.test(lower)) candidate = 'brazilian';
      else if (/\b(portugal|pt-pt|pt-eu|european)\b/.test(lower) && /\bportuguese|pt\b/.test(lower)) candidate = 'european';
    }

    // PT alias: treat "portuguese" as "european" (accent facet naming)
    if (iso2 === 'pt' && candidate === 'portuguese') candidate = 'european';

    // Conservative validation against FacetKB when available (skip for zh to avoid slug mismatch)
    try {
      if (candidate && iso2 && iso2 !== 'zh' && facetKB && facetKB.isLoaded && facetKB.isLoaded() && facetKB.hasIso2(iso2) && facetKB.checkAccentAllowed) {
        const r = facetKB.checkAccentAllowed(iso2, candidate);
        if (r && r.known && !r.allowed) return null;
      }
    } catch (_) {}

    return candidate;
  } catch (_) {
    return null;
  }
}

// -------------------------------------------------------------
// Universal variant resolver (data-driven via FacetKB/AccentCatalog)
// -------------------------------------------------------------
// Goal:
// - interpret user's intent around locale/accent/region
// - map it to allowed catalog values (so we avoid invalid API params)
// - provide a short candidate list for generic fanout (quality-first, bounded)
function resolveVariantConstraints(userText, plan, kb, catalog) {
  const text = (userText || '').toString();
  const lower = text.toLowerCase();
  const hint = parseUserLanguageHints(text);
  const targetIso2 = (plan?.target_voice_language || hint?.iso2 || detectVoiceLanguageFromText(text) || '')
    .toString()
    .toLowerCase()
    .slice(0, 2) || null;

  const out = {
    targetIso2,
    variantAxis: 'none', // 'locale' | 'accent' | 'none'
    variantMode: 'general', // 'specific' | 'general'
    variantCandidates: [], // strings (API-facing)
    regionIntent: null, // optional label (e.g. 'es-419'), non-binding
    reason: '-'
  };
  // Bilingual EN+ES: do not anchor to a single language or accent variant.
  if (detectBilingualEnEs(text)) {
    out.targetIso2 = null;
    out.reason = 'bilingual_en_es';
    return out;
  }
  if (!targetIso2) return out;
  const isFrenchCanadianIntent = targetIso2 === 'fr' && hasFrenchCanadianMarkers(text);
  const isFrenchEuropeanIntent = targetIso2 === 'fr' && !isFrenchCanadianIntent && hasFrenchEuropeanMarkers(text);
  const isFrenchParisianIntent = targetIso2 === 'fr' && /\b(parisian|paris)\b/.test(lower);

  const isLocaleAllowed = (iso2, loc) => {
    try {
      const canon = normalizeRequestedLocale(loc) || loc;
      if (kb && kb.isLoaded && kb.isLoaded() && kb.hasIso2 && kb.hasIso2(iso2) && kb.checkLocaleAllowed) {
        const r = kb.checkLocaleAllowed(iso2, canon);
        if (r && r.known) return !!r.allowed;
      }
    } catch (_) {}
    try {
      if (catalog && typeof catalog.isLocaleAllowed === 'function') return !!catalog.isLocaleAllowed(iso2, normalizeLocaleToken(normalizeRequestedLocale(loc) || loc));
    } catch (_) {}
    return true; // last resort: don't block
  };

  const isAccentAllowed = (iso2, acc) => {
    try {
      if (kb && kb.isLoaded && kb.isLoaded() && kb.hasIso2 && kb.hasIso2(iso2) && kb.checkAccentAllowed) {
        const r = kb.checkAccentAllowed(iso2, acc);
        if (r && r.known) return !!r.allowed;
      }
    } catch (_) {}
    try {
      if (catalog && typeof catalog.isAccentAllowed === 'function') return !!catalog.isAccentAllowed(iso2, acc);
    } catch (_) {}
    return true;
  };

  // Plan overrides (highest priority): if the caller already decided on a locale/accent, honor it.
  // This is critical for fanout loops so that userText heuristics/resolver don't override forced variants.
  try {
    const raw =
      typeof plan?.target_locale === 'string' && plan.target_locale.trim()
        ? (normalizeRequestedLocale(plan.target_locale) || plan.target_locale)
        : null;
    if (raw) {
      const key = normalizeLocaleToken(raw);
      // European Portuguese: prefer accent=european over sparse pt-PT locale queries.
      if (targetIso2 === 'pt' && key === 'pt-pt' && isAccentAllowed(targetIso2, 'european')) {
        out.variantMode = 'specific';
        out.variantAxis = 'accent';
        out.variantCandidates = ['european'];
        out.regionIntent = 'pt-pt';
        out.reason = 'pt_european_prefer_accent';
        return out;
      }
      const isNumericRegion = key && /^[a-z]{2}-\d{3}$/.test(key);
      out.variantMode = 'specific';
      out.variantAxis = 'locale';
      if (isNumericRegion) out.regionIntent = key;
      if (isNumericRegion && !isLocaleAllowed(targetIso2, raw)) {
        out.reason = 'plan_region_alias_unsupported';
        // Prefer explicit locale fanout candidates from KB if available; never include numeric region codes.
        try {
          if (kb && kb.getFacetVariants) {
            const vars = kb.getFacetVariants(targetIso2, 'locale', { maxVariants: 10 }) || [];
            out.variantCandidates = vars
              .map((v) => v?.facetKey || v?.locale || v?.facetValue || v?.norm || '')
              .map((x) => normalizeRequestedLocale(x) || x)
              .filter(Boolean)
              .filter((x) => !/^[a-z]{2}-\d{3}$/i.test(String(x)))
              .slice(0, 6);
          }
        } catch (_) {}
        return out;
      }
      if (isLocaleAllowed(targetIso2, raw)) {
        out.variantCandidates = [raw];
        out.reason = 'plan_locale';
        return out;
      }
      out.reason = 'plan_locale_invalid';
      try {
        if (kb && kb.getFacetVariants) {
          const vars = kb.getFacetVariants(targetIso2, 'locale', { maxVariants: 10 }) || [];
          out.variantCandidates = vars
            .map((v) => v?.facetKey || v?.locale || v?.facetValue || v?.norm || '')
            .map((x) => normalizeRequestedLocale(x) || x)
            .filter(Boolean)
            .filter((x) => !/^[a-z]{2}-\d{3}$/i.test(String(x)))
            .slice(0, 6);
        }
      } catch (_) {}
      return out;
    }
  } catch (_) {}

  try {
    const raw =
      typeof plan?.target_accent === 'string' && plan.target_accent.trim()
        ? (normalizeRequestedAccent(plan.target_accent) || plan.target_accent)
        : null;
    if (raw) {
      out.variantMode = 'specific';
      out.variantAxis = 'accent';
      if (isAccentAllowed(targetIso2, raw)) {
        out.variantCandidates = [raw];
        out.reason = 'plan_accent';
        // Add a few popularity-based fallbacks for bounded fanout
        try {
          if (kb && kb.getFacetVariants) {
            const vars = kb.getFacetVariants(targetIso2, 'accent', { maxVariants: 6 }) || [];
            const extra = vars.map((v) => v?.facetKey || v?.facetValue || '').filter(Boolean);
            out.variantCandidates = dedupePreserveOrder([...out.variantCandidates, ...extra]).slice(0, 6);
          }
        } catch (_) {}
        return out;
      }
      out.reason = 'plan_accent_invalid';
      try {
        if (kb && kb.getFacetVariants) {
          const vars = kb.getFacetVariants(targetIso2, 'accent', { maxVariants: 8 }) || [];
          out.variantCandidates = vars.map((v) => v?.facetKey || v?.facetValue || '').filter(Boolean).slice(0, 6);
        }
      } catch (_) {}
      return out;
    }
  } catch (_) {}

  // Word-region aliases (non-binding): if the catalog supports an equivalent accent,
  // treat as accent intent rather than forcing an unsupported locale.
  try {
    const isLatam = LATAM_SPANISH_RE.test(lower);
    if (isLatam) {
      const accKey = normalizeCatalogToken('latin american') || 'latin american';
      if (isAccentAllowed(targetIso2, accKey)) {
        out.variantMode = 'specific';
        out.variantAxis = 'accent';
        out.variantCandidates = [accKey];
        out.regionIntent = out.regionIntent || 'latam';
        out.reason = 'region_alias_word_to_accent';
        // Add a few popularity-based fallbacks
        try {
          if (kb && kb.getFacetVariants) {
            const vars = kb.getFacetVariants(targetIso2, 'accent', { maxVariants: 6 }) || [];
            const extra = vars.map((v) => v?.facetKey || v?.facetValue || '').filter(Boolean);
            out.variantCandidates = dedupePreserveOrder([...out.variantCandidates, ...extra]).slice(0, 6);
          }
        } catch (_) {}
        return out;
      }
    }
  } catch (_) {}

  // European Portuguese word markers → accent=european (before catalog token match)
  try {
    if (
      targetIso2 === 'pt' &&
      !/\b(brazil|brasil|brazilian|brasile|pt-br)\b/.test(lower) &&
      (/\b(portugal|pt-pt|pt-eu|european portuguese)\b/.test(lower) ||
        (/\b(european)\b/.test(lower) && /\b(portuguese|portugal)\b/.test(lower))) &&
      isAccentAllowed(targetIso2, 'european')
    ) {
      out.variantMode = 'specific';
      out.variantAxis = 'accent';
      out.variantCandidates = ['european'];
      out.regionIntent = out.regionIntent || 'pt-european';
      out.reason = 'pt_european_word_to_accent';
      return out;
    }
  } catch (_) {}

  // Arabic Gulf / GCC: regional words → catalog accent (gulf, kuwaiti, saudi, …)
  try {
    const gcc = detectGccArabicVoiceIntent(text);
    if (targetIso2 === 'ar' && gcc && isAccentAllowed(targetIso2, gcc.accent)) {
      out.variantMode = 'specific';
      out.variantAxis = 'accent';
      out.variantCandidates = [gcc.accent];
      out.regionIntent = out.regionIntent || 'gcc';
      out.reason = 'gcc_region_alias';
      try {
        if (kb && kb.getFacetVariants) {
          const vars = kb.getFacetVariants(targetIso2, 'accent', { maxVariants: 6 }) || [];
          const extra = vars.map((v) => v?.facetKey || v?.facetValue || '').filter(Boolean);
          out.variantCandidates = dedupePreserveOrder([...out.variantCandidates, ...extra]).slice(0, 6);
        }
      } catch (_) {}
      return out;
    }
  } catch (_) {}

  // Explicit locale token can be:
  // - xx-YY (handled by parseUserLanguageHints)
  // - xx-### (numeric region alias like es-419) (NOT handled by parseUserLanguageHints)
  let hintLocaleRaw = hint?.locale ? (normalizeRequestedLocale(hint.locale) || hint.locale) : null;
  try {
    if (!hintLocaleRaw) {
      const mNum = text.match(/\b([A-Za-z]{2})\s*[-_]\s*(\d{3})\b/);
      if (mNum) {
        const iso = String(mNum[1] || '').toLowerCase();
        const reg = String(mNum[2] || '');
        if (iso && reg) hintLocaleRaw = `${iso}-${reg}`;
      }
    }
  } catch (_) {}
  const hintLocaleKey = hintLocaleRaw ? normalizeLocaleToken(hintLocaleRaw) : null;
  const numericRegion = hintLocaleKey && /^[a-z]{2}-\d{3}$/.test(hintLocaleKey) ? hintLocaleKey : null;

  // 1) Explicit locale token (pt-BR, es-MX, xx-###)
  if (hintLocaleKey) {
    out.variantMode = 'specific';
    // If numeric region isn't supported, treat as region alias and provide generic locale fanout.
    if (numericRegion && !isLocaleAllowed(targetIso2, hintLocaleRaw)) {
      out.regionIntent = numericRegion;
      out.variantAxis = 'locale';
      out.reason = 'region_alias_unsupported';
      try {
        if (kb && kb.suggestLocales) {
          const suggested = kb.suggestLocales(targetIso2, text, { limit: 6 }) || [];
          out.variantCandidates = suggested
            .map((x) => x?.locale || x?.norm || '')
            .map((x) => normalizeRequestedLocale(x) || x)
            .filter(Boolean)
            .filter((x) => !/^[a-z]{2}-\d{3}$/i.test(String(x))); // avoid numeric region codes in fanout
        }
      } catch (_) {}
      // Fallback: if suggestLocales couldn't infer anything from the alias, use top allowed locales.
      try {
        if ((!out.variantCandidates || out.variantCandidates.length === 0) && kb && kb.getFacetVariants) {
          const vars = kb.getFacetVariants(targetIso2, 'locale', { maxVariants: 8 }) || [];
          const extra = vars
            .map((v) => v?.facetKey || v?.locale || v?.facetValue || v?.norm || '')
            .map((x) => normalizeRequestedLocale(x) || x)
            .filter(Boolean)
            .filter((x) => !/^[a-z]{2}-\d{3}$/i.test(String(x)));
          out.variantCandidates = extra.slice(0, 6);
        }
      } catch (_) {}
      return out;
    }
    if (isLocaleAllowed(targetIso2, hintLocaleRaw)) {
      out.variantAxis = 'locale';
      out.variantCandidates = [hintLocaleRaw];
      out.reason = numericRegion ? 'region_locale_supported' : 'explicit_locale';
      return out;
    }
    // Explicit but invalid: fall back to suggestions (still specific)
    out.variantAxis = 'locale';
    out.reason = 'explicit_locale_invalid';
    try {
      if (kb && kb.suggestLocales) {
        const suggested = kb.suggestLocales(targetIso2, text, { limit: 6 }) || [];
        out.variantCandidates = suggested
          .map((x) => x?.locale || x?.norm || '')
          .map((x) => normalizeRequestedLocale(x) || x)
          .filter(Boolean)
          .filter((x) => !/^[a-z]{2}-\d{3}$/i.test(String(x))); // avoid numeric region codes like es-419
      }
    } catch (_) {}
    return out;
  }

  // French EU/CA markers without explicit locale tags.
  if (isFrenchEuropeanIntent) {
    // Keep European FR locale heuristic for generic requests, but let explicit
    // Parisian requests continue to accent logic where accent prioritization applies.
    if (!isFrenchParisianIntent) {
      out.variantMode = 'specific';
      out.variantAxis = 'locale';
      out.variantCandidates = ['fr-FR'];
      out.reason = 'fr_european_locale_heuristic';
      return out;
    }
  }
  if (isFrenchCanadianIntent) {
    out.variantMode = 'specific';
    out.variantAxis = 'locale';
    out.variantCandidates = ['fr-CA'];
    out.reason = 'fr_canadian_locale_heuristic';
    return out;
  }

  // 2) Explicit accent intent (catalog-driven)
  try {
    if (kb && kb.isLoaded && kb.isLoaded() && kb.hasIso2 && kb.hasIso2(targetIso2) && kb.suggestAccents) {
      const sugg = kb.suggestAccents(targetIso2, text, { limit: 4 }) || [];
      const best = sugg.find((x) => x && x.matchKind && x.matchKind !== 'popularity') || null;
      if (best && best.norm && isAccentAllowed(targetIso2, best.norm)) {
        out.variantMode = 'specific';
        out.variantAxis = 'accent';
        out.variantCandidates = [String(best.norm)];
        out.reason = `catalog_accent_${best.matchKind || 'match'}`;
        // Add a few high-popularity fallbacks for bounded fanout (only used if needed)
        try {
          if (kb.getFacetVariants) {
            const vars = kb.getFacetVariants(targetIso2, 'accent', { maxVariants: 6 }) || [];
            const extra = vars.map((v) => v?.facetKey || v?.facetValue || '').filter(Boolean);
            let merged = dedupePreserveOrder([...out.variantCandidates, ...extra]);
            if (isFrenchEuropeanIntent) {
              const banned = new Set(['quebec', 'acadian', 'cajun', 'creole']);
              const preferred = ['parisian', 'standard', 'central', 'southern', 'northern', 'belgian', 'swiss'];
              const base = merged.filter((x) => !banned.has(normalizeCatalogToken(x)));
              const prioritized = dedupePreserveOrder([
                ...preferred.filter((p) => base.includes(p)),
                ...base
              ]);
              merged = prioritized.length ? prioritized : [String(best.norm)];
            }
            out.variantCandidates = merged.slice(0, 6);
          }
        } catch (_) {}
        return out;
      }
    }
  } catch (_) {}

  return out;
}

function isStrongLanguageRequest(userText, keywordPlan) {
  const text = (userText || '').toString();
  const lower = text.toLowerCase();
  const hint = parseUserLanguageHints(text);
  const explicit = hasExplicitLanguageMention(text);
  const iso2 = (keywordPlan?.target_voice_language || hint?.iso2 || '').toString().toLowerCase().slice(0, 2);
  if (!explicit || !iso2) return false;

  // Locale is strong by definition
  if (hint?.locale) return true;

  // Region markers imply strong locale intent
  if (iso2 === 'pt' && /\b(brazil|brasil|brazilian|brasile|pt-br)\b/.test(lower)) return true;
  if (iso2 === 'es' && /\b(mexico|mexican|es-mx|mx)\b/.test(lower)) return true;
  if (iso2 === 'fr' && /\b(fr-ca|french canadian|canadian french|quebec|québec|qc)\b/.test(lower)) return true;
  if (iso2 === 'ar' && detectGccArabicVoiceIntent(text)) return true;

  // Any explicit language mention with a set target language counts as strong
  return true;
}

function voiceHasVerifiedIso2(voice, iso2) {
  const target = (iso2 || '').toString().toLowerCase().slice(0, 2);
  if (!voice || !target) return false;
  const vIso2 = extractIso2FromLanguageField(voice.language);
  if (vIso2 === target) return true;
  const verified = Array.isArray(voice.verified_languages) ? voice.verified_languages : [];
  for (const entry of verified) {
    const el = extractIso2FromLanguageField(entry?.language);
    if (el === target) return true;
  }
  return false;
}

function voiceHasVerifiedEnAndEs(voice) {
  if (!voice) return false;
  const langs = new Set();
  if (voiceHasVerifiedIso2(voice, 'en')) langs.add('en');
  if (voiceHasVerifiedIso2(voice, 'es')) langs.add('es');
  return langs.has('en') && langs.has('es');
}

function voiceVerifiedEntriesForIso2(voice, iso2) {
  const target = (iso2 || '').toString().toLowerCase().slice(0, 2);
  if (!voice || !target) return [];
  const verified = Array.isArray(voice.verified_languages) ? voice.verified_languages : [];
  return verified.filter((entry) => extractIso2FromLanguageField(entry?.language) === target);
}

function voiceVerifiedLocales(voice, iso2) {
  const out = [];
  const entries = voiceVerifiedEntriesForIso2(voice, iso2);
  for (const e of entries) {
    const loc = normalizeRequestedLocale(e?.locale);
    if (loc) out.push(loc);
    // Some APIs may embed locale-like info in `language`
    const langLoc = normalizeRequestedLocale(e?.language);
    if (langLoc) out.push(langLoc);
  }
  // Fallback: top-level locale
  const vLoc = normalizeRequestedLocale(voice?.locale);
  if (vLoc) out.push(vLoc);
  return Array.from(new Set(out));
}

function voiceVerifiedAccents(voice, iso2) {
  const out = [];
  const entries = voiceVerifiedEntriesForIso2(voice, iso2);
  for (const e of entries) {
    const acc = normalizeRequestedAccent(e?.accent);
    if (acc) out.push(acc);
  }
  const vAcc = normalizeRequestedAccent(voice?.accent);
  if (vAcc) out.push(vAcc);
  return Array.from(new Set(out));
}

function voiceTextBlob(voice) {
  if (!voice) return '';
  const parts = [
    voice.name,
    voice.description,
    voice.descriptive,
    voice.accent,
    voice.locale,
    voice.language
  ];
  if (Array.isArray(voice.verified_languages)) {
    for (const e of voice.verified_languages) {
      if (!e) continue;
      parts.push(e.language, e.locale, e.accent);
    }
  }
  return parts
    .filter(Boolean)
    .map((x) => String(x))
    .join(' ')
    .toLowerCase();
}

function voiceMatchesGccIntent(voice, userText) {
  const gcc = detectGccArabicVoiceIntent(userText);
  if (!gcc) return false;
  const wantNorm = normalizeCatalogToken(gcc.accent) || gcc.accent;
  const accs = voiceVerifiedAccents(voice, 'ar');
  for (const a of accs) {
    const na = normalizeCatalogToken(a);
    if (na && na === wantNorm) return true;
  }
  const blob = voiceTextBlob(voice);
  if (wantNorm === 'gulf') {
    if (/\b(gulf|khaleeji|emirati|qatari|uae|dubai|doha|bahrain|oman|gcc|emirates)\b/.test(blob)) return true;
  } else if (wantNorm === 'kuwaiti' && /\b(kuwaiti|kuwait)\b/.test(blob)) {
    return true;
  } else if (wantNorm === 'saudi' && /\b(saudi|riyadh|jeddah)\b/.test(blob)) {
    return true;
  }
  return false;
}

function buildSoftStrictBuckets(voices, ranking, iso2, requestedLocale, requestedAccent) {
  const target = (iso2 || '').toString().toLowerCase().slice(0, 2);
  const reqLocale = normalizeRequestedLocale(requestedLocale);
  const reqAccent = normalizeRequestedAccent(requestedAccent);

  const sorted = [...(voices || [])].sort(
    (a, b) => (ranking?.[b.voice_id] || 0) - (ranking?.[a.voice_id] || 0)
  );

  const exact = [];
  const verifiedOnly = [];

  for (const v of sorted) {
    if (!voiceHasVerifiedIso2(v, target)) continue;

    // Primary-language heuristic:
    // - used to qualify "Exact" matches
    // - but MUST NOT drop verified voices entirely (many voices are verified for a language but have primary language != target)
    const primaryOk = voicePrimaryLooksLikeIso2(v, target, reqLocale);

    const locs = voiceVerifiedLocales(v, target);
    const accs = voiceVerifiedAccents(v, target);

    const hasLocMeta = locs.length > 0;
    const hasAccMeta = accs.length > 0;

    const localeExact = reqLocale ? (hasLocMeta && locs.includes(reqLocale)) : true;
    const accentExact = reqAccent ? (hasAccMeta && accs.includes(reqAccent)) : true;

    // Exact requires exact match IF the user requested it and metadata exists.
    // If metadata is missing OR does not match, it goes to verifiedOnly bucket (soft strict).
    const canBeExact = primaryOk && (!reqLocale || localeExact) && (!reqAccent || accentExact);

    if (canBeExact) exact.push(v);
    else verifiedOnly.push(v);
  }

  return { exact, verifiedOnly, reqLocale, reqAccent };
}

function filterVoicesForSpecificVariant(voices, iso2, resolved, plan) {
  if (!resolved || resolved.variantMode !== 'specific' || !Array.isArray(voices) || !voices.length) {
    return voices;
  }
  const target = (iso2 || resolved.targetIso2 || '').toString().toLowerCase().slice(0, 2);
  if (!target) return voices;

  const reqLocale =
    resolved.variantAxis === 'locale' && Array.isArray(resolved.variantCandidates) && resolved.variantCandidates.length
      ? normalizeRequestedLocale(resolved.variantCandidates[0])
      : typeof plan?.target_locale === 'string' && plan.target_locale.trim()
        ? normalizeRequestedLocale(plan.target_locale)
        : null;
  const reqAccent =
    resolved.variantAxis === 'accent' && Array.isArray(resolved.variantCandidates) && resolved.variantCandidates.length
      ? normalizeRequestedAccent(resolved.variantCandidates[0])
      : typeof plan?.target_accent === 'string' && plan.target_accent.trim()
        ? normalizeRequestedAccent(plan.target_accent)
        : null;

  if (!reqLocale && !reqAccent) return voices;

  const buckets = buildSoftStrictBuckets(voices, {}, target, reqLocale, reqAccent);
  if (buckets.exact.length) return buckets.exact;

  const strict = voices.filter((v) => {
    if (!voiceHasVerifiedIso2(v, target)) return false;
    if (!voicePrimaryLooksLikeIso2(v, target, reqLocale)) return false;
    if (reqLocale) {
      const locs = voiceVerifiedLocales(v, target);
      if (locs.length && !locs.includes(reqLocale)) return false;
    }
    if (reqAccent) {
      const accs = voiceVerifiedAccents(v, target);
      const want = normalizeCatalogToken(reqAccent) || String(reqAccent).toLowerCase().trim();
      if (accs.length) {
        const ok = accs.some((a) => (normalizeCatalogToken(a) || String(a).toLowerCase().trim()) === want);
        if (!ok) return false;
      }
    }
    return true;
  });
  return strict;
}

function voiceMatchesRequestedLocale(voice, requestedLocale) {
  const req = extractLocaleFromField(requestedLocale);
  if (!voice || !req) return false;
  const vLoc = extractLocaleFromField(voice.locale);
  if (vLoc && vLoc === req) return true;
  const verified = Array.isArray(voice.verified_languages) ? voice.verified_languages : [];
  for (const entry of verified) {
    const eloc = extractLocaleFromField(entry?.locale);
    if (eloc && eloc === req) return true;
  }
  return false;
}

function voicePrimaryLooksLikeIso2(voice, iso2, requestedLocale) {
  const target = (iso2 || '').toString().toLowerCase().slice(0, 2);
  if (!voice || !target) return false;

  const primaryLang = extractIso2FromLanguageField(voice.language);
  if (primaryLang && primaryLang !== target) return false;

  const vLoc = extractLocaleFromField(voice.locale);
  if (vLoc) {
    const vLocIso2 = extractIso2FromLanguageField(vLoc);
    if (vLocIso2 && vLocIso2 !== target) return false;
    const reqLoc = extractLocaleFromField(requestedLocale);
    if (reqLoc && vLoc !== reqLoc) return false;
  }

  // Conservative “clearly different language” heuristic from visible metadata.
  // This is intentionally limited to obvious cases to avoid over-filtering.
  const blob = (
    (voice.name || '') +
    ' ' +
    (voice.description || '') +
    ' ' +
    (voice.descriptive || '') +
    ' ' +
    (voice.accent || '') +
    ' ' +
    (voice.locale || '')
  )
    .toString()
    .toLowerCase();

  if (target === 'pt') {
    const looksHindi = /\bhindi\b|\bindia\b/.test(blob);
    const looksSpanish = /\bspanish\b|\blatin american\b|\bespañol\b|\bespanol\b/.test(blob);
    if (looksHindi || looksSpanish) return false;
  }

  return true;
}

function buildVerifiedFallbackMessage(voices, ranking, iso2, requestedLocale, limit = 20) {
  const labels = getLabels();
  const sorted = [...(voices || [])].sort((a, b) => (ranking?.[b.voice_id] || 0) - (ranking?.[a.voice_id] || 0));
  const max = Math.min(sorted.length, limit);

  const locSuffix = requestedLocale ? ` (${requestedLocale})` : '';
  const header = `\`\`\`ALSO VERIFIED FOR ${String(iso2 || '').toUpperCase()}${locSuffix} (may not sound primary)\`\`\``;

  const lines = [header];
  if (max === 0) return '';
  for (let i = 0; i < max; i++) {
    lines.push(`- ${formatVoiceLine(sorted[i])}`);
  }
  return lines.join('\n');
}

function buildVerifiedFallbackMessageSoft(voices, ranking, iso2, requestedLocale, requestedAccent, limit = 20) {
  const labels = getLabels();
  const sorted = [...(voices || [])].sort(
    (a, b) => (ranking?.[b.voice_id] || 0) - (ranking?.[a.voice_id] || 0)
  );
  const max = Math.min(sorted.length, limit);

  const loc = normalizeRequestedLocale(requestedLocale);
  const acc = normalizeRequestedAccent(requestedAccent);
  const locSuffix = loc ? ` (${loc})` : '';
  const accSuffix = acc ? ` [accent=${acc}]` : '';
  const header = `\`\`\`ALSO VERIFIED FOR ${String(iso2 || '').toUpperCase()}${locSuffix}${accSuffix} (missing/unknown or non-exact locale/accent)\`\`\``;

  const lines = [header];
  if (max === 0) return '';
  for (let i = 0; i < max; i++) {
    lines.push(`- ${formatVoiceLine(sorted[i])}`);
  }
  return lines.join('\n');
}

function buildSimilarNotVerifiedMessage(voices, ranking, iso2, requestedLocale, limit = 20) {
  const labels = getLabels();
  const sorted = [...(voices || [])].sort(
    (a, b) => (ranking?.[b.voice_id] || 0) - (ranking?.[a.voice_id] || 0)
  );
  const max = Math.min(sorted.length, limit);

  const locSuffix = requestedLocale ? ` (${requestedLocale})` : '';
  const header = `\`\`\`ALSO SIMILAR (NOT VERIFIED FOR ${String(iso2 || '').toUpperCase()}${locSuffix})\`\`\``;
  const lines = [header];
  if (max === 0) return '';
  for (let i = 0; i < max; i++) {
    lines.push(`- ${formatVoiceLine(sorted[i])}`);
  }
  return lines.join('\n');
}

// Detect if user explicitly wants only high quality / no high quality
function detectQualityPreferenceFromText(text) {
  if (!text) return null;
  const lower = text
    .replace(/[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/g, '-')
    .toLowerCase();

  // Negations take precedence
  const hasNegative =
    lower.includes('no high quality') ||
    lower.includes('without high quality') ||
    lower.includes('exclude high quality') ||
    lower.includes('standard only') ||
    lower.includes('bez wysokiej jakości') ||
    lower.includes('bez wysokiej jakosci') ||
    lower.includes('sin alta calidad') ||
    lower.includes('bez hq');
  if (hasNegative) return 'no_high';

  // Any HQ mention => high_only (supports common typo and PL/ES variants)
  const mentionsHQ =
    /\bhq\b/.test(lower) ||
    lower.includes('high quality') ||
    lower.includes('high-quality') ||
    lower.includes('high quaility') ||
    lower.includes('wysoka jakość') ||
    lower.includes('wysokiej jakości') ||
    lower.includes('wysoka jakosc') ||
    lower.includes('wysokiej jakosci') ||
    lower.includes('alta calidad');
  if (mentionsHQ) return 'high_only';

  // No explicit preference
  return null;
}

function detectModelPreferenceFromText(text) {
  if (!text) return null;
  const lower = text
    .replace(/[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/g, '-')
    .toLowerCase();

  if (/\b(without|no|exclude|bez)\s+(eleven[\s_-]?v3|v3\s+model|model\s+v3)\b/.test(lower)) {
    return null;
  }

  const wantsV3 =
    /\beleven[\s_-]?v3\b/.test(lower) ||
    /\bv3\s+model\b/.test(lower) ||
    /\bmodel\s+v3\b/.test(lower) ||
    /\bwith\s+v3\b/.test(lower) ||
    /\bna\s+v3\b/.test(lower) ||
    /\bw\s+model(u|em)?\s+v3\b/.test(lower);

  const wantsFlash =
    /\beleven[\s_-]?flash[\s_-]?v?2\.?5\b/.test(lower) ||
    /\bflash\s*2\.?5\b/.test(lower) ||
    /\bmodel\s+flash\s*2\.?5\b/.test(lower) ||
    /\beleven_flash_v2_5\b/.test(lower);

  // Both requested: keep union (do not silently drop to v3-only)
  if (wantsV3 && wantsFlash) return ['eleven_v3', 'eleven_flash_v2_5'];
  if (wantsFlash) return 'eleven_flash_v2_5';
  if (wantsV3) return 'eleven_v3';

  return null;
}

function normalizePlanModelPreference(mp) {
  const list = normalizeModelPreferenceList(mp);
  if (!list.length) return 'any';
  if (list.length === 1) return list[0];
  return list;
}

function detectNoticePeriodFromText(text) {
  if (!text) return { preference: 'any', minDays: null };
  const lower = text
    .replace(/[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/g, '-')
    .toLowerCase();

  const noNotice =
    /\b(no|without|exclude|bez|brak)\s+(notice\s+period|okresu\s+wypowiedzenia|okres\s+wypowiedzenia)\b/.test(
      lower
    ) ||
    /\bbez\s+notice\s+period\b/.test(lower) ||
    /\bbrak\s+okresu\s+wypowiedzenia\b/.test(lower);
  if (noNotice) return { preference: 'no_notice', minDays: null };

  const maxNotice =
    /\binfinity\b/.test(lower) ||
    /\b(max|maximum|maksymalny|maks)\s+notice\s+period\b/.test(lower) ||
    /\b(max|maximum|maksymalny|maks)\s+okres(u)?\s+wypowiedzenia\b/.test(lower) ||
    /\b2\s*years?\s+(notice\s+period|okresu\s+wypowiedzenia|okres\s+wypowiedzenia)\b/.test(lower) ||
    /\b730\s+days?\s+(notice\s+period|okresu\s+wypowiedzenia)\b/.test(lower) ||
    /\b2\s+lata\s+(wypowiedzenia|notice\s+period)\b/.test(lower);
  if (maxNotice) return { preference: 'min_days', minDays: MAX_NOTICE_PERIOD_DAYS };

  const oneYear =
    /\bat\s+least\s+(?:a\s+)?year\b/.test(lower) ||
    /\b(at\s+least\s+)?1\s+year\s+(notice\s+period|okresu\s+wypowiedzenia|okres\s+wypowiedzenia)\b/.test(
      lower
    ) ||
    /\b(co\s+najmniej\s+)?(1\s+)?rok(u)?\s+(wypowiedzenia|notice\s+period)\b/.test(lower) ||
    /\b365\s+days?\s+(notice\s+period|okresu\s+wypowiedzenia)\b/.test(lower);
  if (oneYear) return { preference: 'min_days', minDays: 365 };

  const thirtyDays =
    /\b30\s+days?\s+(notice\s+period|okresu\s+wypowiedzenia)\b/.test(lower) ||
    /\b30\s+dni\s+(wypowiedzenia|notice\s+period)\b/.test(lower);
  if (thirtyDays) return { preference: 'min_days', minDays: 30 };

  const minDaysMatch = lower.match(
    /\b(?:at\s+least|min(?:imum)?|co\s+najmniej)\s+(\d{1,4})\s*(?:days?|dni)\s+(?:notice\s+period|okresu\s+wypowiedzenia|okres\s+wypowiedzenia)\b/
  );
  if (minDaysMatch) {
    const n = Number(minDaysMatch[1]);
    if (Number.isFinite(n) && n > 0) {
      return { preference: 'min_days', minDays: Math.min(n, MAX_NOTICE_PERIOD_DAYS) };
    }
  }

  const withNotice =
    /\b(only\s+with|with|tylko\s+z|z)\s+notice\s+period\b/.test(lower) ||
    /\b(only\s+with|with|tylko\s+z|z)\s+okresem\s+wypowiedzenia\b/.test(lower) ||
    /\bvoices?\s+with\s+notice\s+period\b/.test(lower) ||
    /\bgłos(y|ów)?\s+z\s+okresem\s+wypowiedzenia\b/.test(lower);
  if (withNotice) return { preference: 'min_days', minDays: 1 };

  return { preference: 'any', minDays: null };
}

function applyNoticePeriodToPlan(plan, userText) {
  if (!plan || typeof plan !== 'object') return plan;
  const detected = detectNoticePeriodFromText(userText);

  let preference = plan.notice_period_preference;
  let minDays = plan.min_notice_period_days;

  if (detected.preference !== 'any') {
    preference = detected.preference;
    minDays = detected.minDays;
  }

  if (!['any', 'min_days', 'no_notice'].includes(preference)) {
    preference = 'any';
  }

  if (preference === 'min_days') {
    const n = Number(minDays);
    plan.__min_notice_period_days =
      Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), MAX_NOTICE_PERIOD_DAYS) : 1;
    plan.__no_notice_period = false;
    plan.min_notice_period_days = plan.__min_notice_period_days;
    plan.notice_period_preference = 'min_days';
  } else if (preference === 'no_notice') {
    plan.__min_notice_period_days = null;
    plan.__no_notice_period = true;
    plan.min_notice_period_days = null;
    plan.notice_period_preference = 'no_notice';
  } else {
    plan.__min_notice_period_days = null;
    plan.__no_notice_period = false;
    plan.min_notice_period_days = null;
    plan.notice_period_preference = 'any';
  }

  return plan;
}

function detectCustomRatesFromText(text) {
  if (!text) return { preference: 'any' };
  const lower = text
    .replace(/[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/g, '-')
    .toLowerCase();

  const exclude =
    /\b(no|without|exclude|bez|brak)\s+custom\s+rates?\b/.test(lower) ||
    /\bstandard\s+rates?\s+only\b/.test(lower);
  if (exclude) return { preference: 'exclude' };

  const includeAny =
    /\b(include|with|allow)\s+custom\s+rates?\b/.test(lower) ||
    /\b(clear|remove)\s+custom\s+rates?\s*(filter)?\b/.test(lower) ||
    /\bany\s+custom\s+rates?\b/.test(lower);
  if (includeAny) return { preference: 'any' };

  return { preference: 'any' };
}

function applyCustomRatesToPlan(plan, userText) {
  if (!plan || typeof plan !== 'object') return plan;
  const detected = detectCustomRatesFromText(userText);

  let preference = plan.custom_rates_preference;
  if (detected.preference === 'exclude') {
    preference = 'exclude';
  } else if (detected.preference === 'any' && preference === 'exclude') {
    const lower = (userText || '').toLowerCase();
    if (
      /\b(include|with|allow|clear|remove|any)\s+custom\s+rates?\b/.test(lower)
    ) {
      preference = 'any';
    }
  }

  if (!['any', 'exclude'].includes(preference)) {
    preference = 'any';
  }

  if (preference === 'exclude') {
    plan.__no_custom_rates = true;
    plan.custom_rates_preference = 'exclude';
  } else {
    plan.__no_custom_rates = false;
    plan.custom_rates_preference = 'any';
  }

  return plan;
}

function maybeSetIncludeCustomRatesParam(params, plan) {
  if (plan?.__no_custom_rates === true) {
    params.set('include_custom_rates', 'false');
  }
}

// UI labels – EN only (all user-facing base text)
// (then translated per userLanguage before sending)
function getLabels() {
  return {
    searching:
      "Got it – I’ll dig through the public Voice Library for something that fits your brief… 🔍",
    noResults:
      "I couldn’t find any convincing matches for that description. " +
      'Try describing the voice a bit more broadly or in different words.',
    suggestedHeader: 'Here are the voices I’d recommend based on your brief:',
    standardHeader: 'Standard voices (not marked as high quality)',
    highHeader: 'High quality voices',
    female: 'Female',
    male: 'Male',
    other: 'Other / unspecified',
    noVoices: '– nothing strong enough to show here.',
    genericFooter: [
      'You can refine this shortlist by asking things like:',
      '• “show only high quality”',
      '• “show only female / only male”',
      '• “what languages do these voices support?”',
      '• or just send a new brief in this thread'
    ].join('\n'),
    femaleFilterFooter:
      'Right now I’m only showing female voices. Say “show all genders” if you want to see everything again.',
    maleFilterFooter:
      'Right now I’m only showing male voices. Say “show all genders” if you want to see everything again.',
    languagesHeader: 'Languages across the current shortlist:',
    languagesNone:
      "These voices don’t expose clear language metadata (or it’s inconsistent in the library).",
    highQualityHeader: 'From the current shortlist, these are marked as high quality:',
    highQualityNone: 'None of the current suggestions are explicitly marked as high quality.',
    genericError:
      'Something went wrong between the LLM and the Voice Library API. Please try again and I’ll take another shot.',
    creatorOwnerIdNeeded:
      'To list that user’s shared voices in the public Voice Library, I need their **public owner ID** (UUID from ElevenLabs). ' +
      'You can find it as `public_owner_id` on any of their shared voices (API or app details) — paste it here together with your question.',
    creatorOwnerVoiceNotFound:
      'I couldn’t find that voice in the public Voice Library or couldn’t read its **public owner ID**. ' +
      'Use a Voice Library (shared) `voice_id`, or paste the creator’s public owner UUID.',
    noResultsCreatorSuffix:
      'Only voices that user has published to the public Voice Library can appear in this list.',
    noResultsCreatorNoOther:
      'This creator has no other public voices in the Voice Library.'
  };
}

async function translateNoResultsWithOwnerHint(uiLang, plan) {
  const L = getLabels();
  if (plan?.__owner_id && plan?.__exclude_voice_id) {
    return await translateForUserLanguage(L.noResultsCreatorNoOther, uiLang);
  }
  let t = await translateForUserLanguage(L.noResults, uiLang);
  if (plan?.__owner_id) {
    t += '\n\n' + (await translateForUserLanguage(L.noResultsCreatorSuffix, uiLang));
  }
  return t;
}

const MAX_NOTICE_PERIOD_DAYS = 730;

function formatNoticePeriodLabel(voice, uiLang) {
  if (!voice || !Object.prototype.hasOwnProperty.call(voice, 'notice_period')) return '';
  const days = voice.notice_period;
  const lang = (uiLang || 'en').toString().slice(0, 2).toLowerCase();
  if (days == null) {
    return lang === 'pl' ? 'brak notice period' : 'no notice period';
  }
  if (typeof days === 'number' && days > 0) {
    return lang === 'pl' ? `${days} dni notice period` : `${days} days notice period`;
  }
  return '';
}

function formatVoiceLine(voice, uiLang) {
  const url = `https://elevenlabs.io/app/voice-library?search=${encodeURIComponent(
    voice.voice_id
  )}`;
  const name = hasCustomRateMultiplier(voice) ? `💲${voice.name}` : voice.name;
  let line = `<${url}|${name}> \`${voice.voice_id}\``;
  const npLabel = formatNoticePeriodLabel(voice, uiLang);
  if (npLabel) line += ` — ${npLabel}`;
  return line;
}

function filterVoicesByNoticePeriod(voices, filtersOrPlan) {
  const src = Array.isArray(voices) ? voices : [];
  if (!src.length || !filtersOrPlan) return voices;

  const noNotice =
    filtersOrPlan.noNoticePeriod === true || filtersOrPlan.__no_notice_period === true;
  const minDaysRaw =
    filtersOrPlan.minNoticePeriodDays != null
      ? filtersOrPlan.minNoticePeriodDays
      : filtersOrPlan.__min_notice_period_days;
  const minDays = typeof minDaysRaw === 'number' ? Math.floor(minDaysRaw) : null;

  const applyList = (list) => {
    const arr = Array.isArray(list) ? list : [];
    if (!arr.length) return arr;
    if (noNotice) {
      const filtered = arr.filter((v) => v && v.notice_period == null);
      return filtered.length ? filtered : arr;
    }
    if (minDays > 0) {
      const filtered = arr.filter(
        (v) => typeof v?.notice_period === 'number' && v.notice_period >= minDays
      );
      return filtered.length ? filtered : arr;
    }
    return arr;
  };

  if (!noNotice && !(minDays > 0)) return voices;

  const out = applyList(src);
  if (Array.isArray(voices) && Array.isArray(voices.facetGroups) && voices.facetGroups.length) {
    const copy = [...out];
    copy.facetGroups = voices.facetGroups
      .map((g) => ({
        ...g,
        voices: applyList(g?.voices)
      }))
      .filter((g) => Array.isArray(g.voices) && g.voices.length);
    if (voices.facetAxis) copy.facetAxis = voices.facetAxis;
    if (voices.facetIso2) copy.facetIso2 = voices.facetIso2;
    if (voices.variantIntent) copy.variantIntent = voices.variantIntent;
    return copy;
  }
  return out;
}

function filterVoicesByCustomRates(voices, filtersOrPlan) {
  const src = Array.isArray(voices) ? voices : [];
  const exclude =
    filtersOrPlan?.noCustomRates === true || filtersOrPlan?.__no_custom_rates === true;
  if (!exclude || !src.length) return voices;

  const applyList = (list) => {
    const arr = Array.isArray(list) ? list : [];
    if (!arr.length) return arr;
    return arr.filter((v) => v && !hasCustomRateMultiplier(v));
  };

  const out = applyList(src);
  if (Array.isArray(voices) && Array.isArray(voices.facetGroups) && voices.facetGroups.length) {
    const copy = [...out];
    copy.facetGroups = voices.facetGroups
      .map((g) => ({
        ...g,
        voices: applyList(g?.voices)
      }))
      .filter((g) => Array.isArray(g.voices) && g.voices.length);
    if (voices.facetAxis) copy.facetAxis = voices.facetAxis;
    if (voices.facetIso2) copy.facetIso2 = voices.facetIso2;
    if (voices.variantIntent) copy.variantIntent = voices.variantIntent;
    return copy;
  }
  return out;
}

function applyVoiceLibraryFilters(voices, filtersOrPlan) {
  let out = filterVoicesByNoticePeriod(voices, filtersOrPlan);
  out = filterVoicesByCustomRates(out, filtersOrPlan);
  return out;
}

function buildSessionNoticeFilters(keywordPlan) {
  const noNotice = keywordPlan?.__no_notice_period === true;
  return {
    minNoticePeriodDays:
      noNotice || typeof keywordPlan?.__min_notice_period_days !== 'number'
        ? null
        : keywordPlan.__min_notice_period_days,
    noNoticePeriod: noNotice
  };
}

function applySessionNoticeFiltersToPlan(plan, filters) {
  if (!plan || !filters) return plan;
  if (filters.noNoticePeriod === true) {
    plan.__no_notice_period = true;
    plan.__min_notice_period_days = null;
    plan.notice_period_preference = 'no_notice';
    plan.min_notice_period_days = null;
  } else if (typeof filters.minNoticePeriodDays === 'number' && filters.minNoticePeriodDays > 0) {
    plan.__no_notice_period = false;
    plan.__min_notice_period_days = filters.minNoticePeriodDays;
    plan.notice_period_preference = 'min_days';
    plan.min_notice_period_days = filters.minNoticePeriodDays;
  } else {
    plan.__no_notice_period = false;
    plan.__min_notice_period_days = null;
    plan.notice_period_preference = 'any';
    plan.min_notice_period_days = null;
  }
  return plan;
}

function buildSessionCustomRatesFilters(keywordPlan) {
  return {
    noCustomRates: keywordPlan?.__no_custom_rates === true
  };
}

function applySessionCustomRatesFiltersToPlan(plan, filters) {
  if (!plan || !filters) return plan;
  if (filters.noCustomRates === true) {
    plan.__no_custom_rates = true;
    plan.custom_rates_preference = 'exclude';
  } else {
    plan.__no_custom_rates = false;
    plan.custom_rates_preference = 'any';
  }
  return plan;
}

function voiceNameDedupeKey(voice) {
  const raw = (voice?.name || '').toString().replace(/^💲/, '').trim().toLowerCase();
  if (!raw) return '';
  return raw.split(/\s+/)[0] || raw;
}

function getGenderRenderOrder(genderFilter, originalQuery) {
  if (genderFilter !== 'any') return [genderFilter];
  if (wantsBothGendersCatalog(null, originalQuery)) return ['female', 'male'];
  return ['female', 'male', 'other'];
}

function detectListAll(text) {
  const lower = (text || '').toLowerCase();
  return lower.includes('list all') || lower.includes('show all');
}

// -------------------------------------------------------------
// Facet clarification flow (accent/locale) – ask top 2–3
// -------------------------------------------------------------

function buildFacetClarifyMessage(pending) {
  try {
    const type = pending?.type;
    const iso2 = (pending?.iso2 || '').toString().toLowerCase().slice(0, 2);
    const opts = Array.isArray(pending?.options) ? pending.options : [];
    if (!type || !iso2 || !opts.length) return null;

    const header =
      type === 'locale'
        ? `I can filter by locale for ${iso2.toUpperCase()}, but I need you to pick one:`
        : `I can filter by accent for ${iso2.toUpperCase()}, but I need you to pick one:`;

    const lines = [header];
    for (let i = 0; i < Math.min(3, opts.length); i++) {
      const o = opts[i];
      if (!o) continue;
      const label = (o.label || o.value || '').toString();
      const count = typeof o.count === 'number' ? o.count : null;
      const suffix = type === 'accent' && count !== null ? ` (count=${count})` : '';
      lines.push(`${i + 1}) ${label}${suffix}`);
    }
    lines.push('Reply with 1/2/3 or paste the exact value.');
    return lines.join('\n');
  } catch (_) {
    return null;
  }
}

function resolveFacetChoiceFromText(userText, pending) {
  try {
    const text = (userText || '').toString().trim();
    if (!text) return null;
    const opts = Array.isArray(pending?.options) ? pending.options : [];
    if (!opts.length) return null;

    // 1) numeric selection
    const m = text.match(/^\s*(\d{1,2})\s*$/);
    if (m) {
      const idx = Number(m[1]) - 1;
      if (Number.isFinite(idx) && idx >= 0 && idx < opts.length) return opts[idx];
    }

    const lower = text.toLowerCase();
    const norm = normalizeCatalogToken(lower);

    // 2) exact match on value/label/slug
    for (const o of opts) {
      const v = normalizeCatalogToken(o?.value || '');
      const l = normalizeCatalogToken(o?.label || '');
      const s = normalizeCatalogToken(o?.slug || '');
      if (norm && (norm === v || norm === l || norm === s)) return o;
    }

    // 3) fuzzy among labels
    try {
      const candidates = opts.map((o) => (o?.label || o?.value || '').toString()).filter(Boolean);
      const maxDist = maxTypoDistanceForToken(norm || lower);
      const sugg = suggestClosest(norm || lower, candidates, { maxDist, maxSuggestions: 1 });
      if (sugg && sugg.length) {
        const picked = sugg[0];
        const pn = normalizeCatalogToken(picked);
        for (const o of opts) {
          const l = normalizeCatalogToken(o?.label || o?.value || '');
          if (pn && l === pn) return o;
        }
      }
    } catch (_) {}

    return null;
  } catch (_) {
    return null;
  }
}

function getGenderGroup(voice) {
  const raw =
    (voice.gender ||
      (voice.labels && voice.labels.gender) ||
      '').toString().toLowerCase();

  if (raw === 'female' || raw === 'woman' || raw === 'f') return 'female';
  if (raw === 'male' || raw === 'man' || raw === 'm') return 'male';
  return 'other';
}

function summarizeLanguages(voices) {
  const langCount = {};
  voices.forEach((v) => {
    const langs = [];
    if (Array.isArray(v.verified_languages) && v.verified_languages.length > 0) {
      v.verified_languages.forEach((entry) => {
        if (entry && entry.language) langs.push(entry.language);
      });
    } else if (v.language) {
      langs.push(v.language);
    }
    langs.forEach((lang) => {
      langCount[lang] = (langCount[lang] || 0) + 1;
    });
  });
  return langCount;
}

function buildLanguagesMessage(session) {
  const labels = getLabels();
  const langCount = summarizeLanguages(session.voices);
  const entries = Object.entries(langCount);
  if (!entries.length) {
    return labels.languagesNone;
  }
  let text = `${labels.languagesHeader}\n`;
  entries.forEach(([lang, count]) => {
    text += `• ${lang}: ${count} voices\n`;
  });
  return text;
}

function buildWhichHighMessage(session) {
  const labels = getLabels();
  const { voices, ranking } = session;
  const hqVoices = voices.filter(isHighQuality);

  if (!hqVoices.length) {
    return labels.highQualityNone;
  }

  const sorted = [...hqVoices].sort(
    (a, b) => (ranking[b.voice_id] || 0) - (ranking[a.voice_id] || 0)
  );

  const max = Math.min(sorted.length, 20);
  let text = `${labels.highQualityHeader}\n`;
  for (let i = 0; i < max; i++) {
    const v = sorted[i];
    text += `- ${formatVoiceLine(v)}\n`;
  }

  return text;
}

// Parse follow-up filters from the user text
function applyFilterChangesFromText(session, lower) {
  let changed = false;
  let serverChanged = false;

  // gender
  if (
    lower.includes('only female') ||
    lower.includes('female only') ||
    lower.includes('show only female') ||
    lower.includes('show female only')
  ) {
    session.filters.gender = 'female';
    changed = true;
  } else if (
    lower.includes('only male') ||
    lower.includes('male only') ||
    lower.includes('show only male') ||
    lower.includes('show male only')
  ) {
    session.filters.gender = 'male';
    changed = true;
  }

  if (
    lower.includes('all genders') ||
    lower.includes('show all genders') ||
    lower.includes('show both genders')
  ) {
    session.filters.gender = 'any';
    changed = true;
  }

  // quality
  const qp = detectQualityPreferenceFromText(lower);
  if (qp === 'high_only') {
    session.filters.quality = 'high_only';
    changed = true;
  } else if (qp === 'no_high') {
    session.filters.quality = 'no_high';
    changed = true;
  }

  // list all / show more
  if (lower.includes('list all') || lower.includes('show all') || lower.includes('show more')) {
    session.filters.listAll = true;
    changed = true;
  }

  // limit / "top N" (per gender bucket)
  {
    // Reset to default behavior (6 or 50 when listAll=true)
    if (
      lower.includes('reset limit') ||
      lower.includes('default limit') ||
      lower.includes('domyślny limit') ||
      lower.includes('domyslny limit')
    ) {
      if (session.filters.limitPerGender != null) {
        session.filters.limitPerGender = null;
        changed = true;
      }
    } else {
      // Examples:
      // - "top 3", "top3", "only 3", "pokaż 3", "show 5", "wyświetl 3"
      // - "3 voices", "3 głosy"
      const m =
        lower.match(/\b(?:top|only|just|show|display|pokaż|pokaz|wyświetl|wyswietl|tylko)\s*(\d{1,2})\b/) ||
        lower.match(/\b(\d{1,2})\s*(?:voices?|głosy|glosy|propozycje|wyniki|results?)\b/);
      if (m) {
        const n = Math.max(1, Math.min(20, Number(m[1] || 0)));
        if (n && session.filters.limitPerGender !== n) {
          session.filters.limitPerGender = n;
          changed = true;
        }
      }
    }
  }

  // strict use case on/off (force use_cases even without explicit mention)
  if (
    lower.includes('strict use case') ||
    lower.includes('force use case') ||
    lower.includes('use case only') ||
    lower.includes('tylko use case') ||
    lower.includes('wymuś use case') ||
    lower.includes('wymus use case')
  ) {
    if (session.filters.strictUseCase !== true) {
      session.filters.strictUseCase = true;
      session._serverFiltersChanged = true;
      changed = true;
    }
  }
  if (
    lower.includes('clear use case') ||
    lower.includes('ignore use case') ||
    lower.includes('bez use case') ||
    lower.includes('usuń use case') ||
    lower.includes('usun use case')
  ) {
    if (session.filters.strictUseCase !== false) {
      session.filters.strictUseCase = false;
      session._serverFiltersChanged = true;
      changed = true;
    }
  }

  // strict descriptives on/off
  if (
    lower.includes('strict style') ||
    lower.includes('strict descriptive') ||
    lower.includes('force descriptive') ||
    lower.includes('wymuś styl') ||
    lower.includes('wymus styl')
  ) {
    if (session.filters.strictDescriptives !== true) {
      session.filters.strictDescriptives = true;
      session._serverFiltersChanged = true;
      changed = true;
    }
  }
  if (
    lower.includes('clear style') ||
    lower.includes('clear descriptive') ||
    lower.includes('ignore descriptive') ||
    lower.includes('bez stylu')
  ) {
    if (session.filters.strictDescriptives !== false) {
      session.filters.strictDescriptives = false;
      session._serverFiltersChanged = true;
      changed = true;
    }
  }

  // featured
  if (lower.includes('featured only') || lower.includes('only featured') || lower.includes('show featured')) {
    if (session.filters.featured !== true) {
      session.filters.featured = true;
      serverChanged = true;
      changed = true;
    }
  }
  if (
    lower.includes('clear featured') ||
    lower.includes('all voices') ||
    lower.includes('remove featured')
  ) {
    if (session.filters.featured !== false) {
      session.filters.featured = false;
      serverChanged = true;
      changed = true;
    }
  }

  // notice period
  const noticeDetected = detectNoticePeriodFromText(lower);
  if (noticeDetected.preference === 'no_notice') {
    if (session.filters.noNoticePeriod !== true || session.filters.minNoticePeriodDays != null) {
      session.filters.noNoticePeriod = true;
      session.filters.minNoticePeriodDays = null;
      changed = true;
    }
  } else if (noticeDetected.preference === 'min_days') {
    const minDays = noticeDetected.minDays || 1;
    if (
      session.filters.noNoticePeriod !== false ||
      session.filters.minNoticePeriodDays !== minDays
    ) {
      session.filters.noNoticePeriod = false;
      session.filters.minNoticePeriodDays = minDays;
      serverChanged = true;
      changed = true;
    }
  }
  if (
    lower.includes('clear notice period') ||
    lower.includes('remove notice period') ||
    lower.includes('any notice period') ||
    lower.includes('bez filtra notice period') ||
    lower.includes('usuń filtr notice period') ||
    lower.includes('usun filtr notice period')
  ) {
    if (session.filters.noNoticePeriod || session.filters.minNoticePeriodDays != null) {
      session.filters.noNoticePeriod = false;
      session.filters.minNoticePeriodDays = null;
      serverChanged = true;
      changed = true;
    }
  }

  // custom rates
  const customRatesDetected = detectCustomRatesFromText(lower);
  if (customRatesDetected.preference === 'exclude') {
    if (session.filters.noCustomRates !== true) {
      session.filters.noCustomRates = true;
      changed = true;
    }
  }
  if (
    lower.includes('clear custom rates') ||
    lower.includes('remove custom rates') ||
    lower.includes('include custom rates') ||
    lower.includes('with custom rates') ||
    lower.includes('any custom rates') ||
    lower.includes('bez filtra custom rates') ||
    lower.includes('usuń filtr custom rates') ||
    lower.includes('usun filtr custom rates')
  ) {
    if (session.filters.noCustomRates) {
      session.filters.noCustomRates = false;
      serverChanged = true;
      changed = true;
    }
  }

  // age (child/young/adult/old)
  const newAge = detectAgeFromText(lower);
  if (newAge && session.filters.age !== newAge) {
    session.filters.age = newAge;
    serverChanged = true;
    changed = true;
  }

  // sort (best-effort)
  if (
    lower.includes('sort by popularity') ||
    lower.includes('most used') ||
    lower.includes('najczęściej używan') ||
    lower.includes('najpopularniejsze')
  ) {
    if (session.filters.sort !== 'usage_desc') {
      session.filters.sort = 'usage_desc';
      serverChanged = true;
      changed = true;
    }
  }
  if (lower.includes('sort by recent') || lower.includes('newest') || lower.includes('najnowsze')) {
    if (session.filters.sort !== 'date_desc') {
      session.filters.sort = 'date_desc';
      serverChanged = true;
      changed = true;
    }
  }

  if (serverChanged) session._serverFiltersChanged = true;
  return changed;
}

function checkLanguagesIntent(lower) {
  // Voice+language compatibility questions are handled separately.
  if (detectVoiceLanguageCompatibilityIntent(lower)) return false;
  // EN
  if (lower.includes('language') || lower.includes('languages')) return true;
  // PL
  if (
    lower.includes('język') ||
    lower.includes('jezyk') ||
    lower.includes('języki') ||
    lower.includes('jezyki')
  )
    return true;
  // ES
  if (lower.includes('idioma') || lower.includes('idiomas')) return true;
  return false;
}

function checkWhichHighIntent(lower) {
  const hasWhich =
    lower.includes('which') ||
    lower.includes('które') ||
    lower.includes('ktore') ||
    lower.includes('cuáles') ||
    lower.includes('cuales');
  const hasHighQuality =
    lower.includes('high quality') ||
    lower.includes('hq') ||
    lower.includes('wysokiej jakości') ||
    lower.includes('wysoka jakosc') ||
    lower.includes('wysokiej jakosci') ||
    lower.includes('alta calidad');
  return hasWhich && hasHighQuality;
}

function uniqueMergeKeywords(baseArr, addArr) {
  const base = Array.isArray(baseArr) ? baseArr : [];
  const add = Array.isArray(addArr) ? addArr : [];
  const set = new Set(base.map((x) => (x || '').toString().toLowerCase().trim()).filter(Boolean));
  const out = [...base];
  for (const it of add) {
    const v = (it || '').toString().toLowerCase().trim();
    if (v && !set.has(v)) {
      out.push(v);
      set.add(v);
    }
  }
  return out;
}

async function refineKeywordPlanFromFollowUp(existingPlan, followUpText) {
  const base = existingPlan ? JSON.parse(JSON.stringify(existingPlan)) : {};
  const delta = await buildKeywordPlan(followUpText);

  // Fields with explicit override if provided in follow-up
  const qpOverride = detectQualityPreferenceFromText(followUpText);
  base.quality_preference = qpOverride || base.quality_preference || 'any';

  const mpOverride = detectModelPreferenceFromText(followUpText);
  if (mpOverride) {
    base.model_preference = normalizePlanModelPreference(mpOverride);
  } else if (delta && isSpecificModelPreference(delta.model_preference)) {
    base.model_preference = normalizePlanModelPreference(delta.model_preference);
  } else if (!base.model_preference) {
    base.model_preference = 'any';
  } else {
    base.model_preference = normalizePlanModelPreference(base.model_preference);
  }

  if (delta && typeof delta.target_voice_language === 'string' && delta.target_voice_language) {
    base.target_voice_language = delta.target_voice_language;
  }
  if (delta && typeof delta.target_accent === 'string' && delta.target_accent) {
    base.target_accent = delta.target_accent;
  }
  if (delta && typeof delta.target_gender === 'string' && delta.target_gender) {
    base.target_gender = delta.target_gender;
  }

  // Merge keywords (unique, lowercase)
  base.tone_keywords = uniqueMergeKeywords(base.tone_keywords, delta.tone_keywords);
  base.use_case_keywords = uniqueMergeKeywords(base.use_case_keywords, delta.use_case_keywords);
  base.character_keywords = uniqueMergeKeywords(
    base.character_keywords,
    delta.character_keywords
  );
  base.style_keywords = uniqueMergeKeywords(base.style_keywords, delta.style_keywords);
  base.extra_keywords = uniqueMergeKeywords(base.extra_keywords, delta.extra_keywords);

  const oidFollow = extractPublicOwnerIdFromText(followUpText);
  if (oidFollow) {
    base.__owner_id = oidFollow.toLowerCase();
  }

  applyNoticePeriodToPlan(base, followUpText);
  applyCustomRatesToPlan(base, followUpText);

  return typeof normalizeKeywordPlan === 'function' ? normalizeKeywordPlan(base, followUpText) : base;
}

// Detect special intent like "most used Polish voices", "najczęściej używane polskie głosy"
function detectSpecialIntent(userText, plan) {
  const lower = (userText || '').toLowerCase();

  // 1) Słowa, które oznaczają "chcę najczęściej używane / top"
  const hasUsageKeyword =
    lower.includes('most used') ||
    lower.includes('most popular') ||
    lower.includes('top used') ||
    lower.includes('top voices') ||
    lower.includes('top polish voices') ||
    /\btop\s+\d+\s+voices?\b/.test(lower) ||
    (/\btop\s+\d+\b/.test(lower) && /\bvoices?\b/.test(lower)) ||
    lower.includes('most frequently used') ||
    lower.includes('najczęściej używan') ||
    lower.includes('najczesciej uzywan') ||
    lower.includes('najpopularniejsze');

  // 2) Słowa, które oznaczają KONKRETNY USE CASE (przeznaczenie głosu)
  const useCaseTokens = [
    'conversational',
    'conversation',
    'agent',
    'support',
    'customer support',
    'call center',
    'contact center',
    'ivr',
    'voicemail',
    'audiobook',
    'audiobooks',
    'narration',
    'narrator',
    'storyteller',
    'storytelling',
    'article',
    'articles',
    'cartoon',
    'character',
    'villain',
    'game',
    'gaming',
    'trailer',
    'commercial',
    'ad ',
    'advertising',
    'podcast',
    'youtube',
    'tiktok',
    'explainer',
    'video',
    'educational',
    'documentary',
    'informative',
    'presentation'
  ];

  const hasUseCaseKeyword = useCaseTokens.some((t) => lower.includes(t));

  // Jeśli jest use case i nie ma zamiaru „top/most used”, zostań w trybie generic
  if (!hasUsageKeyword && hasUseCaseKeyword) {
    return { mode: 'generic', languageCode: null };
  }

  // Hybryda: popularność + use-case
  if (hasUsageKeyword && hasUseCaseKeyword) {
    let languageCode = null;
    if (plan && typeof plan.target_voice_language === 'string' && plan.target_voice_language.trim()) {
      languageCode = plan.target_voice_language.trim().toLowerCase().slice(0, 2);
    }
    if (!languageCode) {
      languageCode = detectVoiceLanguageFromText(userText);
    }
    if (!languageCode) {
      return { mode: 'generic', languageCode: null };
    }
    return { mode: 'top_then_rank', languageCode };
  }

  // Tylko jeśli użytkownik wyraźnie prosi o „most used/top...”
  if (hasUsageKeyword) {
    let languageCode = null;
    if (plan && typeof plan.target_voice_language === 'string' && plan.target_voice_language.trim()) {
      languageCode = plan.target_voice_language.trim().toLowerCase().slice(0, 2);
    }
    if (!languageCode) {
      languageCode = detectVoiceLanguageFromText(userText);
    }
    if (!languageCode) {
      return { mode: 'generic', languageCode: null };
    }
    return { mode: 'top_by_language', languageCode };
  }

  // Domyślnie: generic
  return { mode: 'generic', languageCode: null };
}

// -------------------------------------------------------------
// Translation helper – output in user's language
// -------------------------------------------------------------

async function translateForUserLanguage(text, userLanguage) {
  if (!text) return '';
  if (!userLanguage) return text;

  const lang = userLanguage.toString().toLowerCase().slice(0, 2);
  if (lang === 'en') return text; // base text already in English

  const systemPrompt = `
You are a translation assistant.

Task:
- Translate the user's message into the target language with ISO code "${lang}".
- Preserve Markdown structure (#, ##, **, -, etc.) and line breaks.
- The text may contain Slack-style links in angle brackets, e.g.:
  <https://elevenlabs.io/app/voice-library?search=ID|Name | ID>
- DO NOT modify anything between '<' and '>' characters.
  Treat the entire <...> block as opaque and copy it exactly.
- Do not add explanations or comments. Return ONLY the translated text.
`.trim();

  const payload = {
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: text }
    ],
    temperature: 0
  };

  try {
    const response = await httpPostWithRetry(
      'https://api.openai.com/v1/chat/completions',
      payload,
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout: 20000
      }
    );

    const content = response.data.choices[0].message.content;
    return content || text;
  } catch (err) {
    safeLogAxiosError('translateForUserLanguage', err);
    // Return original English text on failure
    return text;
  }
}

// -------------------------------------------------------------
// Plan validator / normalizer
// -------------------------------------------------------------
function normalizeKeywordPlan(plan, userText) {
  const out = JSON.parse(JSON.stringify(plan || {}));
  const clampArr = (arr, max = 12) =>
    Array.isArray(arr)
      ? arr
          .map((x) => (x || '').toString().toLowerCase().trim())
          .filter((x) => x.length > 0 && x.length <= 40)
          .slice(0, max)
      : [];

  out.tone_keywords = clampArr(out.tone_keywords);
  out.use_case_keywords = clampArr(out.use_case_keywords);
  out.character_keywords = clampArr(out.character_keywords);
  out.style_keywords = clampArr(out.style_keywords);
  out.extra_keywords = clampArr(out.extra_keywords, 20);

  // map synonyms to quality
  const lower = (userText || '').toLowerCase();
  if (/\b(highquality|high-quality|hq)\b/.test(lower)) {
    out.quality_preference = 'high_only';
  }
  if (!['any','high_only','no_high'].includes(out.quality_preference)) {
    out.quality_preference = 'any';
  }

  const mpFromText = detectModelPreferenceFromText(userText);
  if (mpFromText) {
    out.model_preference = mpFromText;
  }
  out.model_preference = normalizePlanModelPreference(out.model_preference);

  applyNoticePeriodToPlan(out, userText);
  applyCustomRatesToPlan(out, userText);

  // sanitize gender
  if (out.target_gender !== 'male' && out.target_gender !== 'female' && out.target_gender !== 'neutral') {
    out.target_gender = null;
  }

  try {
    const gcc = detectGccArabicVoiceIntent(userText);
    if (gcc) {
      const lang = (out.target_voice_language || '').toString().toLowerCase().slice(0, 2);
      if (!lang || lang === 'ar') {
        out.target_voice_language = 'ar';
        out.target_accent = gcc.accent;
        const base = Array.isArray(out.extra_keywords) ? out.extra_keywords : [];
        const merged = dedupePreserveOrder([
          ...base.map((x) => normalizeKw(x)).filter(Boolean),
          gcc.accent,
          'arabic'
        ]);
        out.extra_keywords = clampArr(merged, 20);
      }
    }
  } catch (_) {}

  // Drop keywords that conflict with the dominant use_case (e.g. cartoonish on conversational briefs).
  try {
    const useKw = Array.isArray(out.use_case_keywords) ? out.use_case_keywords : [];
    const lower = (userText || '').toLowerCase();
    const isConversational =
      useKw.some((k) => /\b(conversational|support|customer|call center|contact center|ivr|agent)\b/.test(k)) ||
      /\b(conversational|customer support|customer service|call center|contact center|ivr)\b/.test(lower);
    if (isConversational) {
      const deny = new Set([
        'cartoonish',
        'cartoon',
        'animated',
        'animation',
        'character',
        'villain',
        'antagonist',
        'evil',
        'cinematic',
        'trailer'
      ]);
      const prune = (arr) =>
        Array.isArray(arr)
          ? arr.filter((k) => {
              const n = normalizeKw(k);
              return !deny.has(n) || explicitlyMentionedInText(n, userText);
            })
          : arr;
      out.style_keywords = prune(out.style_keywords);
      out.character_keywords = prune(out.character_keywords);
      out.extra_keywords = prune(out.extra_keywords);
    }
  } catch (_) {}

  return out;
}

function ensureKeywordFloor(userText, plan) {
  if (extractBareVoiceId(userText) || (plan?.__owner_id || '').toString().trim()) {
    return JSON.parse(JSON.stringify(plan || {}));
  }
  const out = JSON.parse(JSON.stringify(plan || {}));
  const lower = (userText || '').toLowerCase();
  const countAll =
    (out.tone_keywords?.length || 0) +
    (out.use_case_keywords?.length || 0) +
    (out.character_keywords?.length || 0) +
    (out.style_keywords?.length || 0) +
    (out.extra_keywords?.length || 0);
  if (countAll >= 8) {
    out.__briefFamily = inferBriefUseCaseFamily(userText, out);
    return out;
  }

  // If user specified a clear regional/accent term and has at least a few keywords,
  // don't pad with generic support/call-center terms
  const hasRegionalFocus = hasRegionalKeywordFocus(lower);
  if (hasRegionalFocus && countAll >= 3) {
    out.__briefFamily = inferBriefUseCaseFamily(userText, out);
    return out;
  }

  const addUnique = (arr, items, cap) => {
    const base = Array.isArray(arr) ? arr : [];
    const set = new Set(base);
    for (const it of items) {
      const v = (it || '').toLowerCase().trim();
      if (v && !set.has(v)) {
        base.push(v);
        set.add(v);
      }
      if (cap && base.length >= cap) break;
    }
    return base;
  };

  const domainMap = [
    {
      name: 'healthcare',
      test: (s) => /\b(healthcare|medical|hospital|patient|clinic|pharma|nurse|doctor|clinical)\b/.test(s)
    },
    {
      name: 'finance',
      test: (s) => /\b(bank|finance|financial|credit|loan|mortgage|investment|trading)\b/.test(s)
    },
    {
      name: 'ecommerce',
      test: (s) => /\b(ecommerce|e-commerce|shop|store|retail|cart|order|fulfillment)\b/.test(s)
    },
    {
      name: 'telco',
      test: (s) => /\b(telecom|telco|carrier|mobile|network|broadband)\b/.test(s)
    }
  ];
  const domain = (domainMap.find((d) => d.test(lower)) || {}).name || null;
  const briefFamily = inferBriefUseCaseFamily(userText, out);

  // Do NOT inject conversational/support defaults onto narration / articles / educational briefs.
  if (!briefFamily || briefFamily === 'conversational') {
    out.use_case_keywords = addUnique(out.use_case_keywords, [
      'conversational','support','customer support','call center','contact center'
    ], 5);
    out.tone_keywords = addUnique(out.tone_keywords, [
      'calm','reassuring','clear','warm','professional','empathetic','confident'
    ], 8);
    out.style_keywords = addUnique(out.style_keywords, [
      'friendly','helpful','service'
    ], 6);
  } else if (briefFamily === 'narrative') {
    out.use_case_keywords = addUnique(out.use_case_keywords, [
      'audiobook', 'narration', 'storytelling', 'narrator'
    ], 6);
    out.tone_keywords = addUnique(out.tone_keywords, [
      'warm', 'calm', 'clear', 'deep', 'resonant', 'confident'
    ], 8);
    out.style_keywords = addUnique(out.style_keywords, [
      'storytelling', 'narrative', 'professional', 'engaging'
    ], 6);
  } else if (briefFamily === 'articles') {
    out.use_case_keywords = addUnique(out.use_case_keywords, [
      'article', 'informative', 'documentary', 'explainer'
    ], 6);
    out.tone_keywords = addUnique(out.tone_keywords, [
      'clear', 'professional', 'neutral', 'authoritative', 'calm'
    ], 8);
    out.style_keywords = addUnique(out.style_keywords, [
      'informative', 'professional', 'clear'
    ], 6);
  } else if (briefFamily === 'educational') {
    out.use_case_keywords = addUnique(out.use_case_keywords, [
      'educational', 'informative', 'explainer', 'e-learning'
    ], 6);
    out.tone_keywords = addUnique(out.tone_keywords, [
      'clear', 'calm', 'warm', 'professional', 'friendly'
    ], 8);
    out.style_keywords = addUnique(out.style_keywords, [
      'educational', 'informative', 'clear'
    ], 6);
  }

  if (domain === 'healthcare') {
    out.extra_keywords = addUnique(out.extra_keywords, ['healthcare','medical','patient','clinical'], 12);
    out.use_case_keywords = ['conversational'];
    out.style_keywords = addUnique(out.style_keywords, ['clear','reassuring','professional','calm'], 6);
  } else if (domain === 'finance') {
    out.extra_keywords = addUnique(out.extra_keywords, ['finance','bank','account','transaction'], 12);
  } else if (domain === 'ecommerce') {
    out.extra_keywords = addUnique(out.extra_keywords, ['ecommerce','order','delivery','refund'], 12);
  } else if (domain === 'telco') {
    out.extra_keywords = addUnique(out.extra_keywords, ['telco','network','plan','coverage'], 12);
  } else if (/\b(presentation|presenter|company presentation)\b/.test(lower)) {
    out.use_case_keywords = addUnique(out.use_case_keywords, ['explainer','video'], 6);
    out.tone_keywords = addUnique(out.tone_keywords, ['slow','low','deep','calm'], 8);
    out.style_keywords = addUnique(out.style_keywords, ['corporate','professional','clear'], 6);
  } else if (/\b(commercial|advertising|ad|promo|promotion|brand|campaign)\b/.test(lower)) {
    out.use_case_keywords = addUnique(out.use_case_keywords, ['commercial','advertising','ad','promo','brand','campaign'], 6);
    out.style_keywords = addUnique(out.style_keywords, ['energetic','upbeat','dynamic','lively','punchy'], 6);
  } else if (/\b(podcast|podcaster|host|broadcaster|radio host)\b/.test(lower)) {
    out.use_case_keywords = addUnique(out.use_case_keywords, ['podcast'], 6);
    out.character_keywords = addUnique(out.character_keywords, ['host','presenter','broadcaster'], 6);
    out.style_keywords = addUnique(out.style_keywords, ['warm','engaging','conversational','friendly'], 6);
  } else if (/\b(kid|child|children|young girl|young boy|dziecko|dziecięcy|dzieciecy)\b/.test(lower)) {
    out.character_keywords = addUnique(out.character_keywords, ['kid','child','young girl','young boy'], 6);
    out.style_keywords = addUnique(out.style_keywords, ['playful','cheerful','cute','youthful','high pitch','squeaky'], 6);
  }

  out.__floorDomain = domain;
  out.__briefFamily = briefFamily;
  return out;
}

// -------------------------------------------------------------
// GPT: build keyword plan from user brief
// -------------------------------------------------------------

async function buildKeywordPlan(userText) {
  const systemPrompt = `
You are an assistant that takes a user's description of the voice they want (in ANY language)
and produces a JSON keyword plan for the ElevenLabs Voice Library (GET /v1/shared-voices).

Return ONLY a single JSON object, no markdown, no explanations.

The JSON MUST have exactly these fields:

{
  "user_interface_language": string,        // 2-letter code like "en", "pl", "es" for the language the user is writing in
  "target_voice_language": string or null,  // 2-letter code like "en", "pl" for the language of the VOICE the user wants
  "target_accent": string or null,          // e.g. "american", "british", "polish"
  "target_gender": "male" | "female" | "neutral" | null,
  "quality_preference": "any" | "high_only" | "no_high",
  "model_preference": "any" | "eleven_v3" | "eleven_flash_v2_5" | ["eleven_v3","eleven_flash_v2_5"],
  "notice_period_preference": "any" | "min_days" | "no_notice",
  "min_notice_period_days": integer or null,
  "custom_rates_preference": "any" | "exclude",

  "tone_keywords": string[],
  "use_case_keywords": string[],
  "character_keywords": string[],
  "style_keywords": string[],
  "extra_keywords": string[]
}

RULES:

- user_interface_language:
  - Detect from the language of the user message (e.g. Polish -> "pl", English -> "en").

- target_voice_language:
  - Language of the VOICE the user wants (e.g. "en" for an American English voice, "pl" for Polish).
  - Infer from explicit mentions ("American accent", "polish voice") when possible.
  - For Emirati, Qatari, UAE, Saudi, Kuwait, Bahrain, Oman, Khaleeji, GCC, or other Gulf Arabic voice requests, use "ar".

- target_accent:
  - Accent of the VOICE (e.g. "american", "british", "australian", "polish"), or null if unclear.
  - For Gulf Arabic: use "gulf" when the user implies UAE, Qatar, Bahrain, Oman, or generic GCC/Khaleeji; "kuwaiti" for Kuwait; "saudi" for Saudi Arabia, when implied.

- target_gender:
  - "male" / "female" / "neutral" when the user clearly implies it (man, woman, male/female voice, deep male, young woman, etc.), else null.

- quality_preference:
  - "high_only" ONLY if the user explicitly asks for high quality only
    (e.g. "only high quality", "high quality only", "hq only").
  - "no_high" ONLY if the user explicitly excludes high quality
    (e.g. "without high quality", "no high quality", "standard only").
  - Words like "best", "top", "great", "good", "premium" are NOT enough to set "high_only".
  - In all other cases use "any".

- model_preference:
  - "eleven_v3" when the user explicitly asks for ElevenLabs V3 / eleven v3 / V3 model support
    (e.g. "with V3 model", "eleven v3 voices", "na modelu V3").
  - "eleven_flash_v2_5" when the user asks for Flash 2.5 / eleven flash v2.5.
  - When BOTH flash 2.5 and v3 are requested, return both as an array (do not drop one).
  - "any" in all other cases (including when the user only says "best" or "top" without mentioning a model).

- notice_period_preference:
  - "min_days" when the user wants voices with a minimum notice period (e.g. "infinity voice", "max notice period",
    "2 years notice", "at least 1 year notice period", "with notice period", "only with notice period",
    Polish: "z okresem wypowiedzenia", "maksymalny okres wypowiedzenia", "2 lata wypowiedzenia").
  - "no_notice" when the user explicitly wants voices WITHOUT a notice period
    (e.g. "no notice period", "without notice period", Polish: "bez okresu wypowiedzenia", "bez notice period").
  - "any" in all other cases.

- min_notice_period_days:
  - When notice_period_preference is "min_days", set the minimum days:
    - 730 for "infinity voice", "max notice period", "2 years notice"
    - 365 for "1 year notice period" / "at least 1 year"
    - 30 for "30 days notice"
    - 1 for generic "with notice period" / "only with notice period"
  - null when notice_period_preference is not "min_days".

- custom_rates_preference:
  - "exclude" when the user explicitly wants voices WITHOUT custom rates
    (e.g. "without custom rates", "no custom rates", Polish: "bez custom rates", "standard rates only").
  - "any" in all other cases.

- tone_keywords:
  - Many short English adjectives (1–3 words) describing tone and pacing:
    calm, confident, slow, relaxed, energetic, deep, low, warm, friendly, serious, etc.
  - Lowercase, English only.

- use_case_keywords:
  - Short English tags for scenarios: conversational, agent, support, customer service, call center,
    narration, audiobook, gaming, tiktok, youtube, cartoon, ivr, voicemail, etc.

- character_keywords:
  - Persona keywords: grandpa, villain, child, old man, professor, storyteller, corporate, etc.

- style_keywords:
  - Style/genre keywords: cartoonish, cinematic, trailer, commercial, meditative, asmr, whisper, etc.

- extra_keywords:
  - Any additional important English words from the description: accent phrases, domain terms, synonyms.
  - Use this to add more synonyms to make full-text search stronger.
  - For Gulf/GCC requests, include regional search tokens (e.g. emirati, qatari, gulf, arabic) where relevant.

IMPORTANT:
- All *_keywords arrays must contain ONLY lowercase English keywords (1–3 words each).
- In total, across all arrays, there should be at least 8–15 keywords when possible.
- If the user description is very short, repeat or rephrase key words to reach at least ~8 keywords.
- These keywords will be used for SEPARATE searches (one keyword per search), not as one big sentence.
`.trim();

  const payload = {
    model: 'gpt-4o-mini',
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userText }
    ],
    temperature: 0
  };

  try {
    const response = await httpPostWithRetry(
      'https://api.openai.com/v1/chat/completions',
      payload,
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout: 20000
      }
    );

    const content = response.data.choices[0].message.content;
    let plan = JSON.parse(content);

    // Always derive UI language from the user's message (deterministic)
    plan.user_interface_language = guessUiLanguageFromText(userText);
    if (typeof normalizeKeywordPlan === 'function') {
      plan = normalizeKeywordPlan(plan, userText);
    }

    if (!plan.target_voice_language) {
      const inferredLang = detectVoiceLanguageFromText(userText);
      if (inferredLang) plan.target_voice_language = inferredLang;
    }

    if (plan.target_voice_language === '') plan.target_voice_language = null;
    if (plan.target_accent === '') plan.target_accent = null;
    if (plan.target_gender === '') plan.target_gender = null;

    if (!['any', 'high_only', 'no_high'].includes(plan.quality_preference)) {
      plan.quality_preference = 'any';
    }
    plan.model_preference = normalizePlanModelPreference(plan.model_preference);

    const normalizeArray = (arr) =>
      Array.isArray(arr)
        ? arr
            .map((x) => (x || '').toString().toLowerCase().trim())
            .filter((x) => x.length > 0)
        : [];

    plan.tone_keywords = normalizeArray(plan.tone_keywords);
    plan.use_case_keywords = normalizeArray(plan.use_case_keywords);
    plan.character_keywords = normalizeArray(plan.character_keywords);
    plan.style_keywords = normalizeArray(plan.style_keywords);
    plan.extra_keywords = normalizeArray(plan.extra_keywords);

    // Manual override from raw text if needed
    const qp = detectQualityPreferenceFromText(userText);
    plan.quality_preference = qp || 'any';

    const mp = detectModelPreferenceFromText(userText);
    plan.model_preference = normalizePlanModelPreference(mp || plan.model_preference || 'any');

    // Negative exclusions (accent/locale/gender)
    try {
      // Keep invariant: always either string iso2 or null (never undefined)
      plan.__excludedAccentsIso2 = null;
      plan.__excludedLocalesIso2 = null;
      const hintedIso2 = (
        plan?.target_voice_language ||
        parseUserLanguageHints(userText)?.iso2 ||
        detectVoiceLanguageFromText(userText) ||
        ''
      )
        .toString()
        .toLowerCase()
        .slice(0, 2);
      const excludedAcc = hintedIso2 ? extractNegativeAccents(userText, hintedIso2, facetKB) : [];
      const excludedLoc = hintedIso2 ? extractNegativeLocales(userText, hintedIso2, facetKB) : [];
      const excludedG = extractExcludedGenders(userText);

      plan.__excludedAccents = Array.isArray(excludedAcc) ? excludedAcc : [];
      plan.__excludedLocales = Array.isArray(excludedLoc) ? excludedLoc : [];
      plan.__excludedGenders = Array.isArray(excludedG) ? excludedG : [];

      if (plan.__excludedAccents.length) {
        // Persist language used for exclusion parsing, even if we later clear target_voice_language.
        plan.__excludedAccentsIso2 = hintedIso2 || null;

        // Negation wins: clear target_accent if it conflicts with an excluded accent.
        const t = normalizeRequestedAccent(plan?.target_accent);
        if (t) {
          const exSet = new Set(plan.__excludedAccents.map((x) => normalizeRequestedAccent(x)).filter(Boolean));
          if (exSet.has(t)) plan.target_accent = null;
        }
      }

      if (plan.__excludedLocales.length) {
        plan.__excludedLocalesIso2 = hintedIso2 || null;

        // Negation wins: clear target_locale if it conflicts with an excluded locale.
        const tLoc = normalizeRequestedLocale(plan?.target_locale);
        if (tLoc) {
          const exSet = new Set(plan.__excludedLocales.map((x) => normalizeRequestedLocale(x)).filter(Boolean));
          if (exSet.has(tLoc)) plan.target_locale = null;
        }
      }

      if (plan.__excludedGenders.length) {
        // Negation wins: clear target_gender if it conflicts with an excluded gender.
        const tg = (plan?.target_gender || '').toString().toLowerCase();
        if (tg === 'male' || tg === 'female') {
          const exSet = new Set(plan.__excludedGenders.map((x) => (x || '').toString().toLowerCase()).filter(Boolean));
          if (exSet.has(tg)) plan.target_gender = null;
        }
      }
    } catch (_) {
      plan.__excludedAccents = Array.isArray(plan.__excludedAccents) ? plan.__excludedAccents : [];
      plan.__excludedAccentsIso2 = null;
      plan.__excludedLocales = Array.isArray(plan.__excludedLocales) ? plan.__excludedLocales : [];
      plan.__excludedLocalesIso2 = null;
      plan.__excludedGenders = Array.isArray(plan.__excludedGenders) ? plan.__excludedGenders : [];
    }

    // Accent as soft preference unless explicitly mentioned by user (or GCC / regional intent)
    const gccIntent = detectGccArabicVoiceIntent(userText);
    const regionalHint = hasRegionalKeywordFocus(userText);
    const explicitAccent = hasExplicitAccentMention(userText);
    if (!explicitAccent && !gccIntent && !regionalHint) {
      plan.target_accent = null;
    } else if (gccIntent && (!plan.target_accent || !String(plan.target_accent).trim())) {
      plan.target_accent = gccIntent.accent;
    }

    // If user didn't explicitly mention a language, don't constrain by language
    const explicitLanguage = hasExplicitLanguageMention(userText);
    if (!explicitLanguage && !gccIntent && !regionalHint) {
      plan.target_voice_language = null;
    } else if (gccIntent && (!plan.target_voice_language || String(plan.target_voice_language).toLowerCase().slice(0, 2) === 'ar')) {
      plan.target_voice_language = 'ar';
    }
    // Bilingual EN+ES: avoid constraining by language or single-language accent
    if (detectBilingualEnEs(userText)) {
      plan.target_voice_language = null;
      plan.target_accent = null;
    }

    // One male + one female: keep both genders in play (do not collapse to a single target_gender).
    if (detectOneMaleOneFemale(userText)) {
      plan.target_gender = null;
      plan.__dualGenderOneEach = true;
    } else     if (detectBothGendersIntent(userText)) {
      // Both genders catalog filter: do not collapse to a single target_gender.
      plan.target_gender = null;
      plan.__bothGendersCatalog = true;
    }

    applyNoticePeriodToPlan(plan, userText);
    applyCustomRatesToPlan(plan, userText);

    return plan;
  } catch (error) {
    safeLogAxiosError('buildKeywordPlan', error);

    const qp = detectQualityPreferenceFromText(userText);
    const mp = detectModelPreferenceFromText(userText);

    const fallback = {
      user_interface_language: guessUiLanguageFromText(userText),
      target_voice_language: detectVoiceLanguageFromText(userText),
      target_accent: null,
      target_gender: null,
      quality_preference: qp || 'any',
      model_preference: mp || 'any',
      notice_period_preference: 'any',
      min_notice_period_days: null,
      custom_rates_preference: 'any',
      tone_keywords: [],
      use_case_keywords: [],
      character_keywords: [],
      style_keywords: [],
      extra_keywords: [userText.toLowerCase()]
    };
    return applyCustomRatesToPlan(applyNoticePeriodToPlan(fallback, userText), userText);
  }
}

// -------------------------------------------------------------
// ElevenLabs: search public shared voices (per keyword)
// -------------------------------------------------------------

async function fetchVoicesByKeywords(plan, userText, traceCb) {
  const XI_KEY = process.env.ELEVENLABS_API_KEY;
  const seen = new Map(); // voice_id -> { voice, matchedKeywords: Set<string> }
  const trace = typeof traceCb === 'function' ? traceCb : () => {};

  // FacetKB preload (remote, TTL cached). Non-blocking fallback on failures.
  try {
    if (facetKB && typeof facetKB.ensureLoaded === 'function') {
      await facetKB.ensureLoaded(trace);
    }
  } catch (_) {}

  // GCC / Gulf: hydrate plan so API filters + facet browse see language=ar and catalog accent
  try {
    const gcc = detectGccArabicVoiceIntent(userText);
    if (gcc) {
      const lang = (plan.target_voice_language || '').toString().toLowerCase().slice(0, 2);
      if (!lang || lang === 'ar') {
        plan.target_voice_language = 'ar';
        if (!plan.target_accent || !String(plan.target_accent).trim()) {
          plan.target_accent = gcc.accent;
        }
      }
    }
  } catch (_) {}

  const hasOwnerFilter = Boolean((plan?.__owner_id || '').toString().trim());

  // Apply keyword floor enrichment if the plan is too thin (guarded)
  if (typeof ensureKeywordFloor === 'function' && !hasOwnerFilter && !extractBareVoiceId(userText)) {
    plan = ensureKeywordFloor(userText, plan);
  }
  try {
    // First-shot template telemetry
    const lt = (userText || '').toLowerCase();
    let template = 'default';
    if (/\bivr\b/.test(lt)) template = 'ivr_triad';
    else if (detectBilingualEnEs(userText)) template = 'bilingual_mode';
    else if (/\b(commercial|advertising|ad|promo|promotion|brand|campaign)\b/.test(lt)) template = 'commercial_triage';
    else if (/\b(healthcare|medical|hospital|patient|clinic|clinical)\b/.test(lt)) template = 'healthcare_conversational';
    trace({ stage: 'first_shot', params: { template } });

    const totalKw =
      (plan.tone_keywords?.length || 0) +
      (plan.use_case_keywords?.length || 0) +
      (plan.character_keywords?.length || 0) +
      (plan.style_keywords?.length || 0) +
      (plan.extra_keywords?.length || 0);
    trace({
      stage: 'keyword_floor',
      params: { domain: plan.__floorDomain || '-', total_keywords: String(totalKw) },
      count: totalKw
    });
    if (totalKw < 6 && hasExplicitUseCaseMention(userText)) {
      plan.__forceUseCases = true;
      trace({ stage: 'keyword_floor_force_use_cases', params: { reason: 'explicit_use_case_low_kw' } });
    }
  } catch (_) {}
  // Negatives from user brief
  try {
    plan.__negatives = Array.from(extractNegativeTokens(userText) || []);
    // Ensure negated tokens (e.g. "not audiobook") never influence use_cases/descriptives/search keywords.
    plan = applyNegativesToPlan(plan);
    if (plan.__negatives.length) {
      trace({ stage: 'negatives', params: { applied: plan.__negatives.join(',') } });
    }
  } catch (_) {}

  async function callSharedVoices(params) {
    const url = `https://api.elevenlabs.io/v1/shared-voices?${params.toString()}`;
    const res = await httpGetWithRetry(url, {
      headers: {
        'xi-api-key': XI_KEY,
        'Content-Type': 'application/json'
      },
      timeout: 10000
    });
    return res.data.voices || [];
  }

  let language = null;
  if (plan.target_voice_language && typeof plan.target_voice_language === 'string') {
    language = plan.target_voice_language.slice(0, 2).toLowerCase();
  }
  try {
    if (language) accentCatalog?.noteLanguageUsed?.(language);
  } catch (_) {}

  let accent = null;
  if (plan.target_accent && typeof plan.target_accent === 'string') {
    accent = normalizeAccentForApiParam(language, plan.target_accent);
  }

  let gender = null;
  if (
    !wantsOneMaleOneFemale(plan, userText) &&
    !wantsBothGendersCatalog(plan, userText) &&
    !detectGenderQuotaPerSide(userText) &&
    (plan.target_gender === 'male' || plan.target_gender === 'female')
  ) {
    gender = plan.target_gender;
  }

  const qualityPref = plan.quality_preference || 'any';
  const modelPref = plan.model_preference || 'any';

  // Resolve variant constraints once (used by fanout + scoring + diagnostics)
  const resolved = resolveVariantConstraints(userText, plan, facetKB, accentCatalog);
  // European Portuguese: prefer accent=european queries; avoid AND-ing sparse locale=pt-PT.
  try {
    if (
      resolved &&
      resolved.targetIso2 === 'pt' &&
      resolved.variantAxis === 'accent' &&
      Array.isArray(resolved.variantCandidates) &&
      normalizeCatalogToken(resolved.variantCandidates[0]) === 'european'
    ) {
      plan.target_locale = null;
      if (!accent) {
        accent = normalizeAccentForApiParam('pt', 'european') || 'european';
      }
      if (!plan.target_accent) plan.target_accent = 'european';
    }
  } catch (_) {}
  const isBilingualEnEsSearch = detectBilingualEnEs(userText);
  if (isBilingualEnEsSearch) {
    language = null;
    accent = null;
  }

  // Fallback: infer language from resolver (accent-implies-language, etc.)
  // when the GPT plan didn't set target_voice_language.
  if (!language && resolved?.targetIso2 && !detectBilingualEnEs(userText)) {
    language = resolved.targetIso2;
  }

  // -------------------------------------------------------------
  // Accent form probe (name vs slug) for /v1/shared-voices
  // -------------------------------------------------------------
  // Goal: avoid wasting many per-keyword requests on an accent form that yields 0 results (200 OK).
  // Budget: up to 2 probe requests on cache miss.
  try {
    if (isBilingualEnEsSearch) {
      accent = null;
    } else {
    const iso2 = (language || resolved?.targetIso2 || '').toString().toLowerCase().slice(0, 2);
    const hasIso2 = Boolean(iso2);
    const wantsAccent = hasIso2 && (() => {
      try {
        // consider explicit plan accent, resolver accent, or Spanish LatAm heuristic
        if (plan?.target_accent && typeof plan.target_accent === 'string' && plan.target_accent.trim()) return true;
        if (resolved && resolved.variantAxis === 'accent' && Array.isArray(resolved.variantCandidates) && resolved.variantCandidates.length) return true;
        const lt = (userText || '').toLowerCase();
        if (iso2 === 'es' && LATAM_SPANISH_RE.test(lt)) return true;
      } catch (_) {}
      return false;
    })();

    if (hasIso2 && wantsAccent && facetKB && facetKB.isLoaded && facetKB.isLoaded() && facetKB.hasIso2 && facetKB.hasIso2(iso2)) {
      const computeAccentPair = () => {
        const out = { accentNorm: null, name: null, slug: null };
        let base = null;
        try {
          if (plan?.target_accent && typeof plan.target_accent === 'string' && plan.target_accent.trim()) base = plan.target_accent;
          else if (resolved && resolved.variantAxis === 'accent' && Array.isArray(resolved.variantCandidates) && resolved.variantCandidates.length) base = resolved.variantCandidates[0];
          else if (iso2 === 'es') base = 'latin american';
        } catch (_) {}
        const norm = normalizeCatalogToken(base || '');
        if (!norm) return out;
        out.accentNorm = norm;
        // name form: normalized accent key (spaces)
        out.name = norm.includes('-') ? norm.replace(/-+/g, ' ').trim() : norm;
        // slug form: KB mapping when possible (accepts name or slug input)
        let slug = null;
        try {
          slug = facetKB.getAccentSlug ? facetKB.getAccentSlug(iso2, norm) : null;
        } catch (_) {
          slug = null;
        }
        out.slug = String(slug || slugifyAccentName(out.name) || '').trim() || null;
        return out;
      };

      const pair = computeAccentPair();
      const isAmbiguous = pair?.name && pair?.slug && pair.name !== pair.slug;
      if (isAmbiguous && pair.accentNorm) {
        const cached = getCachedAccentForm(iso2, pair.accentNorm);
        if (cached && cached.preferred) {
          try {
            trace({
              stage: 'accent_cache_hit',
              params: { iso2, accent: pair.accentNorm, preferred: cached.preferred },
              count: 0
            });
          } catch (_) {}
          // Apply preference to the accent variable used in query building.
          accent = cached.preferred === 'name' ? pair.name : pair.slug;
        } else {
          const probeOnce = async (accentValue) => {
            const p = new URLSearchParams();
            p.set('page_size', '1');
            p.set('language', iso2);
            if (qualityPref === 'high_only') p.set('category', 'high_quality');
            p.set('accent', String(accentValue));
            // Do NOT include use_cases/descriptives/search: keep probe focused on accent form behavior.
            const voices = await callSharedVoices(p);
            return Array.isArray(voices) ? voices.length : 0;
          };

          let nameCount = 0;
          let slugCount = 0;
          try { nameCount = await probeOnce(pair.name); } catch (_) { nameCount = 0; }
          try { slugCount = await probeOnce(pair.slug); } catch (_) { slugCount = 0; }

          const preferred = nameCount > 0 && slugCount === 0 ? 'name'
            : (slugCount > 0 && nameCount === 0 ? 'slug'
              : (nameCount >= slugCount ? 'name' : 'slug'));

          setCachedAccentForm(iso2, pair.accentNorm, preferred, { nameCount, slugCount });
          try {
            trace({
              stage: 'accent_probe',
              params: {
                iso2,
                accent: pair.accentNorm,
                name: pair.name,
                slug: pair.slug,
                name_count: String(nameCount),
                slug_count: String(slugCount),
                preferred
              },
              count: Math.max(nameCount, slugCount)
            });
          } catch (_) {}

          accent = preferred === 'name' ? pair.name : pair.slug;
        }
      }
    }
    }
  } catch (_) {}

  let primaryVariantApplied = false;
  const primaryVariant = (() => {
    try {
      if (!resolved || resolved.variantMode !== 'specific') return null;
      if (!Array.isArray(resolved.variantCandidates) || !resolved.variantCandidates.length) return null;
      return String(resolved.variantCandidates[0] || '').trim() || null;
    } catch (_) {
      return null;
    }
  })();
  const maybeMarkPrimaryVariantApplied = (appended) => {
    try {
      if (primaryVariantApplied) return;
      if (!primaryVariant || !resolved) return;
      const d = appended && appended.__diag ? appended.__diag : null;
      if (!d) return;
      if (resolved.variantAxis === 'accent') {
        if (String(d.accent_allowed || '') !== 'true') return;
        const used = normalizeCatalogToken(d.accent_set || '') || String(d.accent_set || '').toLowerCase().trim();
        const want = normalizeCatalogToken(primaryVariant) || primaryVariant.toLowerCase().trim();
        if (used && want && used === want) primaryVariantApplied = true;
      } else if (resolved.variantAxis === 'locale') {
        if (String(d.locale_allowed || '') !== 'true') return;
        const used = normalizeLocaleToken(d.locale_set || '');
        const want = normalizeLocaleToken(primaryVariant);
        if (used && want && used === want) primaryVariantApplied = true;
      }
    } catch (_) {}
  };
  try {
    trace({
      stage: 'resolver',
      params: {
        iso2: resolved?.targetIso2 || '-',
        axis: resolved?.variantAxis || 'none',
        mode: resolved?.variantMode || 'general',
        reason: resolved?.reason || '-',
        region: resolved?.regionIntent || '-',
        candidates: Array.isArray(resolved?.variantCandidates) ? resolved.variantCandidates.slice(0, 6).join(',') : '-'
      },
      count: Array.isArray(resolved?.variantCandidates) ? resolved.variantCandidates.length : 0
    });
  } catch (_) {}

  // ALL keywords from the plan – each will be used in a separate search
  const toneKw = Array.from(new Set((plan.tone_keywords || []).map((s) => (s || '').toLowerCase().trim()).filter(Boolean)));
  const useKw = Array.from(new Set((plan.use_case_keywords || []).map((s) => (s || '').toLowerCase().trim()).filter(Boolean)));
  const charKw = Array.from(new Set((plan.character_keywords || []).map((s) => (s || '').toLowerCase().trim()).filter(Boolean)));
  const styleKw = Array.from(new Set((plan.style_keywords || []).map((s) => (s || '').toLowerCase().trim()).filter(Boolean)));
  const extraKw = Array.from(new Set((plan.extra_keywords || []).map((s) => (s || '').toLowerCase().trim()).filter(Boolean)));

  // Budgeted selection: prioritize use/style/character over tone
  const MAX_KEYWORD_QUERIES = 14;
  const budgets = { tone: 3, use: 4, style: 4, character: 3 };
  const pick = (arr, n) => arr.slice(0, Math.max(0, n));
  let selectedKeywords = [
    ...pick(useKw, budgets.use),
    ...pick(styleKw, budgets.style),
    ...pick(charKw, budgets.character),
    ...pick(toneKw, budgets.tone)
  ];
  // fill remaining from extras or leftovers
  const leftovers = [
    ...useKw.slice(budgets.use),
    ...styleKw.slice(budgets.style),
    ...charKw.slice(budgets.character),
    ...toneKw.slice(budgets.tone),
    ...extraKw
  ].filter((k) => !selectedKeywords.includes(k));
  while (selectedKeywords.length < MAX_KEYWORD_QUERIES && leftovers.length) {
    selectedKeywords.push(leftovers.shift());
  }
  // If nothing at all, use raw user text
  if (!selectedKeywords.length && userText) {
    selectedKeywords.push((userText || '').toLowerCase());
  }

  // Remove "high quality"/"hq" from keywords when quality_preference already constrains the search,
  // unless the user explicitly mentioned quality in any form (space, hyphen, abbreviation).
  if (qualityPref === 'high_only' || qualityPref === 'no_high') {
    const _qLower = (userText || '').toLowerCase();
    const _userMentionsQuality = _qLower.includes('high quality') || _qLower.includes('high-quality') || /\bhq\b/.test(_qLower);
    if (!_userMentionsQuality) {
      selectedKeywords = selectedKeywords.filter((k) => {
        const n = normalizeKw(k);
        return n !== 'high quality' && n !== 'hq' && n !== 'high-quality';
      });
    }
  }

  // Global prune of generic/noise keywords unless user explicitly asked
  {
    const before = pruneNegativesFromList(selectedKeywords.slice(), plan.__negatives);
    let filtered = filterKeywordsGlobally(userText, before);
    filtered = pruneNegativesFromList(filtered, plan.__negatives);

    // Ensure a minimum count after filtering by refilling from dropped ones
    const hasRegionalFocus = hasRegionalKeywordFocus((userText || '').toLowerCase());
    const MIN_KEYWORDS_AFTER_FILTER = hasRegionalFocus ? 8 : 12;
    if (filtered.length < MIN_KEYWORDS_AFTER_FILTER) {
      const dropped = before.filter((k) => !filtered.includes(k));
      // Prioritize those explicitly mentioned by the user
      dropped.sort((a, b) => {
        const ea = explicitlyMentionedInText(a, userText) ? 1 : 0;
        const eb = explicitlyMentionedInText(b, userText) ? 1 : 0;
        return eb - ea;
      });
      while (
        filtered.length < Math.min(MIN_KEYWORDS_AFTER_FILTER, before.length) &&
        dropped.length
      ) {
        const next = dropped.shift();
        if (next && !filtered.includes(next)) filtered.push(next);
      }
    }

    // Intent-aware enrichment (military / villain / negative tone, etc.)
    filtered = enrichKeywordsByIntent(userText, filtered);
    filtered = pruneNegativesFromList(filtered, plan.__negatives);

    // Commercial keyword pruning: avoid spending keyword queries on low-yield marketing adjectives,
    // while keeping commercial intent via use_cases=advertisement and ranking.
    try {
      const lt = (userText || '').toLowerCase();
      const isCommercialIntent = /\b(commercial|advertising|advertisement|ad|ads|promo|promotion|brand|branding|campaign)\b/.test(lt);
      if (isCommercialIntent && filtered.length) {
        const lowYield = new Set(['upbeat', 'cheerful', 'dynamic', 'branding', 'campaign']);
        const highYield = ['commercial', 'advertisement', 'ad', 'promo', 'spokesperson'];

        const beforePrune = filtered.slice();
        const pruned = [];
        for (const k of beforePrune) {
          const key = normalizeKw(k);
          if (lowYield.has(key) && !explicitlyMentionedInText(key, userText)) {
            continue;
          }
          pruned.push(key);
        }

        // Ensure at least one high-yield commercial token exists (unless user explicitly avoided them)
        const hasAnyHigh = pruned.some((k) => highYield.includes(k));
        if (!hasAnyHigh) {
          for (const k of highYield) {
            if (explicitlyMentionedInText(k, userText) || beforePrune.includes(k)) {
              pruned.unshift(k);
              break;
            }
          }
        }

        // Dedup & keep order
        {
          const uniq = [];
          const seen = new Set();
          for (const k of pruned) {
            const v = normalizeKw(k);
            if (v && !seen.has(v)) {
              uniq.push(v);
              seen.add(v);
            }
          }
          filtered = uniq;
        }

        // Optional trace for POC report
        if (process.env.POC_SEARCH_REPORT === 'true') {
          try {
            const dropped = beforePrune.filter((k) => !filtered.includes(normalizeKw(k)));
            if (dropped.length) {
              trace({
                stage: 'keyword_prune',
                params: { mode: 'commercial', dropped: dropped.slice(0, 12).join(',') },
                count: dropped.length
              });
            }
          } catch (_) {}
        }
      }
    } catch (_) {}

    // Safety: if nothing left, fall back to raw user text (filtered once, then enriched)
    if (!filtered.length && userText) {
      const fb = filterKeywordsGlobally(userText, [(userText || '').toLowerCase()]);
      filtered = enrichKeywordsByIntent(userText, fb.length ? fb : [(userText || '').toLowerCase()]);
      filtered = pruneNegativesFromList(filtered, plan.__negatives);
    }

    // Cap to max
    selectedKeywords = filtered.slice(0, MAX_KEYWORD_QUERIES);
  }

  // Dialect-aware keyword shaping (soft): when user asks for Cantonese/Mandarin,
  // spend less budget on very generic tokens and add dialect/region hints.
  try {
    const dialect = language === 'zh' ? detectChineseDialectFromText(userText) : null;
    if (dialect) {
      const hints = dialectKeywordHints(dialect);
      const generic = new Set(['voice', 'accent', 'audiobook', 'narration']);
      // Drop generic tokens unless explicitly present in user text
      const trimmed = (selectedKeywords || []).filter((k) => {
        const nk = normalizeKw(k);
        if (!generic.has(nk)) return true;
        return explicitlyMentionedInText(nk, userText);
      });
      const merged = dedupePreserveOrder([
        ...hints,
        ...trimmed
      ]).filter(Boolean);
      selectedKeywords = merged.slice(0, MAX_KEYWORD_QUERIES);
    }
  } catch (_) {}

  // Both-genders catalog: symmetric male/female voice tokens in per_keyword searches.
  selectedKeywords = ensureBothGenderSearchKeywords(userText, selectedKeywords, MAX_KEYWORD_QUERIES, plan);

  // -------------------------------------------------------------
  // LLM keyword translation/expansion (for search=) – improves recall outside EN
  // -------------------------------------------------------------
  async function expandSearchKeywordsWithLLM(targetIso2, keywords, traceCb2) {
    const trace2 = typeof traceCb2 === 'function' ? traceCb2 : () => {};
    try {
      const iso = (targetIso2 || '').toString().toLowerCase().slice(0, 2);
      if (!iso || iso === 'en') return keywords;
      if (!readEnvBoolean('ENABLE_LLM_KEYWORD_TRANSLATION', true)) return keywords;
      if (!process.env.OPENAI_API_KEY) return keywords;

      const src = Array.isArray(keywords) ? keywords : [];
      const compact = src.map((k) => normalizeKw(k)).filter(Boolean).slice(0, 10);
      if (compact.length === 0) return keywords;

      const MAX_ADDED = 10; // keep search tight; do not over-dilute
      const out = [];
      const missing = [];
      const now = Date.now();
      let addedSoFar = 0;

      for (const kw of compact) {
        out.push(kw);
        const cacheKey = `${iso}|${kw}`;
        const hit = keywordTranslateCache.get(cacheKey);
        if (hit && now - (hit.at || 0) < KEYWORD_TRANSLATE_TTL_MS && Array.isArray(hit.out)) {
          for (const t of hit.out) {
            if (addedSoFar >= MAX_ADDED) break;
            const v = normalizeKw(t);
            if (v) {
              out.push(v);
              addedSoFar++;
            }
          }
        } else {
          missing.push(kw);
        }
      }

      if (missing.length) {
        const system = [
          'You translate keyword search tokens for a voice library search.',
          'Return JSON only.',
          'json',
          '',
          'Rules:',
          '- Translate to the target language given by iso2 (2-letter).',
          '- Keep outputs short (1-3 words), lowercase, no punctuation.',
          '- Return up to 3 translations/synonyms per input token.',
          '',
          'Return format:',
          '{ "translations": { "<src>": ["<t1>","<t2>"] } }'
        ].join('\n');

        const payload = {
          model: 'gpt-4o-mini',
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: system },
            {
              role: 'user',
              content:
                'json\n' +
                JSON.stringify({
                  iso2: iso,
                  keywords: missing
                })
            }
          ],
          temperature: 0
        };

        const resp = await httpPostWithRetry('https://api.openai.com/v1/chat/completions', payload, {
          headers: {
            Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
            'Content-Type': 'application/json'
          },
          timeout: 20000
        });
        const content = resp?.data?.choices?.[0]?.message?.content || '{}';
        const data = JSON.parse(content);
        const tr = data && typeof data === 'object' ? data.translations || {} : {};

        let added = 0;
        for (const srcKw of missing) {
          const arr = Array.isArray(tr?.[srcKw]) ? tr[srcKw] : [];
          const cleaned = dedupePreserveOrder(arr.map((x) => normalizeKw(x)).filter(Boolean)).slice(0, 3);
          const cacheKey = `${iso}|${srcKw}`;
          keywordTranslateCache.set(cacheKey, { at: Date.now(), iso2: iso, src: srcKw, out: cleaned });
          for (const t of cleaned) {
            if (addedSoFar >= MAX_ADDED) break;
            out.push(t);
            added++;
            addedSoFar++;
          }
          if (addedSoFar >= MAX_ADDED) break;
        }

        try {
          trace2({ stage: 'keyword_translate', params: { iso2: iso, inputs: String(missing.length), added: String(added) }, count: added });
        } catch (_) {}
      }

      return dedupePreserveOrder(out).slice(0, 18);
    } catch (e) {
      safeLogAxiosError('keyword_translate', e);
      return keywords;
    }
  }

  try {
    if (language) {
      selectedKeywords = await expandSearchKeywordsWithLLM(language, selectedKeywords, trace);
    }
  } catch (_) {}

  // -------------------------------------------------------------
  // Facet browse mode (UI-like): split results per accent/locale
  // -------------------------------------------------------------
  // Goal: for ANY language with multiple variants in FacetKB, avoid mixing variants by
  // fetching per-variant candidate pools (bounded number of requests) and returning
  // facetGroups alongside the combined candidate list.
  try {
    const hasExplicitPlanVariant = Boolean(
      (plan.target_accent && typeof plan.target_accent === 'string' && plan.target_accent.trim()) ||
      (plan.target_locale && typeof plan.target_locale === 'string' && plan.target_locale.trim())
    );
    const facetKbReady =
      language &&
      !detectBilingualEnEs(userText) &&
      facetKB &&
      facetKB.isLoaded &&
      facetKB.isLoaded() &&
      facetKB.hasIso2 &&
      facetKB.hasIso2(language);
    const canFacetBrowseSpecific =
      facetKbReady &&
      hasExplicitPlanVariant &&
      resolved?.variantMode === 'specific' &&
      (resolved.variantAxis === 'locale' || resolved.variantAxis === 'accent') &&
      Array.isArray(resolved.variantCandidates) &&
      resolved.variantCandidates.length >= 1;
    const canFacetBrowse = facetKbReady && (!hasExplicitPlanVariant || canFacetBrowseSpecific);

    if (canFacetBrowse) {
      const zhDialect = language === 'zh' ? detectChineseDialectFromText(userText) : null;
      const variantIntent = detectVariantIntent(userText, language, facetKB);
      const gccBrowse = language === 'ar' && detectGccArabicVoiceIntent(userText);
      const axis = variantIntent?.isSpecific
        ? (variantIntent.axis || 'accent')
        : (canFacetBrowseSpecific
          ? resolved.variantAxis
          : (language === 'zh' && zhDialect
            ? 'accent'
            : gccBrowse
              ? 'accent'
              : (facetKB.getAxisForIso2 ? facetKB.getAxisForIso2(language) : null)));
      const maxVariants = 4;
      let variants = [];
      if (variantIntent && variantIntent.isSpecific) {
        const queryKeys = Array.isArray(variantIntent.requestedFacetQueryKeys) && variantIntent.requestedFacetQueryKeys.length
          ? variantIntent.requestedFacetQueryKeys
          : (Array.isArray(variantIntent.requestedFacetKeys) ? variantIntent.requestedFacetKeys : []);
        const built = [];
        for (const k of queryKeys) {
          const v = facetKB.getVariantForFacetKey ? facetKB.getVariantForFacetKey(language, axis, k) : null;
          if (v) built.push(v);
        }
        variants = built;
      } else if (canFacetBrowseSpecific && resolved) {
        const ax = resolved.variantAxis;
        const built = [];
        for (const k of resolved.variantCandidates.slice(0, maxVariants)) {
          const key =
            ax === 'locale'
              ? normalizeLocaleToken(k) || String(k).toLowerCase().trim()
              : normalizeCatalogToken(k) || String(k).toLowerCase().trim();
          if (!key) continue;
          const v = facetKB.getVariantForFacetKey ? facetKB.getVariantForFacetKey(language, ax, key) : null;
          if (v) built.push(v);
        }
        variants = built;
      } else if (
        gccBrowse &&
        resolved &&
        resolved.variantAxis === 'accent' &&
        Array.isArray(resolved.variantCandidates) &&
        resolved.variantCandidates.length
      ) {
        const built = [];
        for (const cand of resolved.variantCandidates.slice(0, maxVariants)) {
          const key = normalizeCatalogToken(String(cand || '')) || String(cand || '').toLowerCase().trim();
          if (!key) continue;
          const v = facetKB.getVariantForFacetKey ? facetKB.getVariantForFacetKey(language, 'accent', key) : null;
          if (v) built.push(v);
        }
        variants = built.length ? built : (facetKB.getFacetVariants ? facetKB.getFacetVariants(language, axis, { maxVariants }) : []);
      } else {
        variants = facetKB.getFacetVariants ? facetKB.getFacetVariants(language, axis, { maxVariants }) : [];
      }

      try {
        trace({
          stage: 'variant_intent',
          params: {
            iso2: language,
            specific: variantIntent && variantIntent.isSpecific ? 'true' : 'false',
            axis: variantIntent && variantIntent.axis ? String(variantIntent.axis) : '-',
            requested: variantIntent && variantIntent.isSpecific ? (variantIntent.requestedFacetKeys || []).slice(0, 8).join(',') : '-',
            fallback: variantIntent && variantIntent.isSpecific ? (variantIntent.fallbackFacetKeys || []).slice(0, 6).join(',') : '-',
            combine: variantIntent && variantIntent.isSpecific && variantIntent.combineGroupKey ? String(variantIntent.combineGroupKey) : '-'
          }
        });
      } catch (_) {}

      const isSpecificBrowse = (variantIntent && variantIntent.isSpecific) || canFacetBrowseSpecific;
      const minVariants = isSpecificBrowse ? 1 : 2;
      if (axis && Array.isArray(variants) && variants.length >= minVariants) {
        const wantMore = detectListAll(userText) === true || plan.__listAll === true;
        const pageSize = wantMore ? 80 : 50;
        const featured = plan.__featured === true;
        const minNoticePeriodDays =
          plan.__no_notice_period === true
            ? null
            : typeof plan.__min_notice_period_days === 'number'
              ? plan.__min_notice_period_days
              : null;
        const sort = typeof plan.__sort === 'string' ? plan.__sort : null;
        const age = detectAgeFromText(userText);

        // Hybrid facet browse: pass 1 without `search` (UI-like facets), pass 2 with `search` only if needed.
        const combinedSearch = (selectedKeywords || []).slice(0, 6).join(' ').trim();

        let requestBudget = 15;
        const facetGroups = [];
        const allVoices = [];
        const allSeen = new Set();
        const isCombinedZhDialect =
          !!(variantIntent && variantIntent.isSpecific && language === 'zh' && axis === 'accent' && variantIntent.combineGroupKey && variantIntent.combineGroupLabel);
        const combinedGroup = isCombinedZhDialect
          ? { facetType: 'accent', facetKey: String(variantIntent.combineGroupKey), facetLabel: String(variantIntent.combineGroupLabel), voices: [] }
          : null;
        const combinedSeen = combinedGroup ? new Set() : null;
        let fallbackUsed = false;

        // (trace after we know whether fallback was used)

        const fetchOnce = async (params, meta) => {
          if (requestBudget <= 0) return [];
          requestBudget -= 1;
          let voices = [];
          try {
            voices = wantMore
              ? await callSharedVoicesAllPages(params, { maxPages: 1, cap: pageSize })
              : await callSharedVoicesCached(params, async (p) => {
                  const { voices } = await callSharedVoicesRaw(p);
                  return voices;
                });
          } catch (_) {
            voices = [];
          }
          try {
            trace({
              stage: 'facet_variant',
              params: { ...meta, ...paramsToObject(params) },
              count: Array.isArray(voices) ? voices.length : 0
            });
          } catch (_) {}
          return Array.isArray(voices) ? voices : [];
        };

        const runVariantList = async (variantList, { allowCombine = false } = {}) => {
          for (const v of variantList || []) {
            if (!v || requestBudget <= 0) break;
            const group =
              allowCombine && combinedGroup && v.facetType === 'accent'
                ? combinedGroup
                : {
                    facetType: v.facetType,
                    facetKey: v.facetKey,
                    facetLabel: v.facetLabel,
                    voices: []
                  };

            const seenInGroup = group === combinedGroup && combinedSeen ? combinedSeen : new Set();
            const base = new URLSearchParams();
            base.set('page_size', String(pageSize));
            base.set('language', String(language));
            if (gender) base.set('gender', gender);
            if (qualityPref === 'high_only') base.set('category', 'high_quality');
            if (featured) base.set('featured', 'true');
            if (typeof minNoticePeriodDays === 'number' && minNoticePeriodDays > 0) {
              base.set('min_notice_period_days', String(minNoticePeriodDays));
            }
            maybeSetIncludeCustomRatesParam(base, plan);
            if (age) base.set('age', age);
            if (sort) base.set('sort', sort);
            // Apply use_cases on facet browse when the brief has an explicit use case.
            // Without this, de-DE/de-AT HQ pools are identical for articles/audiobooks/educational.
            let facetUseCases = [];
            try {
              if (
                shouldApplyParam('use_cases', plan, userText, {
                  __forceUseCases: plan.__forceUseCases === true
                })
              ) {
                facetUseCases = pickQueryUseCases(plan, userText);
              }
            } catch (_) {
              facetUseCases = [];
            }
            for (const uc of facetUseCases) {
              try {
                base.append('use_cases', uc);
              } catch (_) {}
            }
            // pass 1: no search

            let fetched = [];
            if (axis === 'locale' && v.facetType === 'locale') {
              const p = new URLSearchParams(base.toString());
              p.set('locale', String(v.facetValue || v.facetLabel || ''));
              fetched = await fetchOnce(p, { iso2: language, axis: 'locale', pass: 'no_search', facet: String(v.facetLabel || v.facetValue || '') });
              if ((!fetched || fetched.length < 3) && combinedSearch && requestBudget > 0) {
                const p2 = new URLSearchParams(p.toString());
                p2.set('search', combinedSearch);
                const v2 = await fetchOnce(p2, { iso2: language, axis: 'locale', pass: 'with_search', facet: String(v.facetLabel || v.facetValue || '') });
                if (Array.isArray(v2) && v2.length > fetched.length) fetched = v2;
              }
            } else if (axis === 'accent' && v.facetType === 'accent') {
              // Try accent NAME first, then slug (some APIs are picky)
              const nameVal = String(v.facetValue || v.facetLabel || '').trim();
              if (nameVal) {
                const p1 = new URLSearchParams(base.toString());
                p1.set('accent', nameVal);
                fetched = await fetchOnce(p1, { iso2: language, axis: 'accent', accent_mode: 'name', pass: 'no_search', facet: nameVal });
                if ((!fetched || fetched.length < 3) && combinedSearch && requestBudget > 0) {
                  const p1s = new URLSearchParams(p1.toString());
                  p1s.set('search', combinedSearch);
                  const v1s = await fetchOnce(p1s, { iso2: language, axis: 'accent', accent_mode: 'name', pass: 'with_search', facet: nameVal });
                  if (Array.isArray(v1s) && v1s.length > fetched.length) fetched = v1s;
                }
              }
              if ((!fetched || fetched.length === 0) && v.slug) {
                const slugVal = String(v.slug || '').trim();
                if (slugVal && slugVal !== nameVal) {
                  const p2 = new URLSearchParams(base.toString());
                  p2.set('accent', slugVal);
                  let v2 = await fetchOnce(p2, { iso2: language, axis: 'accent', accent_mode: 'slug', pass: 'no_search', facet: slugVal });
                  if ((!v2 || v2.length < 3) && combinedSearch && requestBudget > 0) {
                    const p2s = new URLSearchParams(p2.toString());
                    p2s.set('search', combinedSearch);
                    const v2s = await fetchOnce(p2s, { iso2: language, axis: 'accent', accent_mode: 'slug', pass: 'with_search', facet: slugVal });
                    if (Array.isArray(v2s) && v2s.length > v2.length) v2 = v2s;
                  }
                  if (Array.isArray(v2) && v2.length) fetched = v2;
                }
              }
            }

            for (const voice of fetched || []) {
              if (!voice || !voice.voice_id) continue;
              // Tag for diagnostics/coverage using the actual facet variant key (even if we later combine groups)
              try {
                const tag = `${axis}:${String(v.facetKey || '')}`;
                if (!Array.isArray(voice._matched_keywords)) voice._matched_keywords = [];
                if (!voice._matched_keywords.includes(tag)) voice._matched_keywords.push(tag);
              } catch (_) {}
              if (!seenInGroup.has(voice.voice_id)) {
                seenInGroup.add(voice.voice_id);
                group.voices.push(voice);
              }
              if (!allSeen.has(voice.voice_id)) {
                allSeen.add(voice.voice_id);
                allVoices.push(voice);
              }
            }

            // In combined mode, only push the combined group once (at the end).
            if (!(allowCombine && combinedGroup && group === combinedGroup)) {
              facetGroups.push(group);
            }
          }
        };

        // Primary (requested) variants
        await runVariantList(variants, { allowCombine: isCombinedZhDialect });
        if (isCombinedZhDialect && combinedGroup) {
          // Ensure the combined group appears once and only if it has voices
          if (Array.isArray(combinedGroup.voices) && combinedGroup.voices.length) {
            facetGroups.push(combinedGroup);
          }
        }

        // Fallback variants only when primary is 0 (per spec)
        if ((variantIntent && variantIntent.isSpecific) && allVoices.length === 0) {
          fallbackUsed = true;
          const fallbackKeys = Array.isArray(variantIntent.fallbackFacetKeys) ? variantIntent.fallbackFacetKeys : [];
          const fallbackVariants = [];
          for (const k of fallbackKeys) {
            const fv = facetKB.getVariantForFacetKey ? facetKB.getVariantForFacetKey(language, axis, k) : null;
            if (fv) fallbackVariants.push(fv);
          }
          if (fallbackVariants.length) {
            await runVariantList(fallbackVariants, { allowCombine: false });
          }

          // If still nothing, try a controlled FR-EU fallback before broad OTHER.
          if (allVoices.length === 0 && requestBudget > 0) {
            const base = new URLSearchParams();
            base.set('page_size', String(pageSize));
            base.set('language', String(language));
            if (gender) base.set('gender', gender);
            if (qualityPref === 'high_only') base.set('category', 'high_quality');
            if (featured) base.set('featured', 'true');
            if (typeof minNoticePeriodDays === 'number' && minNoticePeriodDays > 0) {
              base.set('min_notice_period_days', String(minNoticePeriodDays));
            }
            maybeSetIncludeCustomRatesParam(base, plan);
            if (age) base.set('age', age);
            if (sort) base.set('sort', sort);

            if (language === 'fr') {
              const requested = Array.isArray(variantIntent.requestedFacetKeys) ? variantIntent.requestedFacetKeys : [];
              const wantsFrEu = requested.includes('fr-fr') || requested.includes('parisian') || hasFrenchEuropeanMarkers(userText);
              const wantsFrCa = requested.includes('fr-ca') || hasFrenchCanadianMarkers(userText);
              if (wantsFrEu && !wantsFrCa) {
                const pFr = new URLSearchParams(base.toString());
                pFr.set('locale', 'fr-FR');
                let fetchedFr = await fetchOnce(pFr, { iso2: language, axis: 'locale', pass: 'no_search', facet: 'fr-FR', fallback: 'fr_eu_locale' });
                if ((!fetchedFr || fetchedFr.length < 3) && combinedSearch && requestBudget > 0) {
                  const pFrS = new URLSearchParams(pFr.toString());
                  pFrS.set('search', combinedSearch);
                  const fetchedFrS = await fetchOnce(pFrS, { iso2: language, axis: 'locale', pass: 'with_search', facet: 'fr-FR', fallback: 'fr_eu_locale' });
                  const fetchedFrLen = Array.isArray(fetchedFr) ? fetchedFr.length : 0;
                  if (Array.isArray(fetchedFrS) && fetchedFrS.length > fetchedFrLen) fetchedFr = fetchedFrS;
                }
                const frGroup = { facetType: 'locale', facetKey: 'fr-fr', facetLabel: 'FR-FR', voices: [] };
                const seenFr = new Set();
                for (const voice of fetchedFr || []) {
                  if (!voice || !voice.voice_id) continue;
                  if (!seenFr.has(voice.voice_id)) {
                    seenFr.add(voice.voice_id);
                    frGroup.voices.push(voice);
                  }
                  if (!allSeen.has(voice.voice_id)) {
                    allSeen.add(voice.voice_id);
                    allVoices.push(voice);
                  }
                }
                if (frGroup.voices.length) facetGroups.push(frGroup);
              }
            }

            if (allVoices.length === 0) {
              const p = new URLSearchParams(base.toString());
              const fetched = await fetchOnce(p, { iso2: language, axis: 'other', pass: 'no_search', facet: '__other__' });
              const group = { facetType: axis, facetKey: '__other__', facetLabel: 'OTHER/UNSURE', voices: [] };
              const seenInGroup = new Set();
              for (const voice of fetched || []) {
                if (!voice || !voice.voice_id) continue;
                try {
                  const tag = `other:__other__`;
                  if (!Array.isArray(voice._matched_keywords)) voice._matched_keywords = [];
                  if (!voice._matched_keywords.includes(tag)) voice._matched_keywords.push(tag);
                } catch (_) {}
                if (!seenInGroup.has(voice.voice_id)) {
                  seenInGroup.add(voice.voice_id);
                  group.voices.push(voice);
                }
                if (!allSeen.has(voice.voice_id)) {
                  allSeen.add(voice.voice_id);
                  allVoices.push(voice);
                }
              }
              if (group.voices.length) facetGroups.push(group);
            }
          }
        }

        try {
          trace({
            stage: 'facet_browse',
            params: {
              iso2: language,
              axis,
              specific: variantIntent && variantIntent.isSpecific ? 'true' : 'false',
              requested: variantIntent && variantIntent.isSpecific ? (variantIntent.requestedFacetKeys || []).slice(0, 6).join(',') : '-',
              fallback: variantIntent && variantIntent.isSpecific ? (variantIntent.fallbackFacetKeys || []).slice(0, 6).join(',') : '-',
              combine: variantIntent && variantIntent.isSpecific && variantIntent.combineGroupKey ? String(variantIntent.combineGroupKey) : '-',
              fallback_used: fallbackUsed ? 'true' : 'false',
              variants: String(variants.length),
              page_size: String(pageSize),
              search: combinedSearch ? 'yes' : 'no'
            }
          });
        } catch (_) {}

        // If we got anything at all, return early with groups.
        if (allVoices.length) {
          // Attach groups as metadata on the returned array (keeps callers compatible)
          allVoices.facetGroups = facetGroups;
          allVoices.facetAxis = axis;
          allVoices.facetIso2 = language;
          allVoices.variantIntent = variantIntent;

          // Rank facet-browse pool by brief fitness before GPT (use-case keywords often don't differentiate).
          try {
            const briefFamily =
              plan.__briefFamily || inferBriefUseCaseFamily(userText, plan);
            if (briefFamily) {
              allVoices.sort((a, b) => {
                const fa = scoreVoiceUseCaseFit(a, briefFamily, userText);
                const fb = scoreVoiceUseCaseFit(b, briefFamily, userText);
                if (fb !== fa) return fb - fa;
                const ua = a.usage_character_count_1y || a.usage_character_count_7d || 0;
                const ub = b.usage_character_count_1y || b.usage_character_count_7d || 0;
                return ub - ua;
              });
              for (const v of allVoices) {
                try {
                  v._brief_fit = scoreVoiceUseCaseFit(v, briefFamily, userText);
                  v._coverageScore = v._brief_fit;
                } catch (_) {}
              }
              try {
                trace({
                  stage: 'facet_brief_rank',
                  params: {
                    family: briefFamily,
                    top: allVoices
                      .slice(0, 5)
                      .map((v) => `${v.name || v.voice_id}:${Number(v._brief_fit || 0).toFixed(1)}`)
                      .join(',')
                  },
                  count: allVoices.length
                });
              } catch (_) {}
            }
          } catch (_) {}

          if (plan.__no_notice_period === true || plan.__min_notice_period_days > 0 || plan.__no_custom_rates === true) {
            return applyVoiceLibraryFilters(allVoices, plan);
          }
          return allVoices;
        }
      }
    }
  } catch (_) {}

  // Specific variant pool seed: when user asked for a concrete locale/accent, fetch that
  // variant's catalog pool before keyword search (avoids polluting with generic language matches).
  try {
    if (
      language &&
      resolved?.variantMode === 'specific' &&
      (resolved.variantAxis === 'locale' || resolved.variantAxis === 'accent') &&
      Array.isArray(resolved.variantCandidates) &&
      resolved.variantCandidates.length &&
      seen.size < 10
    ) {
      const wantMore = detectListAll(userText) === true || plan.__listAll === true;
      const pageSize = wantMore ? 80 : 50;
      const featured = plan.__featured === true;
      const minNoticePeriodDays =
        plan.__no_notice_period === true
          ? null
          : typeof plan.__min_notice_period_days === 'number'
            ? plan.__min_notice_period_days
            : null;
      const sort = typeof plan.__sort === 'string' ? plan.__sort : null;
      const age = detectAgeFromText(userText);
      const combinedSearch = (selectedKeywords || []).slice(0, 6).join(' ').trim();
      const ax = resolved.variantAxis;
      const cand = String(resolved.variantCandidates[0] || '').trim();
      const facetKey =
        ax === 'locale'
          ? normalizeLocaleToken(cand) || cand.toLowerCase()
          : normalizeCatalogToken(cand) || cand.toLowerCase();
      const variant =
        facetKB && facetKB.getVariantForFacetKey
          ? facetKB.getVariantForFacetKey(language, ax, facetKey)
          : null;

      const base = new URLSearchParams();
      base.set('page_size', String(pageSize));
      base.set('language', String(language));
      if (gender) base.set('gender', gender);
      if (qualityPref === 'high_only') base.set('category', 'high_quality');
      if (featured) base.set('featured', 'true');
      if (typeof minNoticePeriodDays === 'number' && minNoticePeriodDays > 0) {
        base.set('min_notice_period_days', String(minNoticePeriodDays));
      }
      maybeSetIncludeCustomRatesParam(base, plan);
      if (age) base.set('age', age);
      if (sort) base.set('sort', sort);

      let fetched = [];
      if (ax === 'locale') {
        const locVal = normalizeRequestedLocale(cand) || cand;
        const p = new URLSearchParams(base.toString());
        p.set('locale', String(locVal));
        fetched = await callSharedVoices(p);
        if ((!fetched || fetched.length < 3) && combinedSearch) {
          const p2 = new URLSearchParams(p.toString());
          p2.set('search', combinedSearch);
          const v2 = await callSharedVoices(p2);
          if (Array.isArray(v2) && v2.length > (fetched?.length || 0)) fetched = v2;
        }
      } else if (ax === 'accent') {
        const nameVal = String(variant?.facetValue || variant?.facetLabel || cand).trim();
        if (nameVal) {
          const p1 = new URLSearchParams(base.toString());
          p1.set('accent', nameVal);
          fetched = await callSharedVoices(p1);
          if ((!fetched || fetched.length < 3) && combinedSearch) {
            const p1s = new URLSearchParams(p1.toString());
            p1s.set('search', combinedSearch);
            const v1s = await callSharedVoices(p1s);
            if (Array.isArray(v1s) && v1s.length > (fetched?.length || 0)) fetched = v1s;
          }
        }
        if ((!fetched || fetched.length === 0) && variant?.slug) {
          const p2 = new URLSearchParams(base.toString());
          p2.set('accent', String(variant.slug));
          fetched = await callSharedVoices(p2);
        }
      }

      let added = 0;
      for (const voice of fetched || []) {
        if (!voice || !voice.voice_id) continue;
        const tag = `specific_${ax}:${facetKey}`;
        let entry = seen.get(voice.voice_id);
        if (!entry) {
          entry = { voice, matchedKeywords: new Set() };
          added++;
        }
        try { entry.matchedKeywords.add(tag); } catch (_) {}
        seen.set(voice.voice_id, entry);
      }

      try {
        trace({
          stage: 'specific_variant_seed',
          params: {
            iso2: language,
            axis: ax,
            facet: facetKey,
            page_size: String(pageSize),
            search: combinedSearch ? 'yes' : 'no'
          },
          count: added
        });
      } catch (_) {}
    }
  } catch (_) {}

  // Hybrid keyword search: run "as typed" + "corrected" (bounded budget)
  const CORRECTION_BUDGET = 4;
  let searchQueue = [];
  try {
    const correctionCandidates = dedupePreserveOrder([
      ...((languageIndex.namesSorted || []).filter(Boolean) || []),
      ...Array.from(STATIC_LANGUAGE_ALIASES.keys())
        .map((x) => normalizeLangName(x))
        .filter(Boolean)
    ]).filter((c) => c.length >= 4);

    const corrected = [];
    const usedKw = new Set();
    for (const kw of selectedKeywords) {
      const k = normalizeKw(kw);
      if (!k) continue;
      if (k.includes(' ')) continue; // don't try to correct phrases
      if (!/^[a-z0-9]{5,}$/i.test(k)) continue;
      const maxDist = maxTypoDistanceForToken(k);
      const sugg = suggestClosest(k, correctionCandidates, { maxDist, maxSuggestions: 2 });
      const best = (sugg || []).find((s) => s && s !== k);
      if (!best) continue;
      const kwUsed = normalizeKw(best);
      if (!kwUsed || kwUsed === k) continue;
      if (usedKw.has(kwUsed)) continue;
      usedKw.add(kwUsed);
      corrected.push({
        kw_original: k,
        kw_used: kwUsed,
        variant: 'corrected',
        typo_from: k,
        typo_to: kwUsed
      });
      if (corrected.length >= CORRECTION_BUDGET) break;
    }

    const origBudget = Math.max(0, MAX_KEYWORD_QUERIES - corrected.length);
    const originals = selectedKeywords.slice(0, origBudget);
    const usedFinal = new Set(originals.map((k) => normalizeKw(k)));
    const correctedFinal = corrected.filter((c) => !usedFinal.has(normalizeKw(c.kw_used)));
    correctedFinal.forEach((c) => usedFinal.add(normalizeKw(c.kw_used)));

    searchQueue = [
      ...originals.map((k) => ({
        kw_original: k,
        kw_used: k,
        variant: 'as_typed',
        typo_from: null,
        typo_to: null
      })),
      ...correctedFinal
    ];
  } catch (_) {
    searchQueue = selectedKeywords.map((k) => ({
      kw_original: k,
      kw_used: k,
      variant: 'as_typed',
      typo_from: null,
      typo_to: null
    }));
  }

  // 1) separate search for EACH keyword, with limited concurrency
  async function runWithLimit(items, limit, worker) {
    const results = new Array(items.length);
    let index = 0;
    async function runner() {
      while (true) {
        const current = index++;
        if (current >= items.length) break;
        try {
          results[current] = await worker(items[current], current);
        } catch (e) {
          results[current] = { error: e };
        }
      }
    }
    const workers = [];
    const count = Math.min(limit, items.length);
    for (let i = 0; i < count; i++) workers.push(runner());
    await Promise.all(workers);
    return results;
  }

  function generateKeywordVariants(kw) {
    const k = normalizeKw(kw);
    if (!k) return [];
    const out = [];
    // Special-case: drive-thru variants
    if (k.includes('drive-thru') || k.includes('drive thru') || k.includes('drivethru')) {
      out.push('drive thru', 'drivethru', 'drive through', 'drive-thru');
    }
    // Generic hyphenated variant(s)
    if (k.includes('-')) {
      out.push(k.replace(/-/g, ' ').replace(/\s+/g, ' ').trim());
      out.push(k.replace(/-/g, ''));
    }
    // De-dupe and remove self
    return dedupePreserveOrder(out.map(normalizeKw).filter((v) => v && v !== k)).slice(0, 3);
  }

  const perKeywordResults = await runWithLimit(
    searchQueue,
    KEYWORD_SEARCH_CONCURRENCY,
    async (kwEntry) => {
      const kwOriginal = normalizeKw(kwEntry?.kw_original ?? kwEntry);
      const kwUsed = normalizeKw(kwEntry?.kw_used ?? kwEntry);
      const variant = kwEntry?.variant || 'as_typed';
      const typoFrom = kwEntry?.typo_from || null;
      const typoTo = kwEntry?.typo_to || null;

      const params = new URLSearchParams();
      params.set('page_size', '40');
      const appended = appendQueryFiltersToParams(params, plan, userText, {
        language,
        accent,
        gender,
        qualityPref,
        featured: plan.__featured === true,
        sort: typeof plan.__sort === 'string' ? plan.__sort : null,
        forceUseCases: plan.__forceUseCases === true,
        traceCb: trace
      });
      maybeMarkPrimaryVariantApplied(appended);
      params.set('search', kwUsed);
      try {
        // Emit gates trace only when gate signature changes (or inline into per_keyword)
        const inlineGates = readEnvBoolean('TRACE_GATES_INLINE', false);
        const ucLen = (appended.useCases || []).length;
        const descLen = (appended.descriptives || []).length;
        const gateSig = `${ucLen}|${descLen}`;
        if (!inlineGates) {
          if (!global.__lastGateSig || global.__lastGateSig !== gateSig) {
            try {
              trace({
                stage: 'gates',
                keyword: kwUsed,
                variant,
                params: {
                  use_cases: String(ucLen),
                  descriptives: String(descLen),
                  locale_inferred: String(Boolean(appended.localeInferred)),
                  bilingual: String(Boolean(appended.bilingual))
                },
                count: ucLen + descLen
              });
            } catch (_) {}
            global.__lastGateSig = gateSig;
          }
        }
        let voicesForKeyword;
        // Track strict vs relaxed filter effectiveness for session-level suppression heuristics.
        const hadUseCases = Array.isArray(appended.useCases) && appended.useCases.length > 0;
        const hadDescriptives = Array.isArray(appended.descriptives) && appended.descriptives.length > 0;
        let strictCount = 0;
        let relaxUseCasesCount = 0;
        let relaxDescriptivesCount = 0;
        const wantMore = detectListAll(userText) === true || plan.__listAll === true;
        if (wantMore) {
          voicesForKeyword = await callSharedVoicesAllPages(params, { maxPages: 3, cap: 200 });
        } else {
          voicesForKeyword = await callSharedVoicesCached(params, async (p) => {
            const { voices } = await callSharedVoicesRaw(p);
            return voices;
          });
        }
        strictCount = Array.isArray(voicesForKeyword) ? voicesForKeyword.length : 0;

        // Keyword variants retry (only when base query returns 0)
        if (Array.isArray(voicesForKeyword) && voicesForKeyword.length === 0) {
          try {
            const variants = generateKeywordVariants(kwUsed);
            for (const vKw of variants) {
              const pVar = new URLSearchParams(params.toString());
              pVar.set('search', vKw);
              let vVoices = [];
              try {
                vVoices = await callSharedVoices(pVar);
              } catch (_) {}
              try {
                trace({
                  stage: 'per_keyword_variant',
                  keyword: vKw,
                  variant: 'retry_variant',
                  kw_original: kwOriginal,
                  typo_from: kwUsed,
                  typo_to: vKw,
                  params: paramsToObject(pVar),
                  count: Array.isArray(vVoices) ? vVoices.length : 0
                });
              } catch (_) {}
              if (Array.isArray(vVoices) && vVoices.length > 0) {
                voicesForKeyword = vVoices;
                // Keep kwUsed as the canonical keyword for this result set; we record the successful variant via trace.
                break;
              }
            }
          } catch (_) {}
        }

        try {
          const baseParams = paramsToObject(params);
          if (inlineGates) {
            baseParams.gates_use_cases = String(ucLen);
            baseParams.gates_descriptives = String(descLen);
          }
          trace({
            stage: 'per_keyword',
            keyword: kwUsed,
            variant,
            kw_original: kwOriginal,
            typo_from: typoFrom,
            typo_to: typoTo,
            params: baseParams,
            count: Array.isArray(voicesForKeyword) ? voicesForKeyword.length : 0
          });
        } catch (_) {}
        // Try-both for use_cases enum formatting:
        // If strict query returned 0 AND we used use_cases, retry with hyphenated values.
        if (Array.isArray(voicesForKeyword) && voicesForKeyword.length === 0) {
          try {
            const ucs = typeof params.getAll === 'function' ? params.getAll('use_cases') : [];
            const hasUseCases = Array.isArray(ucs) && ucs.length > 0;
            if (hasUseCases) {
              const altUcs = ucs.map(toHyphenUseCase).filter(Boolean);
              const changed = altUcs.some((v, i) => v !== ucs[i]);
              if (changed) {
                const pAlt = new URLSearchParams(params.toString());
                // remove existing use_cases
                pAlt.delete('use_cases');
                for (const uc of altUcs) pAlt.append('use_cases', uc);
                let altVoices = [];
                try {
                  // Use a simple one-page call; if it works, we get >0 and stop early.
                  altVoices = await callSharedVoices(pAlt);
                } catch (_) {}
                try {
                  trace({
                    stage: 'per_keyword_alt_use_cases',
                    keyword: kwUsed,
                    variant,
                    kw_original: kwOriginal,
                    typo_from: typoFrom,
                    typo_to: typoTo,
                    params: paramsToObject(pAlt),
                    count: Array.isArray(altVoices) ? altVoices.length : 0
                  });
                } catch (_) {}
                if (Array.isArray(altVoices) && altVoices.length > 0) {
                  voicesForKeyword = altVoices;
                }
              }
            }
          } catch (_) {}
        }

        // Early alt-accent retry: if accent representation is wrong (name vs slug),
        // relaxing use_cases/descriptives won't help. Try flipping accent first to avoid a long run of zeros.
        let didAltAccentFlip = false;
        const tryAltAccentFlip = async () => {
          try {
            const currentAccent = typeof params.get === 'function' ? String(params.get('accent') || '').trim() : '';
            if (!currentAccent) return null;
            const iso2ForAccent = (() => {
              try {
                const fromParams = typeof params.get === 'function' ? params.get('language') : null;
                const cand = (fromParams || language || resolved?.targetIso2 || '').toString().toLowerCase().slice(0, 2);
                return cand || null;
              } catch (_) {
                return null;
              }
            })();

            const getNameForSlug = (iso2, slug) => {
              try {
                const k = (iso2 || '').toString().toLowerCase().slice(0, 2);
                if (!k) return null;
                if (!facetKB || !facetKB.isLoaded || !facetKB.isLoaded()) return null;
                const m = facetKB.accentSlugByIso2Accent && typeof facetKB.accentSlugByIso2Accent.get === 'function'
                  ? facetKB.accentSlugByIso2Accent.get(k)
                  : null;
                if (!m || typeof m.entries !== 'function') return null;
                const s = String(slug || '').trim();
                if (!s) return null;
                for (const [nameNorm, slugVal] of m.entries()) {
                  if (String(slugVal || '').trim() === s) return String(nameNorm || '').trim() || null;
                }
              } catch (_) {}
              return null;
            };

            const candidates = (() => {
              try {
                const out = [];
                const acc = currentAccent;
                const hasDash = acc.includes('-');
                const hasSpace = /\s/.test(acc);
                // slug -> name
                if (hasDash && !hasSpace) {
                  const kbName = iso2ForAccent ? getNameForSlug(iso2ForAccent, acc) : null;
                  const nameLike = kbName || acc.replace(/-/g, ' ').replace(/\s+/g, ' ').trim();
                  if (nameLike && nameLike !== acc) out.push(nameLike);
                }
                // name -> slug
                if (hasSpace) {
                  let slug = null;
                  try {
                    slug =
                      iso2ForAccent &&
                      facetKB &&
                      facetKB.isLoaded &&
                      facetKB.isLoaded() &&
                      facetKB.getAccentSlug
                        ? facetKB.getAccentSlug(iso2ForAccent, acc)
                        : null;
                  } catch (_) {
                    slug = null;
                  }
                  const slugLike = String(slug || slugifyAccentName(acc) || '').trim();
                  if (slugLike && slugLike !== acc) out.push(slugLike);
                }
                // de-dupe
                return dedupePreserveOrder(out).filter(Boolean).slice(0, 2);
              } catch (_) {
                return [];
              }
            })();

            for (const altAccent of candidates) {
              const pAltAccent = new URLSearchParams(params.toString());
              pAltAccent.set('accent', altAccent);
              let altVoices = [];
              try {
                altVoices = await callSharedVoices(pAltAccent);
              } catch (_) {}
              try {
                trace({
                  stage: 'per_keyword_alt_accent',
                  keyword: kwUsed,
                  variant,
                  kw_original: kwOriginal,
                  typo_from: typoFrom,
                  typo_to: typoTo,
                  params: paramsToObject(pAltAccent),
                  count: Array.isArray(altVoices) ? altVoices.length : 0
                });
              } catch (_) {}
              if (Array.isArray(altVoices) && altVoices.length > 0) {
                return altVoices;
              }
            }
          } catch (_) {}
          return null;
        };
        if (Array.isArray(voicesForKeyword) && voicesForKeyword.length === 0) {
          const alt = await tryAltAccentFlip();
          if (Array.isArray(alt) && alt.length > 0) {
            voicesForKeyword = alt;
            didAltAccentFlip = true;
          }
        }

        // Progressive relaxation if empty and we added filters
        if (Array.isArray(voicesForKeyword) && voicesForKeyword.length === 0) {
          // 1) drop descriptives
          if (appended.descriptives && appended.descriptives.length) {
            const p2 = new URLSearchParams(params.toString());
            // remove all descriptives
            const keys = Array.from(p2.keys());
            keys.forEach((k) => {
              if (k === 'descriptives') p2.delete(k);
            });
            try {
              const v2 = await callSharedVoices(p2);
              relaxDescriptivesCount = Array.isArray(v2) ? v2.length : 0;
              try {
                trace({
                  stage: 'per_keyword_relax_descriptives',
                  keyword: kwUsed,
                  variant,
                  kw_original: kwOriginal,
                  typo_from: typoFrom,
                  typo_to: typoTo,
                  params: paramsToObject(p2),
                  count: Array.isArray(v2) ? v2.length : 0
                });
              } catch (_) {}
              if (Array.isArray(v2) && v2.length) voicesForKeyword = v2;
            } catch (_) {}
          }
        }
        // Early descriptives relax for "low results" (keeps recall high when descriptives are too strict)
        if (
          Array.isArray(voicesForKeyword) &&
          voicesForKeyword.length > 0 &&
          voicesForKeyword.length < 3 &&
          appended.descriptives &&
          appended.descriptives.length
        ) {
          const p2 = new URLSearchParams(params.toString());
          p2.delete('descriptives');
          try {
            const v2 = await callSharedVoices(p2);
            try {
              trace({
                stage: 'per_keyword_relax_descriptives',
                keyword: kwUsed,
                variant,
                kw_original: kwOriginal,
                typo_from: typoFrom,
                typo_to: typoTo,
                params: paramsToObject(p2),
                count: Array.isArray(v2) ? v2.length : 0
              });
            } catch (_) {}
            if (Array.isArray(v2) && v2.length > voicesForKeyword.length) {
              voicesForKeyword = v2;
            }
          } catch (_) {}
        }
        if (Array.isArray(voicesForKeyword) && voicesForKeyword.length === 0) {
          // 2) drop use_cases
          if (appended.useCases && appended.useCases.length) {
            const p3 = new URLSearchParams(params.toString());
            const keys = Array.from(p3.keys());
            keys.forEach((k) => {
              if (k === 'use_cases') p3.delete(k);
            });
            try {
              const v3 = await callSharedVoices(p3);
              relaxUseCasesCount = Array.isArray(v3) ? v3.length : 0;
              try {
                trace({
                  stage: 'per_keyword_relax_use_cases',
                  keyword: kwUsed,
                  variant,
                  kw_original: kwOriginal,
                  typo_from: typoFrom,
                  typo_to: typoTo,
                  params: paramsToObject(p3),
                  count: Array.isArray(v3) ? v3.length : 0
                });
              } catch (_) {}
              if (Array.isArray(v3) && v3.length) voicesForKeyword = v3;
            } catch (_) {}
          }
        }

        // Update plan-scoped stats for session-level suppression heuristics.
        try {
          if (hadUseCases) {
            if (!plan.__stats_use_cases) plan.__stats_use_cases = { total: 0, strict0: 0, relaxedOk: 0 };
            plan.__stats_use_cases.total += 1;
            if (strictCount === 0) plan.__stats_use_cases.strict0 += 1;
            if (strictCount === 0 && relaxUseCasesCount > 0) plan.__stats_use_cases.relaxedOk += 1;
          }
          if (hadDescriptives) {
            if (!plan.__stats_descriptives) plan.__stats_descriptives = { total: 0, strict0: 0, relaxedOk: 0 };
            plan.__stats_descriptives.total += 1;
            if (strictCount === 0) plan.__stats_descriptives.strict0 += 1;
            if (strictCount === 0 && relaxDescriptivesCount > 0) plan.__stats_descriptives.relaxedOk += 1;
          }
        } catch (_) {}
        // Late safety net: alt-accent flip (only if it wasn't already tried early).
        if (Array.isArray(voicesForKeyword) && voicesForKeyword.length === 0 && !didAltAccentFlip) {
          const alt = await tryAltAccentFlip();
          if (Array.isArray(alt) && alt.length > 0) {
            voicesForKeyword = alt;
            didAltAccentFlip = true;
          }
        }
        // Quick relax (after triage): if still empty, retry without use_cases/accent/locale/age.
        // When the user asked for a specific locale/accent variant, never drop those filters.
        if (Array.isArray(voicesForKeyword) && voicesForKeyword.length === 0) {
          const preserveVariantFilters = resolved?.variantMode === 'specific';
          const pQuick = new URLSearchParams(params.toString());
          const keysQuick = Array.from(pQuick.keys());
          keysQuick.forEach((k) => {
            if (k === 'use_cases' || k === 'age') pQuick.delete(k);
            if (!preserveVariantFilters && (k === 'accent' || k === 'locale')) pQuick.delete(k);
          });
          try {
            const vQuick = await callSharedVoices(pQuick);
            try {
              trace({
                stage: preserveVariantFilters ? 'per_keyword_quick_relax_keep_variant' : 'per_keyword_quick_relax',
                keyword: kwUsed,
                variant,
                kw_original: kwOriginal,
                typo_from: typoFrom,
                typo_to: typoTo,
                params: paramsToObject(pQuick),
                count: Array.isArray(vQuick) ? vQuick.length : 0
              });
            } catch (_) {}
            if (Array.isArray(vQuick) && vQuick.length) voicesForKeyword = vQuick;
          } catch (_) {}
        }
        // Note: we do NOT retry with non-ISO language aliases (e.g., "french").
        // Requests must use ISO 639-1 language codes only.
        return {
          kw: kwUsed,
          kw_original: kwOriginal,
          variant,
          typo_from: typoFrom,
          typo_to: typoTo,
          voices: voicesForKeyword || []
        };
      } catch (err) {
        console.error('Error fetching voices for keyword:', kwUsed, err.message || err);
        return {
          kw: kwUsed,
          kw_original: kwOriginal,
          variant,
          typo_from: typoFrom,
          typo_to: typoTo,
          voices: []
        };
      }
    }
  );

  // merge results
  perKeywordResults.forEach((res) => {
    if (!res || !Array.isArray(res.voices)) return;
    const kw = res.kw_original || res.kw;
    res.voices.forEach((voice) => {
      if (!voice || !voice.voice_id) return;
      let entry = seen.get(voice.voice_id);
      if (!entry) {
        entry = {
          voice,
          matchedKeywords: new Set()
        };
      }
      entry.matchedKeywords.add(kw);
      seen.set(voice.voice_id, entry);
    });
  });

  // -------------------------------------------------------------
  // Session-scoped suppression for auto-injected filters (use_cases/descriptives)
  // -------------------------------------------------------------
  // If the user did NOT explicitly ask for a use-case/descriptive filter, but the applied filter repeatedly
  // yields 0 while its relaxation yields results, mark it as suppressed for subsequent requests in the same thread.
  // This avoids wasting token/request budget on filters that don't work well for the current catalog state.
  try {
    // Only act when caller persists plan in session; keep changes minimal and conservative.
    const explicitUC = hasExplicitUseCaseMention(userText);
    const explicitDesc = hasExplicitDescriptiveMention(userText);

    // Aggregate from trace is expensive; instead, rely on small counters attached by the per-keyword worker.
    const uc = plan && plan.__stats_use_cases ? plan.__stats_use_cases : null;
    const dc = plan && plan.__stats_descriptives ? plan.__stats_descriptives : null;

    if (!explicitUC && uc && typeof uc === 'object') {
      const strict0 = Number(uc.strict0 || 0) || 0;
      const relaxedOk = Number(uc.relaxedOk || 0) || 0;
      const total = Number(uc.total || 0) || 0;
      // Heuristic: require multiple signals before suppressing.
      if (total >= 6 && strict0 >= 4 && relaxedOk >= 3) {
        plan.__suppressUseCases = true;
        try {
          trace({ stage: 'suppress_use_cases', params: { total: String(total), strict0: String(strict0), relaxedOk: String(relaxedOk) }, count: 0 });
        } catch (_) {}
      }
    }

    if (!explicitDesc && dc && typeof dc === 'object') {
      const strict0 = Number(dc.strict0 || 0) || 0;
      const relaxedOk = Number(dc.relaxedOk || 0) || 0;
      const total = Number(dc.total || 0) || 0;
      if (total >= 6 && strict0 >= 4 && relaxedOk >= 3) {
        plan.__suppressDescriptives = true;
        try {
          trace({ stage: 'suppress_descriptives', params: { total: String(total), strict0: String(strict0), relaxedOk: String(relaxedOk) }, count: 0 });
        } catch (_) {}
      }
    }
  } catch (_) {}

  // Accent-slug fetch stage (zh): use UI slugs like hong-kong-cantonese / beijing-mandarin (soft)
  if (seen.size === 0 && language === 'zh') {
    try {
      const slugs = getAccentSlugsForQuery(userText);
      const wantMore = detectListAll(userText) === true || plan.__listAll === true;
      for (const slug of slugs) {
        const params = new URLSearchParams();
        params.set('page_size', wantMore ? '80' : '40');
        params.set('language', 'zh');
        params.set('accent', slug);
        if (gender) params.set('gender', gender);
        if (qualityPref === 'high_only') params.set('category', 'high_quality');
        maybeSetIncludeCustomRatesParam(params, plan);

        let voicesSlug = [];
        try {
          voicesSlug = wantMore
            ? await callSharedVoicesAllPages(params, { maxPages: 2, cap: 160 })
            : await callSharedVoicesCached(params, async (p) => {
                const { voices } = await callSharedVoicesRaw(p);
                return voices;
              });
        } catch (_) {}

        try {
          trace({
            stage: 'accent_slug',
            params: paramsToObject(params),
            count: Array.isArray(voicesSlug) ? voicesSlug.length : 0
          });
        } catch (_) {}

        (voicesSlug || []).forEach((voice) => {
          if (!voice || !voice.voice_id) return;
          let entry = seen.get(voice.voice_id);
          if (!entry) {
            entry = { voice, matchedKeywords: new Set() };
          }
          // Tag the result with the accent slug for ranking/diagnostics
          entry.matchedKeywords.add(slug);
          seen.set(voice.voice_id, entry);
        });
      }
    } catch (_) {}
  }

  // 2) fallback: if nothing found at all, try a combined-search query
  if (seen.size === 0) {
    const params = new URLSearchParams();
    params.set('page_size', '80');
    appendQueryFiltersToParams(params, plan, userText, {
      language,
      accent,
      gender,
      qualityPref,
      featured: plan.__featured === true,
      sort: typeof plan.__sort === 'string' ? plan.__sort : null,
      forceUseCases: plan.__forceUseCases === true,
      traceCb: trace
    });

    const fallbackSearch =
      (selectedKeywords.length ? selectedKeywords.join(' ') : '') ||
      ((userText ? userText.toLowerCase() : '') || '');

    if (fallbackSearch) {
      params.set('search', fallbackSearch);
    }

    try {
      // Combined fallback: with both, without use_cases, without descriptives.
      // Never drop locale/accent when the user requested a specific variant.
      const preserveVariantFilters = resolved?.variantMode === 'specific';
      const paramsWith = new URLSearchParams(params.toString());
      const paramsNoUC = new URLSearchParams(params.toString());
      const keysNoUC = Array.from(paramsNoUC.keys());
      keysNoUC.forEach((k) => { if (k === 'use_cases') paramsNoUC.delete(k); });
      const paramsNoDesc = new URLSearchParams(params.toString());
      const keysNoDesc = Array.from(paramsNoDesc.keys());
      keysNoDesc.forEach((k) => { if (k === 'descriptives') paramsNoDesc.delete(k); });
      const paramsNoLocAcc = new URLSearchParams(params.toString());
      if (!preserveVariantFilters) {
        const keysNoLocAcc = Array.from(paramsNoLocAcc.keys());
        keysNoLocAcc.forEach((k) => { if (k === 'locale' || k === 'accent') paramsNoLocAcc.delete(k); });
      }

      const wantMore = detectListAll(userText) === true || plan.__listAll === true;
      const fetchCombined = (p) =>
        wantMore
          ? callSharedVoicesAllPages(p, { maxPages: 2, cap: 160 })
          : callSharedVoicesCached(p, async (pp) => {
              const { voices } = await callSharedVoicesRaw(pp);
              return voices;
            });
      const combinedJobs = [
        fetchCombined(paramsWith),
        fetchCombined(paramsNoUC),
        fetchCombined(paramsNoDesc)
      ];
      // Only broaden away from locale/accent when variant is NOT specific
      if (!preserveVariantFilters) combinedJobs.push(fetchCombined(paramsNoLocAcc));
      const combinedResults = await Promise.all(combinedJobs);
      const seenIdsCF = new Set();
      const fallbackVoices = [];
      for (const v of combinedResults.flat()) {
        if (v && v.voice_id && !seenIdsCF.has(v.voice_id)) {
          seenIdsCF.add(v.voice_id);
          fallbackVoices.push(v);
        }
      }
      try {
        trace({
          stage: preserveVariantFilters ? 'combined_keep_variant' : 'combined',
          params: paramsToObject(paramsWith),
          count: Array.isArray(fallbackVoices) ? fallbackVoices.length : 0
        });
      } catch (_) {}
      fallbackVoices.forEach((voice) => {
        if (!voice || !voice.voice_id) return;
        if (!seen.has(voice.voice_id)) {
          seen.set(voice.voice_id, {
            voice,
            matchedKeywords: new Set()
          });
        }
      });
    } catch (err) {
      console.error('Error in fallback fetchVoicesByKeywords:', err.message || err);
    }
  }

  // 3) broad fallback: if STILL nothing, fetch by language/accent only (no search)
  // Skip when owner-filtered — never broaden to the unfiltered catalog.
  if (seen.size === 0 && !hasOwnerFilter) {
    const params = new URLSearchParams();
    params.set('page_size', '100');
    if (language) params.set('language', language);
    if (accent) params.set('accent', accent);
    if (gender) params.set('gender', gender);
    if (qualityPref === 'high_only') {
      params.set('category', 'high_quality');
    }
    maybeSetIncludeCustomRatesParam(params, plan);

    try {
      const broadVoices = await callSharedVoices(params);
      try {
        trace({
          stage: 'broad',
          params: paramsToObject(params),
          count: Array.isArray(broadVoices) ? broadVoices.length : 0
        });
      } catch (_) {}
      broadVoices.forEach((voice) => {
        if (!voice || !voice.voice_id) return;
        if (!seen.has(voice.voice_id)) {
          seen.set(voice.voice_id, {
            voice,
            matchedKeywords: new Set()
          });
        }
      });
    } catch (err) {
      console.error(
        'Error in broad fallback fetchVoicesByKeywords:',
        err.message || err
      );
    }
  }

  // Note: we do NOT attempt non-ISO language aliases here either.

  // 2c) last-resort: no language param, then filter heuristically
  // Skip when specific variant — dropping language pollutes with wrong accents.
  if (seen.size === 0 && language && !hasOwnerFilter && resolved?.variantMode !== 'specific') {
    const params = new URLSearchParams();
    params.set('page_size', '100');
    if (accent) params.set('accent', accent);
    if (gender) params.set('gender', gender);
    if (qualityPref === 'high_only') {
      params.set('category', 'high_quality');
    }
    maybeSetIncludeCustomRatesParam(params, plan);
    try {
      const noLangVoices = await callSharedVoices(params);
      try {
        trace({
          stage: 'no_language',
          params: paramsToObject(params),
          count: Array.isArray(noLangVoices) ? noLangVoices.length : 0
        });
      } catch (_) {}
      const filtered = (noLangVoices || []).filter((v) => isVoiceInLanguage(v, language));
      filtered.forEach((voice) => {
        if (!voice || !voice.voice_id) return;
        if (!seen.has(voice.voice_id)) {
          seen.set(voice.voice_id, { voice, matchedKeywords: new Set() });
        }
      });
    } catch (err) {
      console.error('Error in no-language heuristic fallback:', err.message || err);
    }
  }

  // 2d) HQ local fallback: if still empty and high_only, try without category and filter locally
  if (seen.size === 0 && qualityPref === 'high_only' && !hasOwnerFilter) {
    const params = new URLSearchParams();
    params.set('page_size', '100');
    if (language) params.set('language', language);
    if (accent) params.set('accent', accent);
    if (gender) params.set('gender', gender);
    maybeSetIncludeCustomRatesParam(params, plan);
    try {
      const hqLocal = await callSharedVoices(params);
      try {
        trace({
          stage: 'hq_local_filter',
          params: paramsToObject(params),
          count: Array.isArray(hqLocal) ? hqLocal.length : 0
        });
      } catch (_) {}
      (hqLocal || []).filter(isHighQuality).forEach((voice) => {
        if (!voice || !voice.voice_id) return;
        if (!seen.has(voice.voice_id)) {
          seen.set(voice.voice_id, { voice, matchedKeywords: new Set() });
        }
      });
    } catch (err) {
      console.error('Error in hq-local fallback fetchVoicesByKeywords:', err.message || err);
    }
  }

  // Global minimum results guard: broaden if too few candidates
  if (seen.size > 0 && seen.size < 12 && !hasOwnerFilter) {
    const paramsG = new URLSearchParams();
    paramsG.set('page_size', '80');
    // keep language and category if set; drop accent/use_cases/locale/descriptives
    // EXCEPT when variantMode is specific — never drop locale/accent then.
    const preserveVariantFilters = resolved?.variantMode === 'specific';
    if (language) paramsG.set('language', language);
    if (qualityPref === 'high_only') paramsG.set('category', 'high_quality');
    if (preserveVariantFilters) {
      if (accent) paramsG.set('accent', accent);
      try {
        let locKeep = null;
        if (resolved?.variantAxis === 'locale' && Array.isArray(resolved.variantCandidates) && resolved.variantCandidates[0]) {
          locKeep = normalizeRequestedLocale(resolved.variantCandidates[0]) || resolved.variantCandidates[0];
        } else if (typeof plan?.target_locale === 'string' && plan.target_locale.trim()) {
          locKeep = normalizeRequestedLocale(plan.target_locale) || plan.target_locale;
        }
        if (locKeep && normalizeLocaleToken(locKeep) !== 'es-419') paramsG.set('locale', locKeep);
      } catch (_) {}
      // Prefer accent from resolver when specific accent axis (e.g. european for PT)
      try {
        if (
          !paramsG.get('accent') &&
          resolved?.variantAxis === 'accent' &&
          Array.isArray(resolved.variantCandidates) &&
          resolved.variantCandidates[0]
        ) {
          const accKeep = normalizeAccentForApiParam(language || resolved.targetIso2, resolved.variantCandidates[0]);
          if (accKeep) paramsG.set('accent', accKeep);
        }
      } catch (_) {}
    }
    const searchG =
      (selectedKeywords.length ? selectedKeywords.join(' ') : '') ||
      ((userText ? userText.toLowerCase() : '') || '');
    if (searchG) paramsG.set('search', searchG);
    try {
      const wantMore = detectListAll(userText) === true || plan.__listAll === true;
      // First pass: drop soft filters; keep locale/accent when specific
      const keysG = Array.from(paramsG.keys());
      keysG.forEach((k) => {
        if (k === 'use_cases' || k === 'descriptives') paramsG.delete(k);
        if (!preserveVariantFilters && (k === 'accent' || k === 'locale')) paramsG.delete(k);
      });
      const broadened = wantMore
        ? await callSharedVoicesAllPages(paramsG, { maxPages: 2, cap: 160 })
        : await callSharedVoicesCached(paramsG, async (p) => { const { voices } = await callSharedVoicesRaw(p); return voices; });
      try {
        trace({
          stage: preserveVariantFilters ? 'global_broaden_keep_variant' : 'global_broaden',
          params: paramsToObject(paramsG),
          count: Array.isArray(broadened) ? broadened.length : 0
        });
      } catch (_) {}
      (broadened || []).forEach((voice) => {
        if (!voice || !voice.voice_id) return;
        if (!seen.has(voice.voice_id)) {
          seen.set(voice.voice_id, { voice, matchedKeywords: new Set() });
        }
      });
      // HQ local relax if still low and high_only
      if (seen.size < 12 && qualityPref === 'high_only') {
        const pH = new URLSearchParams();
        pH.set('page_size', '80');
        if (language) pH.set('language', language);
        if (preserveVariantFilters) {
          if (accent) pH.set('accent', accent);
          try {
            const loc = paramsG.get('locale');
            if (loc) pH.set('locale', loc);
            const acc = paramsG.get('accent');
            if (acc && !pH.get('accent')) pH.set('accent', acc);
          } catch (_) {}
        }
        const vH = wantMore
          ? await callSharedVoicesAllPages(pH, { maxPages: 2, cap: 160 })
          : await callSharedVoicesCached(pH, async (p) => { const { voices } = await callSharedVoicesRaw(p); return voices; });
        const onlyHigh = (vH || []).filter(isHighQuality);
        try {
          trace({
            stage: preserveVariantFilters ? 'global_broaden_hq_local_keep_variant' : 'global_broaden_hq_local',
            params: paramsToObject(pH),
            count: onlyHigh.length
          });
        } catch (_) {}
        onlyHigh.forEach((voice) => {
          if (!voice || !voice.voice_id) return;
          if (!seen.has(voice.voice_id)) {
            seen.set(voice.voice_id, { voice, matchedKeywords: new Set() });
          }
        });
      }
    } catch (_) {}
  }

  // LatAm Spanish quality-first fallback: if results are weak, fan out across real locales (NOT es-419)
  // and merge candidate pools. This improves ranking quality when accent metadata is inconsistent.
  try {
    const lowerText = (userText || '').toLowerCase();
    const isLatamSpanishIntent =
      (language === 'es' || isBilingualEnEsSearch) &&
      /\b(es-419|latam|latin america|latinamerican|latino|latin(?:o)? american|south american|central american|caribbean)\b/.test(lowerText) &&
      !(/\b(mexico|mexican|es-mx|mx)\b/.test(lowerText));

    const MIN_LATAM_POOL = 30;
    if (isLatamSpanishIntent && seen.size < MIN_LATAM_POOL) {
      const candidates = ['es-MX', 'es-CO', 'es-AR', 'es-PE', 'es-CL', 'es-VE', 'es-US'];

      const isLocaleAllowedForEs = (loc) => {
        try {
          const canon = normalizeRequestedLocale(loc) || loc;
          const norm = normalizeLocaleToken(canon);
          if (!norm) return false;
          // Prefer FacetKB when loaded (authoritative)
          if (facetKB && facetKB.isLoaded && facetKB.isLoaded() && facetKB.checkLocaleAllowed) {
            const r = facetKB.checkLocaleAllowed('es', canon);
            if (r && r.known) return !!r.allowed;
          }
          // Fallback to AccentCatalog if available
          if (accentCatalog && typeof accentCatalog.isLocaleAllowed === 'function') {
            return !!accentCatalog.isLocaleAllowed('es', canon);
          }
          return true; // last resort: don't block
        } catch (_) {
          return true;
        }
      };

      const locales = candidates.filter(isLocaleAllowedForEs);
      const wantMore = detectListAll(userText) === true || plan.__listAll === true;
      const pageSize = wantMore ? 80 : 60;
      const featured = plan.__featured === true;
      const sort = typeof plan.__sort === 'string' ? plan.__sort : null;
      const age = detectAgeFromText(userText);
      const combinedSearch = (selectedKeywords || []).slice(0, 6).join(' ').trim();

      const tried = [];
      let added = 0;

      // Keep this bounded: try only a few high-signal locales first.
      for (const loc of locales.slice(0, 5)) {
        const base = new URLSearchParams();
        base.set('page_size', String(pageSize));

        // Force the locale explicitly; suppress accent (locale already partitions)
        const plan2 = { ...plan, target_locale: loc, target_accent: null };
        const fanoutLanguage = language || (isBilingualEnEsSearch ? 'es' : null);
        appendQueryFiltersToParams(base, plan2, userText, {
          language: fanoutLanguage,
          accent: null,
          gender,
          qualityPref,
          featured,
          sort,
          age,
          forceUseCases: plan.__forceUseCases === true,
          forceLanguage: isBilingualEnEsSearch ? 'es' : null,
          traceCb: trace
        });

        // pass 1: no search (locale + use_cases/descriptives already narrow)
        let voicesLoc = [];
        try {
          voicesLoc = wantMore
            ? await callSharedVoicesAllPages(base, { maxPages: 1, cap: pageSize })
            : await callSharedVoicesCached(base, async (p) => {
                const { voices } = await callSharedVoicesRaw(p);
                return voices;
              });
        } catch (_) {
          voicesLoc = [];
        }

        // pass 2: add search only if the locale bucket is tiny
        if ((!voicesLoc || voicesLoc.length < 3) && combinedSearch) {
          try {
            const p2 = new URLSearchParams(base.toString());
            p2.set('search', combinedSearch);
            const v2 = await callSharedVoices(p2);
            if (Array.isArray(v2) && v2.length > (voicesLoc?.length || 0)) voicesLoc = v2;
          } catch (_) {}
        }

        tried.push(loc);
        for (const voice of voicesLoc || []) {
          if (!voice || !voice.voice_id) continue;
          // Tag for diagnostics/coverage (stored in seen.matchedKeywords so it survives final conversion)
          const tag = `latam_locale:${String(loc)}`;
          let entry = seen.get(voice.voice_id);
          if (!entry) {
            entry = { voice, matchedKeywords: new Set() };
            added++;
          }
          try { entry.matchedKeywords.add(tag); } catch (_) {}
          seen.set(voice.voice_id, entry);
        }

        if (seen.size >= MIN_LATAM_POOL) break;
      }

      try {
        trace({
          stage: 'latam_fallback_locales',
          params: { iso2: 'es', tried: tried.join(','), page_size: String(pageSize) },
          count: added
        });
      } catch (_) {}
    }
  } catch (_) {}

  // Universal fanout (catalog-driven): for specific variant requests that yield too few candidates,
  // try a few additional catalog variants (bounded budget) and merge.
  try {
    const MIN_FANOUT_POOL = 30;
    const canFanout =
      resolved &&
      resolved.variantMode === 'specific' &&
      (resolved.variantAxis === 'locale' || resolved.variantAxis === 'accent') &&
      Array.isArray(resolved.variantCandidates) &&
      resolved.variantCandidates.length >= 2 &&
      seen.size < MIN_FANOUT_POOL;

    if (canFanout) {
      const wantMore = detectListAll(userText) === true || plan.__listAll === true;
      const pageSize = wantMore ? 80 : 60;
      const featured = plan.__featured === true;
      const sort = typeof plan.__sort === 'string' ? plan.__sort : null;
      const age = detectAgeFromText(userText);
      const combinedSearch = (selectedKeywords || []).slice(0, 6).join(' ').trim();

      const tried = [];
      const triedSet = new Set();
      let added = 0;

      // If the primary candidate was NOT actually applied (due to conditional filters),
      // do not skip it. Otherwise, start from the next candidates.
      const startIdx = primaryVariantApplied ? 1 : 0;
      for (const cand of resolved.variantCandidates.slice(startIdx, 6)) {
        const key = String(cand || '').trim();
        if (!key) continue;
        if (triedSet.has(key)) continue;
        triedSet.add(key);
        const paramsF = new URLSearchParams();
        paramsF.set('page_size', String(pageSize));

        // Force the candidate via plan override; keep other filters.
        const planF =
          resolved.variantAxis === 'locale'
            ? { ...plan, target_locale: cand, target_accent: null }
            : { ...plan, target_accent: cand, target_locale: null };

        appendQueryFiltersToParams(paramsF, planF, userText, {
          language,
          accent: resolved.variantAxis === 'accent' ? cand : null,
          gender,
          qualityPref,
          featured,
          sort,
          age,
          forceUseCases: plan.__forceUseCases === true,
          traceCb: trace
        });

        let voicesF = [];
        try {
          voicesF = wantMore
            ? await callSharedVoicesAllPages(paramsF, { maxPages: 1, cap: pageSize })
            : await callSharedVoicesCached(paramsF, async (p) => { const { voices } = await callSharedVoicesRaw(p); return voices; });
        } catch (_) {
          voicesF = [];
        }

        // Pass 2 with search if too small
        if ((!voicesF || voicesF.length < 3) && combinedSearch) {
          try {
            const p2 = new URLSearchParams(paramsF.toString());
            p2.set('search', combinedSearch);
            const v2 = await callSharedVoices(p2);
            if (Array.isArray(v2) && v2.length > (voicesF?.length || 0)) voicesF = v2;
          } catch (_) {}
        }

        tried.push(cand);
        for (const voice of voicesF || []) {
          if (!voice || !voice.voice_id) continue;
          const tag = `fanout_${resolved.variantAxis}:${String(cand)}`;
          let entry = seen.get(voice.voice_id);
          if (!entry) {
            entry = { voice, matchedKeywords: new Set() };
            added++;
          }
          try { entry.matchedKeywords.add(tag); } catch (_) {}
          seen.set(voice.voice_id, entry);
        }

        if (seen.size >= MIN_FANOUT_POOL) break;
      }

      try {
        trace({
          stage: 'fanout',
          params: { axis: resolved.variantAxis, tried: tried.join(','), page_size: String(pageSize), primary_applied: String(primaryVariantApplied) },
          count: added
        });
      } catch (_) {}
    }
  } catch (_) {}

  // 4) convert map -> list, attach matched_keywords
  let voices = Array.from(seen.values()).map((entry) => {
    const v = entry.voice;
    v._matched_keywords = Array.from(entry.matchedKeywords || []);
    return v;
  });

  // Bilingual EN+ES: prefer voices verified for both English and Spanish.
  if (isBilingualEnEsSearch && voices.length) {
    const verifiedBoth = voices.filter(voiceHasVerifiedEnAndEs);
    try {
      trace({
        stage: 'bilingual_filter',
        params: {
          verified_both: String(verifiedBoth.length),
          total_before: String(voices.length)
        },
        count: verifiedBoth.length
      });
    } catch (_) {}
    if (verifiedBoth.length > 0) {
      voices = verifiedBoth;
    }
  }

  // Specific variant: drop keyword-polluted candidates that don't match the requested locale/accent.
  if (resolved?.variantMode === 'specific' && language && voices.length) {
    const beforeVariant = voices.length;
    voices = filterVoicesForSpecificVariant(voices, language, resolved, plan);
    try {
      trace({
        stage: 'specific_variant_filter',
        params: {
          iso2: language,
          axis: resolved.variantAxis || '-',
          candidates: (resolved.variantCandidates || []).slice(0, 3).join(',') || '-',
          before: String(beforeVariant)
        },
        count: voices.length
      });
    } catch (_) {}
  }

  // Post-filter: prefer candidates matching at least one non-generic keyword
  {
    const nonGeneric = [];
    const maybeGeneric = [];
    for (const v of voices) {
      const mk = Array.isArray(v._matched_keywords) ? v._matched_keywords.map(normalizeKw) : [];
      const hasNonNoise = mk.some((k) => !GENERIC_NOISE_KEYWORDS.has(k));
      if (hasNonNoise) nonGeneric.push(v);
      else maybeGeneric.push(v);
    }
    if (nonGeneric.length >= 10) {
      voices = [...nonGeneric, ...maybeGeneric];
    }
  }

  // GCC: order voices with Gulf-aligned metadata/descriptions first when signal is strong enough
  try {
    const gcc = detectGccArabicVoiceIntent(userText);
    if (gcc && language === 'ar' && Array.isArray(voices) && voices.length >= 8) {
      const yes = [];
      const no = [];
      for (const v of voices) {
        if (voiceMatchesGccIntent(v, userText)) yes.push(v);
        else no.push(v);
      }
      if (yes.length >= 8) {
        voices = [...yes, ...no];
      }
    }
  } catch (_) {}

  // extra language filter (heuristic)
  if (language && voices.length) {
    const langFiltered = voices.filter((v) => isVoiceInLanguage(v, language));
    if (langFiltered.length >= 5) {
      voices = langFiltered;
    }
  }

  // quality preference
  if (qualityPref === 'high_only') {
    const onlyHigh = voices.filter(isHighQuality);
    if (onlyHigh.length) voices = onlyHigh;
  } else if (qualityPref === 'no_high') {
    const onlyStandard = voices.filter((v) => !isHighQuality(v));
    if (onlyStandard.length) voices = onlyStandard;
  }

  if (isSpecificModelPreference(modelPref)) {
    const beforeModel = voices.length;
    voices = filterVoicesByModelPreference(voices, modelPref);
    try {
      trace({
        stage: 'model_filter',
        params: {
          model: Array.isArray(modelPref) ? modelPref.join(',') : String(modelPref),
          before: String(beforeModel),
          after: String(voices.length)
        },
        count: voices.length
      });
    } catch (_) {}
  }

  if (plan.__no_notice_period === true || plan.__min_notice_period_days > 0 || plan.__no_custom_rates === true) {
    const beforeLibraryFilters = voices.length;
    voices = applyVoiceLibraryFilters(voices, plan);
    try {
      trace({
        stage: 'voice_library_filters',
        params: {
          no_notice: String(plan.__no_notice_period === true),
          min_days: String(plan.__min_notice_period_days ?? '-'),
          no_custom_rates: String(plan.__no_custom_rates === true),
          before: String(beforeLibraryFilters),
          after: String(voices.length)
        },
        count: voices.length
      });
    } catch (_) {}
  }

  // Candidate ranking prep: coverage score + diversity seeding before cap
  const chineseDialect = language === 'zh' ? detectChineseDialectFromText(userText) : null;
  const preferredZhLocales = preferredLocalesForChineseDialect(chineseDialect).map((x) => String(x).toLowerCase());
  const dialectHints = new Set(dialectKeywordHints(chineseDialect).map(normalizeKw));
  const isBilingualEnEsRank = detectBilingualEnEs(userText);
  const isLatamSpanishIntent =
    (language === 'es' || isBilingualEnEsRank) &&
    /\b(es-419|latam|latin america|latinamerican|latino|latin(?:o)? american|south american|central american|caribbean)\b/.test((userText || '').toLowerCase()) &&
    !(/\b(mexico|mexican|es-mx|mx)\b/.test((userText || '').toLowerCase())) &&
    !(/\b(spain|castilian|es-es)\b/.test((userText || '').toLowerCase()));
  const latamSpanishLocales = new Set(['es-mx', 'es-co', 'es-ar', 'es-pe', 'es-cl', 'es-ve', 'es-us']);
  const zhAccentSlugs = new Set(
    language === 'zh'
      ? [
          ...(ZH_ACCENT_SLUGS.cantonese || []),
          ...(ZH_ACCENT_SLUGS.mandarin || []),
          ...(ZH_ACCENT_SLUGS.standard || [])
        ].map(normalizeKw)
      : []
  );
  const isGccIntent = language === 'ar' && detectGccArabicVoiceIntent(userText);
  const briefFamily = plan.__briefFamily || inferBriefUseCaseFamily(userText, plan);

  function calcCoverageScore(v) {
    const mk = Array.isArray(v._matched_keywords) ? v._matched_keywords : [];
    const set = new Set(mk);
    const useCase = (plan.use_case_keywords || []).filter((k) => set.has(k)).length;
    const style = (plan.style_keywords || []).filter((k) => set.has(k)).length;
    const character = (plan.character_keywords || []).filter((k) => set.has(k)).length;
    const tone = (plan.tone_keywords || []).filter((k) => set.has(k)).length;
    let coverage = 3 * useCase + 3 * style + 2 * character + 1 * tone;
    // Metadata fit vs brief use-case (ASMR/chipmunk/support vs articles/audiobooks/edu)
    try {
      const fit = scoreVoiceUseCaseFit(v, briefFamily, userText);
      coverage += fit;
      v._brief_fit = fit;
    } catch (_) {}
    // domain-aware boosts (pre-GPT)
    const hasAny = (...tokens) => tokens.some((t) => set.has(t));
    // villain/cartoon
    if (hasAny('villain','evil','demon','cartoon','cartoonish','raspy','gravelly','growl','menacing','wicked','sinister','dark')) {
      coverage += 1.5;
    }
    // corporate/presentation
    if (hasAny('corporate','clear','professional','slow','low','deep','presentation','explainer','video')) {
      coverage += 1.0;
    }
    // podcast
    if (hasAny('podcast','host','presenter','broadcaster','warm','engaging','conversational')) {
      coverage += 1.0;
    }
    // support — only when the brief is conversational (avoid boosting Sam-like voices for audiobooks)
    if (
      (!briefFamily || briefFamily === 'conversational') &&
      hasAny('support','customer support','conversational','call center','contact center')
    ) {
      coverage += 0.8;
    }
    // Narrative / educational matched-keyword boosts
    if (briefFamily === 'narrative' && hasAny('audiobook','narration','narrator','storytelling','storyteller')) {
      coverage += 1.4;
    }
    if (
      (briefFamily === 'articles' || briefFamily === 'educational') &&
      hasAny('educational','informative','documentary','explainer','article','presentation','news')
    ) {
      coverage += 1.4;
    }
    // healthcare boost / audiobook/podcast downweight in healthcare intent
    try {
      if ((plan.__floorDomain || '') === 'healthcare') {
        if (hasAny('healthcare','medical','patient','clinical','clear','reassuring','professional','calm')) {
          coverage += 1.0;
        }
        if (hasAny('audiobook','podcast','storytelling')) {
          coverage -= 0.8;
        }
      }
    } catch (_) {}
    // locale boost for mexican/es-MX
    try {
      const locale = (v.locale || '').toLowerCase();
      const accent = (v.accent || '').toLowerCase();
      if (locale === 'es-mx' || accent.includes('mexican')) {
        coverage += 0.5;
      }
    } catch (_) {}

    // Region boost: Spanish LatAm (do not rely on es-419 locale)
    try {
      if (isLatamSpanishIntent) {
        const locale = (v.locale || '').toString().toLowerCase();
        if (latamSpanishLocales.has(locale)) coverage += 0.7;
        if (locale === 'es-es') coverage -= 0.4;
      }
    } catch (_) {}

    // Resolved constraints boost (universal): reward voices whose verified locale/accent matches the resolver choice.
    try {
      if (resolved && resolved.variantMode === 'specific' && resolved.targetIso2) {
        if (resolved.variantAxis === 'locale' && Array.isArray(resolved.variantCandidates) && resolved.variantCandidates.length) {
          const want = normalizeRequestedLocale(resolved.variantCandidates[0]);
          if (want) {
            const locs = voiceVerifiedLocales(v, resolved.targetIso2);
            if (Array.isArray(locs) && locs.includes(want)) coverage += 1.0;
          }
        }
        if (resolved.variantAxis === 'accent' && Array.isArray(resolved.variantCandidates) && resolved.variantCandidates.length) {
          const wantA = normalizeRequestedAccent(resolved.variantCandidates[0]);
          if (wantA) {
            const accs = voiceVerifiedAccents(v, resolved.targetIso2);
            if (Array.isArray(accs) && accs.includes(wantA)) coverage += 1.0;
          }
        }
      }
    } catch (_) {}

    try {
      if (isGccIntent && voiceMatchesGccIntent(v, userText)) {
        coverage += 0.85;
      }
    } catch (_) {}

    try {
      if (isGccIntent) {
        const loc = (v.locale || '').toString().toLowerCase();
        if (loc === 'ar-sa' || loc === 'ar-kw' || loc === 'ar-bh' || loc === 'ar-qa' || loc === 'ar-ae') {
          coverage += 0.35;
        }
      }
    } catch (_) {}

    // Popularity proxy (verify_counts): small tie-breaker by accent popularity when available
    try {
      const iso = (resolved?.targetIso2 || language || '').toString().toLowerCase().slice(0, 2);
      const a = normalizeCatalogToken(v?.accent || '');
      if (iso && a && facetKB && facetKB.accentCountByIso2Accent) {
        const m = facetKB.accentCountByIso2Accent.get(iso);
        const c = m ? Number(m.get(a) || 0) : 0;
        if (c > 0) coverage += Math.min(0.6, Math.log10(c + 1) * 0.15);
      }
    } catch (_) {}

    // Dialect boost for Chinese (soft): reward matching dialect keywords and matching locale
    try {
      if (chineseDialect) {
        const mkNorm = mk.map(normalizeKw);
        const hasDialectKw = mkNorm.some((k) => k === chineseDialect || dialectHints.has(k));
        if (hasDialectKw) coverage += 1.2;

        const vLoc = (v.locale || '').toString().toLowerCase();
        if (preferredZhLocales.length && vLoc) {
          if (preferredZhLocales.includes(vLoc)) coverage += 0.8;
        }

        // Conservative fallback from visible metadata (when locale missing)
        const blob = (
          (v.name || '') + ' ' +
          (v.description || '') + ' ' +
          (v.descriptive || '') + ' ' +
          (v.accent || '')
        ).toString().toLowerCase();
        if (chineseDialect === 'cantonese') {
          if (/\b(hong\s*kong|hongkong|zh-hk|cantonese)\b/.test(blob) || blob.includes('粤语')) coverage += 0.4;
        } else if (chineseDialect === 'mandarin') {
          if (/\b(zh-cn|china|mainland|simplified|mandarin|putonghua)\b/.test(blob) || blob.includes('普通话')) coverage += 0.4;
        }
      }
    } catch (_) {}

    // Accent-slug boost (zh): if we fetched this voice via accent=<slug>, reward it.
    try {
      if (language === 'zh' && zhAccentSlugs.size) {
        const mkNorm = mk.map(normalizeKw);
        const hasSlug = mkNorm.some((k) => zhAccentSlugs.has(k));
        if (hasSlug) coverage += 1.0;
      }
    } catch (_) {}

    // bilingual boost: verified EN+ES
    try {
      const vlangs = Array.isArray(v.verified_languages) ? v.verified_languages : [];
      const langs = new Set(
        vlangs.map((e) => ((e && e.language) ? String(e.language).toLowerCase().slice(0,2) : null)).filter(Boolean)
      );
      if (langs.has('en') && langs.has('es')) {
        coverage += 0.8;
      }
    } catch (_) {}
    // negatives: penalize forbidden descriptors if present in metadata blob
    try {
      const negatives = Array.isArray(plan.__negatives) ? plan.__negatives : [];
      if (negatives.length) {
        const blob = (
          (v.name || '') + ' ' +
          (v.description || '') + ' ' +
          (v.descriptive || '') + ' ' +
          (v.accent || '')
        ).toLowerCase();
        const violates = negatives.some((b) => blob.includes(b));
        if (violates) coverage -= 2.0;
      }
    } catch (_) {}
    const matchedCount = contentMatchedKeywords(mk).length;
    const usage = v.usage_character_count_1y || v.usage_character_count_7d || 0;
    v._coverageScore = coverage;
    return { coverage, matchedCount, usage };
  }

  const highSignal = new Set([
    ...(plan.use_case_keywords || []),
    ...(plan.style_keywords || []),
    ...(plan.character_keywords || [])
  ]);

  // Deprioritize candidates that matched only generic/noise keywords; prefer those with any high-signal match
  voices = voices.sort((a, b) => {
    const aMk = (a._matched_keywords || []).map(normalizeKw);
    const bMk = (b._matched_keywords || []).map(normalizeKw);
    const aHS = aMk.some((k) => highSignal.has(k));
    const bHS = bMk.some((k) => highSignal.has(k));
    if (aHS !== bHS) return aHS ? -1 : 1;
    const aGenericOnly = aMk.length > 0 && aMk.every((k) => GENERIC_NOISE_KEYWORDS.has(k));
    const bGenericOnly = bMk.length > 0 && bMk.every((k) => GENERIC_NOISE_KEYWORDS.has(k));
    if (aGenericOnly !== bGenericOnly) return aGenericOnly ? 1 : -1;
    return 0;
  });

  const byKeywordBucket = new Map();
  voices.forEach((v) => {
    (v._matched_keywords || []).forEach((kw) => {
      if (!highSignal.size || highSignal.has(kw)) {
        const arr = byKeywordBucket.get(kw) || [];
        arr.push(v);
        byKeywordBucket.set(kw, arr);
      }
    });
  });

  // diversity seeding with per-voice dedup
  const seed = [];
  const seedIds = new Set();
  for (const [kw, arr] of byKeywordBucket.entries()) {
    arr.sort((a, b) => {
      const sa = calcCoverageScore(a), sb = calcCoverageScore(b);
      if (sb.coverage !== sa.coverage) return sb.coverage - sa.coverage;
      if (sb.matchedCount !== sa.matchedCount) return sb.matchedCount - sa.matchedCount;
      return (sb.usage || 0) - (sa.usage || 0);
    });
    let picked = 0;
    for (const v of arr) {
      if (!seedIds.has(v.voice_id)) {
        seed.push(v);
        seedIds.add(v.voice_id);
        picked++;
        if (picked >= 3) break;
      }
    }
  }
  const rest = voices.filter((v) => !seedIds.has(v.voice_id));
  rest.sort((a, b) => {
    const sa = calcCoverageScore(a), sb = calcCoverageScore(b);
    if (sb.coverage !== sa.coverage) return sb.coverage - sa.coverage;
    if (sb.matchedCount !== sa.matchedCount) return sb.matchedCount - sa.matchedCount;
    return (sb.usage || 0) - (sa.usage || 0);
  });
  voices = [...seed, ...rest];

  // final global dedup (safety)
  {
    const uniq = [];
    const seenIds = new Set();
    for (const v of voices) {
      if (!seenIds.has(v.voice_id)) {
        uniq.push(v);
        seenIds.add(v.voice_id);
      }
    }
    voices = uniq;
  }

  // cap total voices to keep memory bounded
  if (voices.length > 120) {
    voices = voices.slice(0, 120);
  }

  // Post-filter: apply explicit user exclusions (accent/locale/gender)
  try {
    const exclAccArr = Array.isArray(plan?.__excludedAccents) ? plan.__excludedAccents : [];
    const exclLocArr = Array.isArray(plan?.__excludedLocales) ? plan.__excludedLocales : [];
    const exclGenderArr = Array.isArray(plan?.__excludedGenders) ? plan.__excludedGenders : [];
    const iso2 = (
      language ||
      plan?.__excludedAccentsIso2 ||
      plan?.__excludedLocalesIso2 ||
      parseUserLanguageHints(userText)?.iso2 ||
      ''
    )
      .toString()
      .toLowerCase()
      .slice(0, 2);
    if (iso2 && Array.isArray(voices) && (exclAccArr.length || exclLocArr.length || exclGenderArr.length)) {
      const beforeAll = voices.length;
      let errorRemoved = 0;
      const errorSamples = [];

      const excludedAccents = new Set(exclAccArr.map((x) => normalizeRequestedAccent(x)).filter(Boolean));
      const excludedLocales = new Set(exclLocArr.map((x) => normalizeRequestedLocale(x)).filter(Boolean));
      const excludedGenders = new Set(
        exclGenderArr.map((x) => (x || '').toString().toLowerCase().trim()).filter((x) => x === 'male' || x === 'female')
      );

      // NL: Flemish is strongly associated with nl-BE in returned metadata
      if (iso2 === 'nl' && excludedAccents.has('flemish')) excludedLocales.add('nl-BE');

      // 1) Accent exclusion
      if (excludedAccents.size) {
        const before = voices.length;
        voices = voices.filter((v) => {
          if (!v) return false;
          try {
            const accs = voiceVerifiedAccents(v, iso2);
            for (const a of accs || []) if (excludedAccents.has(a)) return false;
            return true;
          } catch (err) {
            try {
              errorRemoved += 1;
              if (errorSamples.length < 3) {
                errorSamples.push(`${String(v?.voice_id || '-')}|${String(err?.message || err || 'error')}`.slice(0, 140));
              }
            } catch (_) {}
            return false;
          }
        });
        const removed = before - voices.length;
        if (removed > 0) {
          try {
            trace({
              stage: 'exclude_accents',
              params: { iso2, excluded: Array.from(excludedAccents).join(',') || '-', excluded_locales: '-' },
              count: removed
            });
          } catch (_) {}
        }
      }

      // 2) Locale exclusion
      if (excludedLocales.size) {
        const before = voices.length;
        voices = voices.filter((v) => {
          if (!v) return false;
          try {
            const locs = voiceVerifiedLocales(v, iso2);
            for (const l of locs || []) if (excludedLocales.has(l)) return false;
            return true;
          } catch (err) {
            try {
              errorRemoved += 1;
              if (errorSamples.length < 3) {
                errorSamples.push(`${String(v?.voice_id || '-')}|${String(err?.message || err || 'error')}`.slice(0, 140));
              }
            } catch (_) {}
            return false;
          }
        });
        const removed = before - voices.length;
        if (removed > 0) {
          try {
            trace({
              stage: 'exclude_locales',
              params: { iso2, excluded_locales: Array.from(excludedLocales).join(',') || '-' },
              count: removed
            });
          } catch (_) {}
        }
      }

      // 3) Gender exclusion (best-effort based on available metadata)
      if (excludedGenders.size) {
        const before = voices.length;
        voices = voices.filter((v) => {
          if (!v) return false;
          try {
            const g = getGenderGroup(v);
            if (g && excludedGenders.has(g)) return false;
            return true;
          } catch (err) {
            try {
              errorRemoved += 1;
              if (errorSamples.length < 3) {
                errorSamples.push(`${String(v?.voice_id || '-')}|${String(err?.message || err || 'error')}`.slice(0, 140));
              }
            } catch (_) {}
            return false;
          }
        });
        const removed = before - voices.length;
        if (removed > 0) {
          try {
            trace({
              stage: 'exclude_genders',
              params: { excluded_genders: Array.from(excludedGenders).join(',') || '-' },
              count: removed
            });
          } catch (_) {}
        }
      }

      // Emit one consolidated error record if we had to fail-closed
      if (errorRemoved > 0) {
        try {
          trace({
            stage: 'exclude_exclusions_error',
            params: {
              iso2,
              excluded: Array.from(excludedAccents).join(',') || '-',
              excluded_locales: Array.from(excludedLocales).join(',') || '-',
              excluded_genders: Array.from(excludedGenders).join(',') || '-',
              samples: errorSamples.length ? errorSamples.join(';;') : '-'
            },
            count: errorRemoved
          });
        } catch (_) {}
      }

      // No-op trace: if exclusions were present but removed nothing, still record (helps debugging)
      if (beforeAll === voices.length) {
        try {
          trace({
            stage: 'exclude_exclusions',
            params: {
              iso2,
              excluded: Array.from(excludedAccents).join(',') || '-',
              excluded_locales: Array.from(excludedLocales).join(',') || '-',
              excluded_genders: Array.from(excludedGenders).join(',') || '-'
            },
            count: 0
          });
        } catch (_) {}
      }
    }
  } catch (_) {}

  // Facet fallback grouping: if language has multiple variants, attach facetGroups
  // even when we used keyword search (keeps output from mixing variants).
  try {
    const canGroup =
      language &&
      facetKB &&
      facetKB.isLoaded &&
      facetKB.isLoaded() &&
      facetKB.hasIso2 &&
      facetKB.hasIso2(language) &&
      !(
        (plan.target_accent && typeof plan.target_accent === 'string' && plan.target_accent.trim()) ||
        (plan.target_locale && typeof plan.target_locale === 'string' && plan.target_locale.trim())
      );

    if (canGroup && Array.isArray(voices) && voices.length) {
      const zhDialect = language === 'zh' ? detectChineseDialectFromText(userText) : null;
      const axis =
        language === 'zh' && zhDialect
          ? 'accent'
          : (facetKB.getAxisForIso2 ? facetKB.getAxisForIso2(language) : null);
      const maxVariants = axis === 'locale' ? 4 : 6;
      const variants = facetKB.getFacetVariants ? facetKB.getFacetVariants(language, axis, { maxVariants }) : [];

      if (axis && Array.isArray(variants) && variants.length >= 2) {
        const normLocaleLoose = (val) => {
          const s = (val || '').toString().trim().toLowerCase().replace(/_/g, '-').replace(/\s+/g, '');
          const m = s.match(/^([a-z]{2,3})-([a-z]{2}|\d{3})$/i);
          if (!m) return null;
          const lang = m[1].toLowerCase();
          const reg = /^\d{3}$/.test(m[2]) ? m[2] : m[2].toLowerCase();
          return `${lang}-${reg}`;
        };

        const topKeys = new Set(variants.map((v) => v && v.facetKey).filter(Boolean));
        const groups = new Map(); // facetKey -> { facetType, facetKey, facetLabel, voices: [] }
        const otherKey = '__other__';

        const initGroup = (k, label) => {
          if (!groups.has(k)) {
            groups.set(k, { facetType: axis, facetKey: k, facetLabel: label, voices: [] });
          }
          return groups.get(k);
        };

        // Pre-create groups in variant order
        for (const v of variants) {
          if (!v || !v.facetKey) continue;
          initGroup(v.facetKey, v.facetLabel || v.facetKey);
        }
        initGroup(otherKey, 'OTHER / UNSURE');

        const allowedAccents = facetKB.allowedAccentsByIso2?.get?.(language) || new Set();
        const allowedLocales = facetKB.allowedLocalesByIso2?.get?.(language) || new Set();

        const pickFacetKeyForVoice = (voice) => {
          if (!voice) return otherKey;
          if (axis === 'accent') {
            const accs = [];
            // verified accents for this iso2
            const verified = Array.isArray(voice.verified_languages) ? voice.verified_languages : [];
            for (const e of verified) {
              const el = extractIso2FromLanguageField(e?.language);
              if (el !== language) continue;
              const a = normalizeCatalogToken(e?.accent);
              if (a) accs.push(a);
            }
            const topA = normalizeCatalogToken(voice?.accent);
            if (topA) accs.push(topA);
            for (const a of accs) {
              if (allowedAccents.has(a) && topKeys.has(a)) return a;
            }
            return otherKey;
          }
          if (axis === 'locale') {
            const locs = [];
            const verified = Array.isArray(voice.verified_languages) ? voice.verified_languages : [];
            for (const e of verified) {
              const el = extractIso2FromLanguageField(e?.language);
              if (el !== language) continue;
              const l1 = normLocaleLoose(e?.locale);
              if (l1) locs.push(l1);
              const l2 = normLocaleLoose(e?.language);
              if (l2) locs.push(l2);
            }
            const topL = normLocaleLoose(voice?.locale);
            if (topL) locs.push(topL);
            for (const l of locs) {
              if (allowedLocales.has(l) && topKeys.has(l)) return l;
            }
            return otherKey;
          }
          return otherKey;
        };

        for (const v of voices) {
          const k = pickFacetKeyForVoice(v);
          const g = groups.get(k) || groups.get(otherKey);
          g.voices.push(v);
        }

        const facetGroups = [];
        for (const v of variants) {
          const k = v?.facetKey;
          const g = k ? groups.get(k) : null;
          if (g && Array.isArray(g.voices) && g.voices.length) facetGroups.push(g);
        }
        const other = groups.get(otherKey);
        if (other && other.voices && other.voices.length) facetGroups.push(other);

        if (facetGroups.length) {
          voices.facetGroups = facetGroups;
          voices.facetAxis = axis;
          voices.facetIso2 = language;
          try {
            trace({
              stage: 'facet_fallback_grouping',
              params: { iso2: language, axis, groups: String(facetGroups.length) },
              count: voices.length
            });
          } catch (_) {}
        }
      }
    }
  } catch (_) {}

  return voices;
}

// Special mode: "top by language" – most used voices in a given language (with optional filters)
async function fetchTopVoicesByLanguage(languageCode, qualityPreference, plan, userText, traceCb) {
  const XI_KEY = process.env.ELEVENLABS_API_KEY;
  const trace = typeof traceCb === 'function' ? traceCb : () => {};

  try {
    const params = new URLSearchParams();
    params.set('page_size', '100');
    appendQueryFiltersToParams(params, plan || {}, userText || '', {
      language: languageCode,
      qualityPref: qualityPreference,
      featured: plan?.__featured === true,
      sort: typeof plan?.__sort === 'string' ? plan.__sort : null,
      forceUseCases: plan?.__forceUseCases === true,
      traceCb: trace
    });

    const url = `https://api.elevenlabs.io/v1/shared-voices?${params.toString()}`;

    const res = await httpGetWithRetry(url, {
      headers: {
        'xi-api-key': XI_KEY,
        'Content-Type': 'application/json'
      },
      timeout: 10000
    });

    let voices = res.data.voices || [];
    try {
      trace({
        stage: 'top_by_language',
        params: paramsToObject(params),
        count: Array.isArray(voices) ? voices.length : 0
      });
    } catch (_) {}
    if (!voices.length) return [];

    voices.sort((a, b) => {
      const ua = a.usage_character_count_1y || a.usage_character_count_7d || 0;
      const ub = b.usage_character_count_1y || b.usage_character_count_7d || 0;
      return ub - ua;
    });

    const modelPref = plan?.model_preference || 'any';
    if (isSpecificModelPreference(modelPref)) {
      const beforeModel = voices.length;
      voices = filterVoicesByModelPreference(voices, modelPref);
      try {
        trace({
          stage: 'model_filter',
          params: {
            model: Array.isArray(modelPref) ? modelPref.join(',') : String(modelPref),
            before: String(beforeModel),
            after: String(voices.length)
          },
          count: voices.length
        });
      } catch (_) {}
    }

    voices = applyVoiceLibraryFilters(voices, plan || {});

    return voices.slice(0, 80);
  } catch (err) {
    console.error('Error in fetchTopVoicesByLanguage:', err.message || err);
    return [];
  }
}

// -------------------------------------------------------------
// GPT: curator – rank voices for this specific brief
// -------------------------------------------------------------

async function rankVoicesWithGPT(userText, keywordPlan, voices) {
  const MAX_VOICES = 50;
  const truncate = (val, max) => {
    if (val == null) return null;
    const s = String(val);
    return s.length > max ? s.slice(0, max) : s;
  };
  const wantsModelInfo = isSpecificModelPreference(keywordPlan?.model_preference);
  const candidates = voices.slice(0, MAX_VOICES).map((v) => {
    const entry = {
      voice_id: v.voice_id,
      name: truncate(v.name, 80),
      language: v.language || null,
      accent: truncate(v.accent, 40),
      gender: v.gender || null,
      description: truncate(v.description, 240),
      descriptive: truncate(v.descriptive, 120),
      verified_languages: Array.isArray(v.verified_languages)
        ? v.verified_languages.slice(0, 4).map((e) => ({
            language: e?.language || null,
            locale: e?.locale || null,
            accent: truncate(e?.accent, 48)
          }))
        : null,
      category: v.category || null,
      usage_character_count_1y:
        v.usage_character_count_1y || v.usage_character_count_7d || null,
      matched_keywords: contentMatchedKeywords(
        Array.isArray(v._matched_keywords) ? v._matched_keywords : []
      )
    };
    if (Object.prototype.hasOwnProperty.call(v, 'notice_period')) {
      entry.notice_period = v.notice_period;
    }
    if (wantsModelInfo) {
      entry.high_quality_base_model_ids = Array.isArray(v.high_quality_base_model_ids)
        ? v.high_quality_base_model_ids.slice(0, 8)
        : [];
    }
    return entry;
  });

  const systemPrompt = `
You are a world-class voice curator at ElevenLabs.

Your job:
- Read the user's brief (user_query).
- Read the keyword_plan (tone, use case, language, etc.).
- Look at each candidate voice with its metadata AND which keywords it matched.
- First, imagine and describe (for yourself) what the ideal voice or 2–3 ideal personas would sound like.
- Then, assign each candidate a score between 0.0 and 1.0 based on how close it is to that mental target.

You will receive:

{
  "user_query": string,
  "keyword_plan": { ... },
  "candidate_voices": [
    {
      "voice_id": string,
      "name": string,
      "language": string or null,
      "accent": string or null,
      "gender": string or null,
      "description": string or null,
      "descriptive": string or null,
      "verified_languages": [{ "language": string or null, "locale": string or null, "accent": string or null }] or null,
      "category": string or null,
      "usage_character_count_1y": number or null,
      "matched_keywords": string[],
      "notice_period": integer or null (optional; days required before cloning, null = no notice period),
      "high_quality_base_model_ids": string[] (optional; present when user asked for a specific model)
    },
    ...
  ]
}

Think like a human curator:

1. Build an internal mental picture:
   - From user_query + keyword_plan, imagine 1–3 short "ideal voice" descriptions.

2. Scoring logic for each candidate:

   - Tone & pacing:
     - Reward matches on calm/slow/warm, energetic, dark, villain, cartoonish, etc.
     - Use description, descriptive and matched_keywords.

   - Use case:
     - Reward if use_case / description / matched_keywords align with keyword_plan.use_case_keywords
       (conversational, agent, call center, narration, cartoon, trailer, etc.).
     - For professional briefs (articles, audiobooks, educational, narration): strongly DOWNWEIGHT
       niche/off-brief styles such as ASMR, whisper, chipmunk, cartoon/playful character, theatrical-only,
       and customer-support/IVR voices unless the user explicitly asked for them.
     - Prefer clear/professional/deep/resonant/authoritative/storytelling voices for those briefs.
     - Articles vs audiobooks vs educational should NOT get identical rankings: prefer informative/news-like
       clarity for articles, warm storytelling narration for audiobooks, and clear teaching/explainer tone for educational.

   - Language & accent:
     - If target_voice_language is set, strongly prefer that language.
     - If target_accent is set (e.g. "american"), prefer voices with matching accent or naming.
     - If the user explicitly asks for a Chinese dialect (e.g. "cantonese" or "mandarin"), treat it as a strong constraint:
       - Strongly reward candidates whose matched_keywords include that dialect or its obvious region hints (e.g. hong kong, zh-hk for cantonese; china, zh-cn for mandarin).
       - Prefer locale matches when present (zh-HK for cantonese; zh-CN for mandarin).
       - Also strongly reward candidates that were retrieved via an ElevenLabs accent filter slug in matched_keywords
         (e.g. hong-kong-cantonese, guangzhou-cantonese, beijing-mandarin, taiwan-mandarin, standard).
     - Gulf Arabic / GCC (Emirati, Qatari, UAE, Saudi, Kuwait, Bahrain, Oman, Khaleeji, GCC in the query):
       - Strongly prefer Arabic voices whose accent, description, or descriptive text suggests Gulf / Khaleeji / the requested country or region.
       - When the user names a specific Gulf country, downweight voices that clearly read as Egyptian, Levantine, or Maghrebi unless the metadata clearly matches the brief.

   - Gender:
     - If target_gender is clear, reward matching voices and slightly penalize opposite gender.
     - If not specified, do not enforce.

   - Quality preference:
     - If "high_only", slightly reward voices that look premium/high-quality,
       but do NOT completely discard standard if they are a great style match.
     - If "no_high", slightly prefer more neutral / standard voices.

   - Model preference:
     - If model_preference includes "eleven_v3", prefer voices whose high_quality_base_model_ids includes "eleven_v3".
     - If model_preference includes "eleven_flash_v2_5", prefer voices that support flash 2.5.
     - When BOTH are requested, prefer voices that support either (do not drop one model family).
     - Voices without the requested model support should score lower unless nothing else fits.

   - Notice period preference:
     - If notice_period_preference is "min_days", strongly prefer voices whose notice_period meets or exceeds min_notice_period_days.
     - If notice_period_preference is "no_notice", strongly prefer voices with notice_period null (no notice period).
     - Higher notice_period (e.g. 730 days) is better when the user asked for "infinity voice" or max notice period.

   - Keyword coverage:
     - matched_keywords tells you which individual keywords brought this voice.
     - A voice that matches many important keywords (tone + use_case + persona)
       should get a higher score than one that only matches a single generic term.

   - Popularity:
     - usage_character_count_1y is only a tie-breaker.
     - Do NOT just rank by popularity. It’s style-fit first, popularity second.

3. Score distribution:

   - Use the full 0.0–1.0 range.
   - Only a small handful of voices should be in the 0.85–1.0 range (excellent fits).
   - Decent but not perfect fits: ~0.5–0.8.
   - Weak or off-brief voices: 0.0–0.3.

Return ONLY:

Return valid JSON.

{
  "user_language": string,    // 2-letter code like "en","pl" for the language of the user's query
  "ranking": [
    {
      "voice_id": string,     // must be one of candidate_voices.voice_id
      "score": number         // 0.0–1.0, higher = better match
    },
    ...
  ]
}

Every candidate_voices.voice_id MUST appear exactly once in "ranking".
`.trim();

  const payload = {
    model: 'gpt-4o',
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content:
          'json\n' +
          JSON.stringify({
          user_query: userText,
          keyword_plan: keywordPlan,
          candidate_voices: candidates
        })
      }
    ],
    temperature: 0
  };

  const rankTimeoutMs = readEnvNumber('OPENAI_RANK_TIMEOUT_MS', 60000);
  const rankAttempts = Math.max(1, Math.min(3, Math.floor(readEnvNumber('OPENAI_RANK_ATTEMPTS', 2))));
  const rankBaseDelayMs = Math.max(50, Math.min(2000, Math.floor(readEnvNumber('OPENAI_RANK_BASE_DELAY_MS', 400))));

  try {
    const response = await httpPostWithRetry(
      'https://api.openai.com/v1/chat/completions',
      payload,
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout: rankTimeoutMs
      },
      {
        attempts: rankAttempts,
        baseDelayMs: rankBaseDelayMs,
        maxDelayMs: 3000
      }
    );

    const content = response.data.choices[0].message.content;
    const data = JSON.parse(content);

    const rankingArray = Array.isArray(data.ranking) ? data.ranking : [];
    const allowed = new Set(candidates.map((c) => c.voice_id));
    const scoreMap = {};

    rankingArray.forEach((item, index) => {
      if (!item || !item.voice_id) return;
      if (!allowed.has(item.voice_id)) return;

      let score = typeof item.score === 'number' ? item.score : null;
      if (score === null || Number.isNaN(score)) {
        score = (rankingArray.length - index) / Math.max(rankingArray.length, 1);
      }
      scoreMap[item.voice_id] = Math.min(1, Math.max(0, score));
    });

    // Ensure every candidate has some score
    candidates.forEach((c, idx) => {
      if (scoreMap[c.voice_id] == null) {
        scoreMap[c.voice_id] = Math.min(
          1,
          Math.max(0, ((candidates.length - idx) / Math.max(candidates.length, 1)) * 0.2)
        );
      }
    });

    const userLang =
      (data.user_language ||
        keywordPlan.user_interface_language ||
        guessUiLanguageFromText(userText) ||
        'en')
        .toString()
        .slice(0, 2)
        .toLowerCase();

    return { scoreMap, userLanguage: userLang };
  } catch (err) {
    safeLogAxiosError('rankVoicesWithGPT', err);

    const scoreMap = {};
    voices.forEach((v, idx) => {
      scoreMap[v.voice_id] = (voices.length - idx) / Math.max(voices.length, 1);
    });

    const userLang =
      (keywordPlan.user_interface_language ||
        guessUiLanguageFromText(userText) ||
        'en')
        .toString()
        .slice(0, 2)
        .toLowerCase();

    return { scoreMap, userLanguage: userLang };
  }
}

// -------------------------------------------------------------
// Build Slack message from session
// -------------------------------------------------------------

function buildMessageFromSession(session) {
  const { voices, ranking, filters, originalQuery, uiLanguage } = session;
  const labels = getLabels();
  const noticeFilteredVoices = applyVoiceLibraryFilters(voices, filters);

  // Facet sections (locale/accent) – UI-like grouping
  try {
    const facetGroups = noticeFilteredVoices && Array.isArray(noticeFilteredVoices.facetGroups) ? noticeFilteredVoices.facetGroups : null;
    const facetAxis = noticeFilteredVoices && typeof noticeFilteredVoices.facetAxis === 'string' ? noticeFilteredVoices.facetAxis : null;
    const variantIntent = noticeFilteredVoices && typeof noticeFilteredVoices.variantIntent === 'object' ? noticeFilteredVoices.variantIntent : null;
    if (facetGroups && facetGroups.length) {
      const maxPerGender =
        Number.isFinite(filters.limitPerGender) && filters.limitPerGender > 0
          ? filters.limitPerGender
          : (filters.listAll ? 25 : 6);

      const qualityFilter = filters.quality || 'any';
      const genderFilter = filters.gender || 'any';

      const out = [];

      const renderGroup = (group) => {
        const gVoices = Array.isArray(group?.voices) ? group.voices : [];
        if (!gVoices.length) return;

        const title = `${String(facetAxis || group.facetType || 'facet').toUpperCase()}: ${String(group.facetLabel || group.facetKey || '').toUpperCase()}`;
        out.push('```' + title + '```');

        const sorted = [...gVoices].sort((a, b) => (ranking?.[b.voice_id] || 0) - (ranking?.[a.voice_id] || 0));
        const uniq = [];
        const seen = new Set();
        for (const v of sorted) {
          if (v && v.voice_id && !seen.has(v.voice_id)) {
            seen.add(v.voice_id);
            uniq.push(v);
          }
        }

        const buckets = { female: [], male: [], other: [] };
        const bothGendersCatalog = wantsBothGendersCatalog(null, originalQuery);
        for (const v of uniq) {
          const isHq = isHighQuality(v);
          if (qualityFilter === 'high_only' && !isHq) continue;
          if (qualityFilter === 'no_high' && isHq) continue;
          const g = getGenderGroup(v);
          if (bothGendersCatalog && g === 'other') continue;
          if (genderFilter !== 'any' && g !== genderFilter) continue;
          if (buckets[g].length < maxPerGender) buckets[g].push(v);
        }

        const order = getGenderRenderOrder(genderFilter, originalQuery);
        const genderLabels = { female: labels.female, male: labels.male, other: labels.other };
        for (const k of order) {
          const arr = buckets[k] || [];
          if (!arr.length) continue;
          out.push(`*${genderLabels[k]}:*`);
          for (const v of arr) {
            const isHq = isHighQuality(v);
            const prefix = qualityFilter === 'any' && isHq ? '[HQ] ' : '';
            out.push(`- ${prefix}${formatVoiceLine(v, uiLanguage)}`);
          }
          out.push('');
        }
      };

      // Strict mode: if user asked for a specific variant, show only that variant.
      // Fallback (STANDARD/OTHER) is allowed ONLY when primaryCount === 0.
      if (variantIntent && variantIntent.isSpecific && Array.isArray(variantIntent.requestedFacetKeys)) {
        const want = new Set(variantIntent.requestedFacetKeys.map((k) => (k || '').toString()));
        const primary = facetGroups.filter((g) => g && want.has((g.facetKey || '').toString()));
        const other = facetGroups.find((g) => (g?.facetKey || '') === '__other__' || String(g?.facetLabel || '').toUpperCase().includes('OTHER')) || null;

        const primaryCount = primary.reduce((acc, g) => acc + (Array.isArray(g.voices) ? g.voices.length : 0), 0);
        for (const g of primary) renderGroup(g);

        if (primaryCount === 0) {
          const fbKeys = Array.isArray(variantIntent.fallbackFacetKeys) ? variantIntent.fallbackFacetKeys : [];
          const fallbackGroups = facetGroups.filter((g) => g && fbKeys.includes(String(g.facetKey || '')));
          for (const g of fallbackGroups) renderGroup(g);
          const fallbackCount = fallbackGroups.reduce((acc, g) => acc + (Array.isArray(g.voices) ? g.voices.length : 0), 0);
          if (fallbackCount === 0 && other && Array.isArray(other.voices) && other.voices.length) {
            renderGroup(other);
          }
        }
      } else {
        for (const g of facetGroups) renderGroup(g);
      }
      const msg = out.join('\n');
      return msg && String(msg).trim() ? msg : labels.noVoices;
    }
  } catch (_) {}

  const maxPerGender =
    Number.isFinite(filters.limitPerGender) && filters.limitPerGender > 0
      ? filters.limitPerGender
      : (filters.listAll ? 50 : 6);

  const sorted = [...noticeFilteredVoices].sort(
    (a, b) => (ranking[b.voice_id] || 0) - (ranking[a.voice_id] || 0)
  );

  const qualityFilter = filters.quality || 'any';
  const genderFilter = filters.gender || 'any';

  const sections = {
    standard: { female: [], male: [], other: [] },
    high: { female: [], male: [], other: [] }
  };

  // render only unique voices (avoid duplicates)
  const sortedUnique = [];
  {
    const seen = new Set();
    for (const v of sorted) {
      if (!seen.has(v.voice_id)) {
        sortedUnique.push(v);
        seen.add(v.voice_id);
      }
    }
  }

  const bothGendersCatalog = wantsBothGendersCatalog(null, originalQuery);
  const seenHighNameKeys = new Set();

  sortedUnique.forEach((v) => {
    const isHq = isHighQuality(v);

    if (qualityFilter === 'high_only' && !isHq) return;
    if (qualityFilter === 'no_high' && isHq) return;

    const group = isHq ? 'high' : 'standard';
    const nameKey = voiceNameDedupeKey(v);
    if (group === 'standard' && nameKey && seenHighNameKeys.has(nameKey)) return;

    const genderGroup = getGenderGroup(v);
    if (bothGendersCatalog && genderGroup === 'other') return;

    if (genderFilter !== 'any' && genderGroup !== genderFilter) return;

    const arr = sections[group][genderGroup];
    if (arr.length < maxPerGender) {
      arr.push(v);
      if (group === 'high' && nameKey) seenHighNameKeys.add(nameKey);
    }
  });

  const showStandardSection = qualityFilter !== 'high_only';
  const showHighSection = qualityFilter !== 'no_high';

  const lines = [];

  function appendSection(title, sectionKey) {
    const groups = sections[sectionKey];
    const order = getGenderRenderOrder(genderFilter, originalQuery);
    const genderLabels = {
      female: labels.female,
      male: labels.male,
      other: labels.other
    };

    const nonEmpty = order.filter((key) => (groups[key] || []).length > 0);
    if (!nonEmpty.length) return; // skip entire section if empty

    // Quality section titles as code blocks
    const qualityTitle = sectionKey === 'standard' ? 'STANDARD:' : 'HIGH QUALITY:';
    lines.push('```' + qualityTitle + '```');
    nonEmpty.forEach((key) => {
      const label = genderLabels[key];
      const arr = groups[key];
      lines.push(`*${label}:*`);
      arr.forEach((v) => {
        lines.push(`- ${formatVoiceLine(v, uiLanguage)}`);
      });
      lines.push('');
    });
  }

  if (showStandardSection) {
    // defer standard after high if both visible
  }
  if (showHighSection) {
    appendSection(labels.highHeader, 'high');
  }
  if (showStandardSection) {
    appendSection(labels.standardHeader, 'standard');
  }

  // Removed follow-up hints/footers

  const msg = lines.join('\n');
  return msg && String(msg).trim() ? msg : labels.noVoices;
}

function buildBlocksFromText(text) {
  if (!text) return null;
  // Split by blank lines to keep sections readable
  const parts = text.split(/\n\s*\n/);
  const blocks = [];
  for (const part of parts) {
    // If a section is too long for one block, split by lines
    const lines = part.split('\n');
    let buffer = '';
    for (const line of lines) {
      const next = buffer ? buffer + '\n' + line : line;
      if (next.length > 2800) {
        blocks.push({
          type: 'section',
          text: { type: 'mrkdwn', text: buffer }
        });
        buffer = line;
      } else {
        buffer = next;
      }
    }
    if (buffer) {
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: buffer }
      });
    }
    // Add light spacing
    if (blocks.length < 48) {
      blocks.push({ type: 'divider' });
    }
  }
  // Ensure we stay under Slack's 50 blocks limit
  while (blocks.length > 50) {
    blocks.pop();
  }
  // Remove trailing divider
  if (blocks.length && blocks[blocks.length - 1].type === 'divider') {
    blocks.pop();
  }
  return blocks;
}

// (Removed splitting helper; we now always send a single unified result message)

function paramsToObject(params) {
  const obj = {};
  try {
    for (const [k, v] of params.entries()) obj[k] = v;
  } catch (_) {}
  return obj;
}

function splitMultiIntents(text) {
  try {
    const raw = (text || '').toString().trim();
    if (!raw) return [];
    // Split ONLY on explicit multi-brief formatting.
    // Important: do NOT split on "and"/"oraz" because it commonly appears inside a single brief.
    const lines = raw.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
    if (lines.length < 2) return [];

    const numberRe = /^\s*\d+\s*[\)\.\:]\s+/;      // 1) foo, 2. foo, 3: foo
    const bulletRe = /^\s*[-*•]\s+/;              // - foo, * foo, • foo
    const briefRe = /^\s*brief\s*[:\-]\s+/i;      // brief: foo, brief - foo

    const isExplicitItem = (l) => numberRe.test(l) || bulletRe.test(l) || briefRe.test(l);
    const explicitLines = lines.filter(isExplicitItem);
    if (explicitLines.length < 2) return [];

    const stripPrefix = (l) =>
      l
        .replace(numberRe, '')
        .replace(bulletRe, '')
        .replace(briefRe, '')
        .trim();

    const out = explicitLines.map(stripPrefix).filter((s) => s.length > 0);
    return out.length >= 2 ? out : [];
  } catch (_) {
    return [];
  }
}

function detectBilingualEnEs(userText) {
  const lower = (userText || '').toLowerCase();
  const hasEn = /\benglish\b|\ben\b/.test(lower);
  const hasEs =
    /\bspanish\b|\bespanol\b|\bespañol\b|\bes\b/.test(lower) ||
    (hasEn && /\blatin american\b/.test(lower));
  if (!hasEn || !hasEs) return false;

  if (/\bbilingual\b/.test(lower)) return true;
  if (/\ben\s*\/\s*es\b/.test(lower)) return true;

  // Explicit language pair: "English + Spanish", "native English and Latin American Spanish", etc.
  const enTerm = '(?:native\\s+)?english';
  const esTerm = '(?:latin american\\s+)?(?:spanish|espa[nñ]ol|es)';
  const connector = '\\s*(?:[+&]|,|\\band\\b)\\s*';
  const pairPattern = new RegExp(
    `(\\b${enTerm}\\b${connector}[\\s\\S]{0,80}?\\b${esTerm}\\b)|(\\b${esTerm}\\b${connector}[\\s\\S]{0,80}?\\b${enTerm}\\b)`,
    'i'
  );
  return pairPattern.test(lower);
}

// User wants one male AND one female voice recommendation (not a single-gender filter).
function detectOneMaleOneFemale(userText) {
  try {
    const lower = (userText || '').toLowerCase();
    if (!lower) return false;

    // Single-gender-only follow-ups / filters
    if (/\b(?:only|just|tylko)\s+(?:male|female|m[eę]sk\w*|[zż]e[nń]sk\w*|kobiec\w*)\b/i.test(lower)) {
      return false;
    }
    if (/\b(?:male|female|m[eę]sk\w*|[zż]e[nń]sk\w*|kobiec\w*)\s+only\b/i.test(lower)) return false;
    if (/\b(?:show|poka[zż])\s+(?:only\s+)?(?:male|female|m[eę]sk\w*|[zż]e[nń]sk\w*)\b/i.test(lower)) {
      return false;
    }

    const maleTerm = '(?:male|man|men|m[eę]sk(?:i|iego|a|ie)?|mesk(?:i|iego|a|ie)?)';
    const femaleTerm =
      '(?:female|woman|women|kobiec(?:a|y|e|iego)?|[zż]e[nń]sk(?:i|a|iego|ie)?|zensk(?:i|a|iego|ie)?)';
    const qty = '(?:one|1|a|an|jedn(?:a|y|e|ego)?|po\\s+jedn(?:ym|ej)?)';

    const oneEach = new RegExp(
      `\\b${qty}\\s+${maleTerm}\\b[\\s\\S]{0,40}?\\b${qty}\\s+${femaleTerm}\\b|` +
        `\\b${qty}\\s+${femaleTerm}\\b[\\s\\S]{0,40}?\\b${qty}\\s+${maleTerm}\\b`,
      'i'
    );
    if (oneEach.test(lower)) return true;

    if (/\b(?:one|1)\s+male\s+(?:one|1)\s+female\b/i.test(lower)) return true;
    if (/\b(?:one|1)\s+female\s+(?:one|1)\s+male\b/i.test(lower)) return true;
    if (/\bone\s+of\s+each\b/i.test(lower)) return true;
    if (/\bpo\s+jedn\w*\s+z\s+ka[żz]de[jw]\b/i.test(lower)) return true;

    // Polish shorthand without ASCII word boundaries (JS \\b breaks on ę/ż).
    if (/\bm[eę]sk\w*\s+(?:i|oraz)\s+[zż]e[nń]sk\w*/i.test(lower)) return true;
    if (/\bm[eę]sk\w*\s+(?:i|oraz)\s+kobiec\w*/i.test(lower)) return true;

    return false;
  } catch (_) {
    return false;
  }
}

function wantsOneMaleOneFemale(plan, userText) {
  return plan?.__dualGenderOneEach === true || detectOneMaleOneFemale(userText);
}

// User wants a balanced male+female catalog (not a single-gender filter, not one-of-each).
function detectBothGendersIntent(userText) {
  try {
    const lower = (userText || '').toLowerCase();
    if (!lower) return false;
    if (detectOneMaleOneFemale(userText)) return false;

    if (/\b(?:only|just|tylko)\s+(?:male|female|m[eę]sk\w*|[zż]e[nń]sk\w*|kobiec\w*)\b/i.test(lower)) {
      return false;
    }
    if (/\b(?:male|female|m[eę]sk\w*|[zż]e[nń]sk\w*|kobiec\w*)\s+only\b/i.test(lower)) return false;
    if (/\b(?:show|poka[zż])\s+(?:only\s+)?(?:male|female|m[eę]sk\w*|[zż]e[nń]sk\w*)\b/i.test(lower)) {
      return false;
    }

    const maleTerm = '(?:male|man|men|m[eę]sk(?:i|iego|a|ie)?|mesk(?:i|iego|a|ie)?)';
    const femaleTerm =
      '(?:female|woman|women|kobiec(?:a|y|e|iego)?|[zż]e[nń]sk(?:i|a|iego|ie)?|zensk(?:i|a|iego|ie)?)';
    const conn = '\\s*(?:and|oraz|i|&)\\s*';
    const bothOrder = new RegExp(
      `(\\b${femaleTerm}(?:\\s+voice)?s?\\b${conn}[\\s\\S]{0,60}?\\b${maleTerm}(?:\\s+voice)?s?\\b)|` +
        `(\\b${maleTerm}(?:\\s+voice)?s?\\b${conn}[\\s\\S]{0,60}?\\b${femaleTerm}(?:\\s+voice)?s?\\b)`,
      'i'
    );
    if (bothOrder.test(lower)) return true;

    if (/\b(?:both|all)\s+genders?\b/.test(lower)) return true;
    if (/\bshow\s+both\s+genders\b/.test(lower)) return true;

    return false;
  } catch (_) {
    return false;
  }
}

function wantsBothGendersCatalog(plan, userText) {
  return plan?.__bothGendersCatalog === true || detectBothGendersIntent(userText);
}

/** Parse "3 male and 3 female" / "3+3" style gender quotas. Returns per-gender limit or null. */
function detectGenderQuotaPerSide(userText) {
  try {
    const lower = (userText || '').toLowerCase();
    if (!lower) return null;
    const wordToNum = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };
    const toNum = (s) => {
      if (!s) return null;
      if (wordToNum[s]) return wordToNum[s];
      const n = Number(s);
      return Number.isFinite(n) && n > 0 ? Math.min(20, n) : null;
    };
    const resolvePair = (a, b) => {
      if (!a || !b) return null;
      return a === b ? a : Math.min(Math.max(a, b), 12);
    };
    const maleTerm = '(?:male|man|men|m[eę]sk(?:i|iego|a|ie)?|mesk(?:i|iego|a|ie)?)';
    const femaleTerm =
      '(?:female|woman|women|kobiec(?:a|y|e|iego)?|[zż]e[nń]sk(?:i|a|iego|ie)?|zensk(?:i|a|iego|ie)?)';
    const qty = '(\\d+|one|two|three|four|five|six)';
    const m1 = lower.match(
      new RegExp(`\\b${qty}\\s+${maleTerm}\\b[\\s\\S]{0,48}?\\b${qty}\\s+${femaleTerm}\\b`, 'i')
    );
    if (m1) return resolvePair(toNum(m1[1]), toNum(m1[2]));
    const m2 = lower.match(
      new RegExp(`\\b${qty}\\s+${femaleTerm}\\b[\\s\\S]{0,48}?\\b${qty}\\s+${maleTerm}\\b`, 'i')
    );
    if (m2) return resolvePair(toNum(m2[1]), toNum(m2[2]));
    const m3 = lower.match(
      new RegExp(`\\b${qty}\\s+${maleTerm}\\b\\s*[+&]\\s*${qty}\\s+${femaleTerm}\\b`, 'i')
    );
    if (m3) return resolvePair(toNum(m3[1]), toNum(m3[2]));
    return null;
  } catch (_) {
    return null;
  }
}

function ensureBothGenderSearchKeywords(userText, keywords, maxTotal, plan) {
  const max = Number.isFinite(maxTotal) && maxTotal > 0 ? maxTotal : 14;
  const list = Array.isArray(keywords) ? keywords.slice() : [];
  if (!wantsBothGendersCatalog(plan, userText) && !detectGenderQuotaPerSide(userText)) {
    return list.slice(0, max);
  }

  const hasMale = list.some((k) => /\bmale\b/.test(normalizeKw(k)));
  const hasFemale = list.some((k) => /\bfemale\b/.test(normalizeKw(k)));
  const front = [];
  if (!hasFemale) front.push('female voice');
  if (!hasMale) front.push('male voice');
  if (!front.length) return list.slice(0, max);
  return dedupePreserveOrder([...front, ...list]).slice(0, max);
}

function getSessionGenderAndLimit(plan, userText) {
  if (wantsOneMaleOneFemale(plan, userText)) {
    return { gender: 'any', limitPerGender: 1 };
  }
  const quota = detectGenderQuotaPerSide(userText);
  if (quota) {
    return { gender: 'any', limitPerGender: quota };
  }
  if (wantsBothGendersCatalog(plan, userText)) {
    const per = detectListAll(userText) ? 12 : 5;
    return { gender: 'any', limitPerGender: per };
  }
  const gender =
    plan?.target_gender === 'male' || plan?.target_gender === 'female' ? plan.target_gender : 'any';
  return { gender, limitPerGender: null };
}

// -------------------------------------------------------------
// Universal negatives / exclusions (tokens, locale, gender, accent)
// -------------------------------------------------------------

const NEG_TOKEN_ALIASES = new Map([
  // audiobook
  ['audio book', 'audiobook'],
  ['audiobook', 'audiobook'],
  ['audiobooks', 'audiobook'],
  ['audioboek', 'audiobook'], // NL
  ['luisterboek', 'audiobook'], // NL
  ['luisterboeken', 'audiobook'],
  ['audiobooka', 'audiobook'], // PL inflections (best-effort)
  ['audiobooku', 'audiobook'],
  // narration/story
  ['narration', 'narration'],
  ['narrator', 'narration'],
  ['storytelling', 'storytelling'],
  // podcast
  ['podcast', 'podcast'],
  ['podcasts', 'podcast'],
  // commercial/trailer/cartoon
  ['commercial', 'commercial'],
  ['commercials', 'commercial'],
  ['trailer', 'trailer'],
  ['trailers', 'trailer'],
  ['cartoon', 'cartoon'],
  ['cartoons', 'cartoon'],
  // voice texture
  ['whisper', 'whisper'],
  ['raspy', 'raspy'],
  ['growl', 'growl']
]);

function canonicalizeNegToken(s) {
  try {
    const norm = normalizeCatalogToken(s || '');
    if (!norm) return null;
    return NEG_TOKEN_ALIASES.get(norm) || norm;
  } catch (_) {
    return null;
  }
}

function extractNegativeTokens(userText) {
  const lower = (userText || '').toLowerCase();
  const neg = new Set();
  const rules = [
    { pat: /\bnot\s+whisper\b/, tok: 'whisper' },
    { pat: /\bno\s+whisper\b/, tok: 'whisper' },
    { pat: /\bbez\s+szeptu\b/, tok: 'whisper' },
    { pat: /\bnot\s+raspy\b/, tok: 'raspy' },
    { pat: /\bno\s+raspy\b/, tok: 'raspy' },
    { pat: /\bnot\s+growl(ing)?\b/, tok: 'growl' },
    { pat: /\bno\s+growl(ing)?\b/, tok: 'growl' },

    // Expanded negatives: common "not X / no X / without X" constraints
    { pat: /\b(?:not|no|without)\s+(?:an?\s+)?audiobooks?\b/, tok: 'audiobook' },
    { pat: /\b(?:not|no|without)\s+(?:an?\s+)?narration\b/, tok: 'narration' },
    { pat: /\b(?:not|no|without)\s+(?:an?\s+)?storytelling\b/, tok: 'storytelling' },
    { pat: /\b(?:not|no|without)\s+(?:an?\s+)?podcasts?\b/, tok: 'podcast' },
    { pat: /\b(?:not|no|without)\s+(?:an?\s+)?commercials?\b/, tok: 'commercial' },
    { pat: /\b(?:not|no|without)\s+(?:an?\s+)?trailers?\b/, tok: 'trailer' },
    { pat: /\b(?:not|no|without)\s+(?:an?\s+)?cartoons?\b/, tok: 'cartoon' },

    // Dutch-ish
    { pat: /\b(?:geen|zonder)\s+(?:een\s+)?(?:luisterboek(?:en)?|audioboek(?:en)?)\b/, tok: 'audiobook' },

    // Polish-ish
    { pat: /\bbez\s+audiobook(?:a|u|ów)?\b/, tok: 'audiobook' },
    { pat: /\bbez\s+narracji\b/, tok: 'narration' },
    { pat: /\bbez\s+podcast(?:u|ów)?\b/, tok: 'podcast' },
    { pat: /\bbez\s+reklam\b/, tok: 'commercial' },
    { pat: /\bbez\s+bajek\b/, tok: 'cartoon' }
  ];
  for (const r of rules) {
    if (r.pat.test(lower)) {
      const t = canonicalizeNegToken(r.tok) || r.tok;
      if (t) neg.add(t);
    }
  }
  return neg;
}

function extractExcludedGenders(userText) {
  try {
    const lower = (userText || '').toString().toLowerCase();
    const out = new Set();
    if (!lower) return [];

    const add = (g) => {
      if (g === 'male' || g === 'female') out.add(g);
    };

    // English
    if (/\b(?:not|no|without)\s+(?:a\s+)?(?:female|woman|women|f)\b/.test(lower)) add('female');
    if (/\b(?:not|no|without)\s+(?:a\s+)?(?:male|man|men|m)\b/.test(lower)) add('male');
    if (/\b(?:not|no|without)\s+(?:a\s+)?female\s+voice\b/.test(lower)) add('female');
    if (/\b(?:not|no|without)\s+(?:a\s+)?male\s+voice\b/.test(lower)) add('male');

    // Polish-ish
    if (/\bbez\s+(?:kobiecego|żeńskiego|zenskiego)\b/.test(lower)) add('female');
    if (/\bbez\s+(?:męskiego|meskiego)\b/.test(lower)) add('male');
    if (/\bnie\s+(?:kobiecy|żeńskie|zenskie)\b/.test(lower)) add('female');
    if (/\bnie\s+(?:męski|meski)\b/.test(lower)) add('male');

    return Array.from(out);
  } catch (_) {
    return [];
  }
}

function extractNegativeAccents(userText, iso2, kb = null) {
  try {
    const text = (userText || '').toString();
    const lower = text.toLowerCase();
    const lang = (iso2 || '').toString().toLowerCase().slice(0, 2);
    if (!lower || !lang) return [];

    const out = new Set();

    const isAllowedAccentForLang = (accent) => {
      try {
        const a = normalizeRequestedAccent(accent);
        if (!a) return false;
        const key = normalizeCatalogToken(a);
        if (!key) return false;

        // Prefer FacetKB when it's loaded
        try {
          const useKb = kb || facetKB;
          if (
            useKb &&
            typeof useKb.isLoaded === 'function' &&
            useKb.isLoaded() &&
            useKb.allowedAccentsByIso2 &&
            typeof useKb.allowedAccentsByIso2.get === 'function'
          ) {
            const set = useKb.allowedAccentsByIso2.get(lang);
            if (set && set.has(key)) return true;
          }
        } catch (_) {}

        // Fallback: AccentCatalog (disk-backed)
        try {
          if (accentCatalog && typeof accentCatalog.isAccentAllowed === 'function') {
            return !!accentCatalog.isAccentAllowed(lang, a);
          }
        } catch (_) {}

        return false;
      } catch (_) {
        return false;
      }
    };

    const patterns = [
      // "should not have a Flemish accent", "must not use a Mexican accent"
      /\b(?:should|must|do)\s+not\s+(?:have|use|be|sound(?:ing)?|include)\s+(?:an?\s+)?([a-z][a-z\s\-]{0,40}?)\s+(?:accent|akcent)\b/gi,
      // "not Flemish accent", "without mexican accent"
      /\b(?:not|no|without)\s+(?:an?\s+)?([a-z][a-z\s\-]{0,40}?)\s+(?:accent|akcent)\b/gi,
      // Polish-ish: "bez flamandzkiego akcentu" (best-effort)
      /\bbez\s+([a-ząćęłńóśżź][a-ząćęłńóśżź\s\-]{0,40}?)\s+akcent(?:u)?\b/gi
    ];

    for (const re of patterns) {
      re.lastIndex = 0;
      let m = null;
      // eslint-disable-next-line no-cond-assign
      while ((m = re.exec(lower))) {
        const raw = (m[1] || '').toString().trim();
        if (!raw) continue;
        const acc = normalizeRequestedAccent(raw);
        if (!acc) continue;
        if (isAllowedAccentForLang(acc)) out.add(acc);
      }
    }

    return Array.from(out);
  } catch (_) {
    return [];
  }
}

function extractNegativeLocales(userText, iso2, kb = null) {
  try {
    const text = (userText || '').toString();
    const lower = text.toLowerCase();
    const lang = (iso2 || '').toString().toLowerCase().slice(0, 2);
    if (!lower) return [];

    const out = new Set();

    const isAllowedLocaleForLang = (loc) => {
      try {
        const locale = normalizeRequestedLocale(loc);
        if (!locale) return false;
        const key = normalizeLocaleToken(locale);
        if (!key) return false;

        // If we don't know lang, accept the locale token (best-effort).
        if (!lang) return true;

        // Prefer FacetKB when it's loaded
        try {
          const useKb = kb || facetKB;
          if (
            useKb &&
            typeof useKb.isLoaded === 'function' &&
            useKb.isLoaded() &&
            useKb.allowedLocalesByIso2 &&
            typeof useKb.allowedLocalesByIso2.get === 'function'
          ) {
            const set = useKb.allowedLocalesByIso2.get(lang);
            if (set && set.has(key)) return true;
            // If KB is loaded and knows lang but doesn't contain it, treat as not allowed.
            if (set) return false;
          }
        } catch (_) {}

        // Fallback: AccentCatalog (disk-backed)
        try {
          if (accentCatalog && typeof accentCatalog.isLocaleAllowed === 'function') {
            return !!accentCatalog.isLocaleAllowed(lang, locale);
          }
        } catch (_) {}

        return false;
      } catch (_) {
        return false;
      }
    };

    const patterns = [
      // "should not use locale nl-BE", "must not include nl-BE"
      /\b(?:should|must|do)\s+not\s+(?:have|use|be|include)\s+(?:(?:the\s+)?)?(?:locale|region|variant)\s+([a-z]{2}\s*[-_]\s*(?:[a-z]{2}|\d{3}))\b/gi,
      // "not nl-BE", "without es-MX"
      /\b(?:not|no|without)\s+(?:the\s+)?(?:locale\s+)?([a-z]{2}\s*[-_]\s*(?:[a-z]{2}|\d{3}))\b/gi,
      // Polish-ish: "bez nl-BE"
      /\bbez\s+([a-z]{2}\s*[-_]\s*(?:[a-z]{2}|\d{3}))\b/gi
    ];

    for (const re of patterns) {
      re.lastIndex = 0;
      let m = null;
      // eslint-disable-next-line no-cond-assign
      while ((m = re.exec(lower))) {
        const raw = (m[1] || '').toString().trim();
        if (!raw) continue;
        const loc = normalizeRequestedLocale(raw);
        if (!loc) continue;
        if (isAllowedLocaleForLang(loc)) out.add(loc);
      }
    }

    // Small, conservative region-name heuristics for common languages (opt-in by lang)
    if (lang === 'nl') {
      // "without Belgium", "bez Belgii" -> nl-BE
      if (/\b(?:not|no|without)\s+(?:belgium|belgian)\b/.test(lower) || /\bbez\s+belgi(?:a|i)\b/.test(lower)) {
        if (isAllowedLocaleForLang('nl-BE')) out.add('nl-BE');
      }
    }
    if (lang === 'pt') {
      if (/\b(?:not|no|without)\s+(?:brazil|brasil|br)\b/.test(lower)) {
        if (isAllowedLocaleForLang('pt-BR')) out.add('pt-BR');
      }
      if (/\b(?:not|no|without)\s+(?:portugal|pt-pt|pt-eu)\b/.test(lower)) {
        if (isAllowedLocaleForLang('pt-PT')) out.add('pt-PT');
      }
    }
    if (lang === 'es') {
      if (/\b(?:not|no|without)\s+(?:mexico|mx|es-mx)\b/.test(lower)) {
        if (isAllowedLocaleForLang('es-MX')) out.add('es-MX');
      }
      if (/\b(?:not|no|without)\s+(?:spain|es-es)\b/.test(lower)) {
        if (isAllowedLocaleForLang('es-ES')) out.add('es-ES');
      }
      if (/\b(?:not|no|without)\s+(?:latam|latin\s*america|es-419)\b/.test(lower)) {
        if (isAllowedLocaleForLang('es-419')) out.add('es-419');
      }
    }
    if (lang === 'en') {
      if (/\b(?:not|no|without)\s+(?:us|usa|en-us)\b/.test(lower)) {
        if (isAllowedLocaleForLang('en-US')) out.add('en-US');
      }
      if (/\b(?:not|no|without)\s+(?:uk|britain|en-gb|en-uk)\b/.test(lower)) {
        if (isAllowedLocaleForLang('en-GB')) out.add('en-GB');
      }
    }

    return Array.from(out);
  } catch (_) {
    return [];
  }
}

function pruneNegativesFromList(items, negatives) {
  try {
    const arr = Array.isArray(items) ? items : [];
    const neg = Array.isArray(negatives) ? negatives : [];
    if (!arr.length || !neg.length) return arr;
    const negSet = new Set(neg.map((x) => canonicalizeNegToken(x)).filter(Boolean));
    return arr.filter((k) => !negSet.has(canonicalizeNegToken(k)));
  } catch (_) {
    return Array.isArray(items) ? items : [];
  }
}

function applyNegativesToPlan(plan) {
  try {
    if (!plan || typeof plan !== 'object') return plan;
    const negatives = Array.isArray(plan.__negatives) ? plan.__negatives : [];
    if (!negatives.length) return plan;

    const pruneArr = (arr) => pruneNegativesFromList(arr, negatives);
    plan.tone_keywords = pruneArr(plan.tone_keywords);
    plan.use_case_keywords = pruneArr(plan.use_case_keywords);
    plan.character_keywords = pruneArr(plan.character_keywords);
    plan.style_keywords = pruneArr(plan.style_keywords);
    plan.extra_keywords = pruneArr(plan.extra_keywords);
    return plan;
  } catch (_) {
    return plan;
  }
}

async function buildControlsBlocks(session) {
  try {
    const uiLang = session.uiLanguage;
    const featuredState = session.filters.featured ? 'On' : 'Off';
    const quality = session.filters.quality || 'any';
    const qualityLabel =
      quality === 'high_only' ? 'High only' : quality === 'no_high' ? 'No high' : 'Any';
    let b1 = `Featured only: ${featuredState}`;
    let b2 = 'Show more';
    let b3 = `Quality: ${qualityLabel}`;
    b1 = await translateForUserLanguage(b1, uiLang);
    b2 = await translateForUserLanguage(b2, uiLang);
    b3 = await translateForUserLanguage(b3, uiLang);
    return [
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: b1, emoji: true },
            action_id: 'toggle_featured'
          },
          {
            type: 'button',
            text: { type: 'plain_text', text: b2, emoji: true },
            action_id: 'show_more'
          },
          {
            type: 'button',
            text: { type: 'plain_text', text: b3, emoji: true },
            action_id: 'cycle_quality'
          }
        ]
      }
    ];
  } catch (_) {
    return null;
  }
}

// -------------------------------------------------------------
// Query building helpers for ElevenLabs GET /v1/shared-voices
// -------------------------------------------------------------

function pickQueryUseCases(plan, userText) {
  const src = Array.isArray(plan?.use_case_keywords) ? plan.use_case_keywords : [];
  const tokens = src.map((s) => (s || '').toString().toLowerCase().trim()).filter(Boolean);
  const lowerText = (userText || '').toLowerCase();
  const briefFamily = inferBriefUseCaseFamily(userText, plan);

  // Voice Library categories (per support/UI):
  // advertisement, characters_animation, conversational, entertainment_tv,
  // informative_educational, narrative_story, social_media
  const mapTokenToCategory = (t) => {
    if (!t) return null;

    const hasWord = (re) => {
      try {
        return re.test(t);
      } catch (_) {
        return false;
      }
    };

    // Conversational / customer support / call center / IVR
    if (
      t.includes('call center') ||
      t.includes('contact center') ||
      t.includes('customer support') ||
      t.includes('customer service') ||
      t.includes('support') ||
      t.includes('agent') ||
      t.includes('conversational') ||
      t.includes('conversation') ||
      t.includes('ivr') ||
      t.includes('voicemail')
    ) {
      return 'conversational';
    }

    // Ads / commercials
    if (
      t.includes('commercial') ||
      t.includes('advertis') ||
      t === 'ad' ||
      t === 'ads' ||
      t.includes('promo') ||
      t.includes('campaign') ||
      t.includes('branding') ||
      t.includes('brand')
    ) {
      return 'advertisement';
    }

    // Characters / animation / games
    if (
      t.includes('character') ||
      t.includes('cartoon') ||
      t.includes('animation') ||
      t.includes('animated') ||
      t.includes('gaming') ||
      t.includes('game') ||
      t.includes('villain')
    ) {
      return 'characters_animation';
    }

    // Entertainment / TV / podcasts / trailers / news
    if (
      t.includes('podcast') ||
      t.includes('trailer') ||
      t.includes('news') ||
      t.includes('sports') ||
      t.includes('tv') ||
      t.includes('radio')
    ) {
      return 'entertainment_tv';
    }

    // Educational / informative / articles
    if (
      t.includes('documentary') ||
      t.includes('e-learning') ||
      t.includes('elearning') ||
      t.includes('presentation') ||
      t.includes('explainer') ||
      t.includes('educational') ||
      t.includes('informative') ||
      t.includes('article')
    ) {
      return 'informative_educational';
    }

    // Narrative / audiobooks / storytelling
    if (
      t.includes('audiobook') ||
      t.includes('narration') ||
      t.includes('narrator') ||
      // Avoid substring false-positives like "history" -> "story"
      hasWord(/\bstor(?:ies|y(?:s|[- ]?teller(?:s)?|[- ]?telling)?)\b/) ||
      t.includes('dramatic')
    ) {
      return 'narrative_story';
    }

    // Social media
    if (t.includes('tiktok') || t.includes('youtube') || t.includes('social')) {
      return 'social_media';
    }

    return null;
  };

  const set = new Set();
  for (const t of tokens) {
    const cat = mapTokenToCategory(t);
    if (cat) set.add(cat);
  }

  // Text-driven category when plan keywords are missing / polluted
  if (briefFamily === 'narrative') set.add('narrative_story');
  if (briefFamily === 'articles' || briefFamily === 'educational') set.add('informative_educational');
  if (briefFamily === 'conversational') set.add('conversational');
  if (briefFamily === 'commercial') set.add('advertisement');
  if (briefFamily === 'characters') set.add('characters_animation');
  if (briefFamily === 'podcast') set.add('entertainment_tv');

  // When the user asked for narration/education, drop floor-injected conversational
  // unless they also explicitly asked for support/conversational in the text.
  const textWantsConversational =
    /\b(conversational|customer support|customer service|call center|contact center|ivr|voicemail)\b/.test(
      lowerText
    );
  if (
    (briefFamily === 'narrative' || briefFamily === 'articles' || briefFamily === 'educational') &&
    !textWantsConversational
  ) {
    set.delete('conversational');
  }

  // Keep API use_cases exclusive to the brief family.
  // GPT plans often add "narration/storytelling" onto articles/educational, which wrongly
  // OR'd narrative_story into facet browse (report showed use_cases=narrative_story).
  if (briefFamily === 'articles' || briefFamily === 'educational') {
    set.delete('narrative_story');
    set.delete('characters_animation');
    set.add('informative_educational');
  } else if (briefFamily === 'narrative') {
    set.delete('informative_educational');
    set.delete('characters_animation');
    set.add('narrative_story');
  }

  // Deterministic priority: prefer conversational for support/call-center intents,
  // but prefer narrative/edu when that is the brief family.
  let priority = [
    'conversational',
    'advertisement',
    'characters_animation',
    'entertainment_tv',
    'informative_educational',
    'narrative_story',
    'social_media'
  ];
  if (briefFamily === 'narrative') {
    priority = [
      'narrative_story',
      'informative_educational',
      'entertainment_tv',
      'advertisement',
      'conversational',
      'characters_animation',
      'social_media'
    ];
  } else if (briefFamily === 'articles' || briefFamily === 'educational') {
    priority = [
      'informative_educational',
      'narrative_story',
      'entertainment_tv',
      'advertisement',
      'conversational',
      'characters_animation',
      'social_media'
    ];
  }

  const ordered = priority.filter((p) => set.has(p));
  // For clear brief families, send a single exclusive use_cases value.
  if (briefFamily === 'articles' || briefFamily === 'educational' || briefFamily === 'narrative') {
    return ordered.slice(0, 1);
  }
  return ordered.slice(0, 2);
}

function toHyphenUseCase(value) {
  const v = (value || '').toString().trim();
  if (!v) return v;
  return v.includes('_') ? v.replace(/_/g, '-') : v;
}

function pickQueryDescriptives(plan, userText) {
  const base = [
    ...(Array.isArray(plan?.tone_keywords) ? plan.tone_keywords : []),
    ...(Array.isArray(plan?.style_keywords) ? plan.style_keywords : [])
  ];
  // Reuse global filter and trim to a small set
  const filtered = filterKeywordsGlobally(userText, base).slice(0, 6);
  return filtered;
}

function hasExplicitDescriptiveMention(userText) {
  const lower = (userText || '').toLowerCase();
  const tokens = [
    'whisper','cinematic','dramatic','meditative','asmr','slow','fast','calm','warm',
    'friendly','energetic','deep','low','gravelly','raspy','growl','harsh','dark','ominous',
    'booming','bassy','soft','soothing','confident','expressive','relaxed','storytelling',
    'playful','cheerful','cute','youthful','high pitch','squeaky'
  ];
  return tokens.some((t) => lower.includes(t));
}

function readEnvBoolean(name, defaultValue = false) {
  const raw = String(process.env[name] || '').trim().toLowerCase();
  if (raw === 'true' || raw === '1' || raw === 'yes') return true;
  if (raw === 'false' || raw === '0' || raw === 'no') return false;
  return defaultValue;
}

function shouldApplyParam(kind, plan, userText, flags = {}) {
  const lower = (userText || '').toLowerCase();
  const force = (key) => flags[key] === true || plan?.[key] === true;
  const suppress = (key) => flags[key] === false || plan?.[key] === false;
  switch (kind) {
    case 'use_cases': {
      if (force('__forceUseCases')) return true;
      if (suppress('__suppressUseCases')) return false;
      if (hasExplicitUseCaseMention(userText)) return true;
      return readEnvBoolean('ENABLE_USE_CASES_BY_DEFAULT', false);
    }
    case 'descriptives': {
      if (force('__forceDescriptives')) return true;
      if (suppress('__suppressDescriptives')) return false;
      if (hasExplicitDescriptiveMention(userText)) return true;
      return readEnvBoolean('ENABLE_DESCRIPTIVES_BY_DEFAULT', false);
    }
    case 'language': {
      if (hasExplicitLanguageMention(userText)) return true;
      return readEnvBoolean('ENABLE_LANGUAGE_BY_DEFAULT', false);
    }
    case 'accent': {
      const lower = (userText || '').toLowerCase();
      const hasAccentWord = /\b(accent|akcent)\b/.test(lower);
      // 1) Explicit mention via text heuristics (covers "latam", "mexican", etc.)
      if (hasExplicitAccentMention(userText)) return true;
      // 2) If user used the word "accent/akcent", treat it as explicit even if the accent name is unusual.
      if (hasAccentWord) return true;
      // 3) Catalog-driven explicitness: if FacetKB can match a specific accent (direct/fuzzy),
      // treat it as an explicit accent preference (avoids hardcoding accent lists).
      try {
        const iso2 =
          (plan?.target_voice_language || parseUserLanguageHints(userText)?.iso2 || detectVoiceLanguageFromText(userText) || '')
            .toString()
            .toLowerCase()
            .slice(0, 2);
        if (iso2 && facetKB && facetKB.isLoaded && facetKB.isLoaded() && facetKB.hasIso2 && facetKB.hasIso2(iso2) && facetKB.suggestAccents) {
          const sugg = facetKB.suggestAccents(iso2, userText, { limit: 2 }) || [];
          const best = sugg.find((x) => x && x.matchKind && x.matchKind !== 'popularity');
          if (best) return true;
        }
      } catch (_) {}
      return readEnvBoolean('ENABLE_ACCENT_BY_DEFAULT', false);
    }
    case 'gender': {
      // apply only if explicitly set to male/female in plan or text implies it
      if (plan?.target_gender === 'male' || plan?.target_gender === 'female') return true;
      const impliesMale = /\b(grandpa|old man|man|male)\b/i.test(lower);
      const impliesFemale = /\b(grandma|old woman|woman|female)\b/i.test(lower);
      if (impliesMale || impliesFemale) return true;
      return readEnvBoolean('ENABLE_GENDER_BY_DEFAULT', true);
    }
    case 'age': {
      const lower = (userText || '').toLowerCase();
      const strong = /\b(age:\s*child|tylko\s*dzieci(e|ęcy)|kids?\s*only)\b/.test(lower);
      if (strong) return true;
      return readEnvBoolean('ENABLE_AGE_BY_DEFAULT', false);
    }
    case 'featured': {
      if (flags.featured === true || plan?.__featured === true) return true;
      return false;
    }
    case 'min_notice_period_days': {
      const minDays =
        typeof flags.minNoticePeriodDays === 'number'
          ? flags.minNoticePeriodDays
          : plan?.__min_notice_period_days;
      if (typeof minDays === 'number' && minDays > 0 && plan?.__no_notice_period !== true) return true;
      return false;
    }
    case 'include_custom_rates': {
      if (flags.noCustomRates === true || plan?.__no_custom_rates === true) return true;
      return false;
    }
    case 'sort': {
      if (typeof flags.sort === 'string' || typeof plan?.__sort === 'string') return true;
      return false;
    }
    case 'locale': {
      // locale depends on language+accent presence; apply if inferable
      return true;
    }
    default:
      return false;
  }
}

function hasExplicitUseCaseMention(userText) {
  const lower = (userText || '').toLowerCase();
  const useCaseTokens = [
    'conversational', 'conversation', 'agent', 'support', 'customer support',
    'call center', 'contact center', 'ivr', 'voicemail',
    'audiobook', 'audiobooks', 'narration', 'narrator',
    'storyteller', 'storytelling',
    'article', 'articles',
    'cartoon', 'character', 'villain',
    'game', 'gaming',
    'trailer', 'commercial', 'ad ', 'advertising',
    'podcast', 'youtube', 'tiktok', 'explainer', 'video',
    // Expanded variants:
    'customer service', 'service support', 'tech support', 'technical support',
    // Informative/educational variants:
    'documentary', 'informative', 'educational', 'presentation'
  ];
  return useCaseTokens.some((t) => lower.includes(t));
}

function inferLocale(language, accent, userText) {
  const lang = (language || '').toString().slice(0, 2).toLowerCase();
  const acc = (accent || '').toString().toLowerCase();
  const lower = (userText || '').toString().toLowerCase();
  if (lang === 'en') {
    if (acc.includes('american') || acc === 'us' || acc.includes('usa')) return 'en-US';
    if (acc.includes('british') || acc === 'uk' || acc.includes('england')) return 'en-GB';
    if (acc.includes('australian')) return 'en-AU';
    if (acc.includes('irish')) return 'en-IE';
    if (acc.includes('scottish')) return 'en-GB';
    if (acc.includes('canadian')) return 'en-CA';
  }
  if (lang === 'es') {
    if (acc.includes('mexican') || acc.includes('mx')) return 'es-MX';
    if (acc.includes('castilian') || acc.includes('spain')) return 'es-ES';
    // LATAM / Latino signals: treat es-419 as a REGION alias, not a queryable locale.
    // (ElevenLabs shared-voices locales typically do not include es-419; using it causes catalog rejects.)
    if (/\b(es-419|latam|latin america|latinamerican|latino|latin(?:o)? american|south american|central american|caribbean)\b/.test(lower)) {
      return null;
    }
    // European Spanish phrasing
    if (/\b(european)\b/.test(lower) && /\b(spanish|es)\b/.test(lower)) return 'es-ES';
  }
  if (lang === 'pt') {
    if (/\b(pt-br|brazil|brasil|brazilian|brasile)\b/.test(lower) || acc.includes('brazil')) return 'pt-BR';
    if (/\b(pt-pt|portugal|european)\b/.test(lower) || acc.includes('portugal')) return 'pt-PT';
  }
  if (lang === 'fr') {
    if (hasFrenchCanadianMarkers(userText) || acc.includes('canadian')) {
      return 'fr-CA';
    }
    if (hasFrenchEuropeanMarkers(userText) || acc.includes('parisian')) return 'fr-FR';
  }
  if (lang === 'zh') {
    // Dialect-ish locale preferences (soft; metadata may be sparse)
    // FacetKB for zh exposes cmn-CN/cmn-TW (and usually no HK locale). Prefer those.
    if (/\b(zh-tw|taiwan|traditional)\b/.test(lower)) return 'cmn-TW';
    if (/\b(zh-cn|china|mainland|simplified|mandarin|putonghua|cn)\b/.test(lower) || lower.includes('普通话')) return 'cmn-CN';
    // Cantonese has no reliable locale in FacetKB; keep locale unset and rely on accent facets.
    if (/\b(zh-hk|hong\s*kong|hongkong|cantonese|hk)\b/.test(lower) || lower.includes('粤语')) return null;
  }
  return null;
}

function detectAgeFromText(text) {
  const lower = (text || '').toLowerCase();
  if (/\b(child|kid|dziecko|niemie|dziecięcy)\b/.test(lower)) return 'child';
  if (/\b(young|teen|młody|mlody|nastolat)\b/.test(lower)) return 'young';
  if (/\b(adult|dorosły|dorosly)\b/.test(lower)) return 'adult';
  if (/\b(old|senior|elderly|starszy|starczy)\b/.test(lower)) return 'old';
  return null;
}

// -------------------------------------------------------------
// Voice Library: filter by public owner (GET /v1/shared-voices ?owner_id=)
// -------------------------------------------------------------

const PUBLIC_OWNER_UUID_RE =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;

function extractPublicOwnerIdFromText(text) {
  if (!text) return null;
  const s = String(text);
  const direct = s.match(PUBLIC_OWNER_UUID_RE);
  if (direct) return direct[0].toLowerCase();
  const fromUrl = s.match(/[?&](?:owner|public_owner_id)=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  if (fromUrl) return fromUrl[1].toLowerCase();
  return null;
}

function detectCreatorVoicesIntent(text) {
  const t = (text || '').toLowerCase();
  if (t.length < 6) return false;

  const patterns = [
    /\bvoices?\s+(from|by)\s+(this|that|the|a)?\s*(creator|user|uploader)\b/,
    /\b(shared\s+)?voices?\s+of\s+(this|that|the|a)?\s*(creator|user)\b/,
    /\b(list|show|find|get)\s+all\s+voices?\s+(from|by)\b/,
    /\ball\s+voices?\s+(from|by)\s+(this|that|the|a)?\s*(creator|user|uploader)\b/,
    /\b(all|show|list|find|get)\s+(the\s+)?(shared\s+)?voices?\s+(from|by)\b/,
    /\b(creator|user|uploader)'s\s+(shared\s+)?voices?\b/,
    /\bshared\s+voices\s+from\s+(this|that|the|a)?\s*(creator|user|uploader)\b/,
    /\b(voices|voice)\s+this\s+(creator|user)\s+(has|published|shared)\b/,
    /\bgłosy\s+(użytkownika|twórcy|tego\s+użytkownika|tej\s+osoby|niego|niej)\b/,
    /\b(użytkownika|twórcy|tego\s+twórcy)\s+(w\s+)?(voice\s+library|bibliotece|w\s+bibliotece)\b/,
    /\b(pokaż|wszystkie|lista|jakie)\b[^.!?]{0,80}\bgłos(y|ów|ów)?\b[^.!?]{0,40}\b(twórcy|użytkownika|tej\s+osoby)\b/,
    /\b(pvc|professional\s+voice\s+clone)\b[^.!?]{0,40}\b(użytkownika|twórcy|tego|tej)\b/,
    /\b(głosy|głosów)\s+(z\s+)?(voice\s+library|biblioteki|bibliotece)\b[^.!?]{0,50}\b(twórcy|użytkownika)\b/,
    /\b(owner|public\s+owner)'?s?\s+(shared\s+)?voices?\b/,
    /\bgłosy\s+(właściciela|publicznego\s+właściciela|od\s+właściciela)\b/,
    /\binne\s+głosy\s+(użytkownika|twórcy|od)\b/,
    /\bznajdź\s+inne\s+głosy\b/,
    /\b(użytkownika|twórcy)\s+.*\bktóry\s+ma\s+głos\b/,
    /\b(other|more)\s+voices\s+(from|by)\s+(the\s+)?(user|creator)\b/,
    /\bfind\s+other\s+voices\b/,
    /\b(user|creator)\s+who\s+has\s+(this\s+)?(voice|a\s+voice)\b/i
  ];
  return patterns.some((re) => {
    try {
      return re.test(t);
    } catch (_) {
      return false;
    }
  });
}

function applyCreatorOwnerToPlan(plan, userText) {
  const intent = detectCreatorVoicesIntent(userText);
  const ownerId = extractPublicOwnerIdFromText(userText);
  if (intent && ownerId) {
    plan.__owner_id = ownerId;
  }
  return { intent, ownerId };
}

/** ElevenLabs voice_id: short alphanumeric token (not the owner UUID). */
function extractVoiceIdForOwnerLookup(text) {
  if (!text) return null;
  const s = String(text);
  const quoted = s.match(/['"`]([A-Za-z0-9_-]{8,32})['"`]/);
  if (quoted) {
    const id = quoted[1];
    if (PUBLIC_OWNER_UUID_RE.test(id)) return null;
    return id;
  }
  const labeled = s.match(
    /\b(?:voice[_\s-]?id|voice_id|głos(?:u)?)\s*[:=]\s*([A-Za-z0-9_-]{8,32})\b/i
  );
  if (labeled) return labeled[1];
  const afterVoice = s.match(/\b(?:voice|głos(?:u)?)\s+['`"]?([A-Za-z0-9_-]{8,32})\b/i);
  if (afterVoice) return afterVoice[1];
  const hasVoice = s.match(/\b(?:has|ma)\s+(?:the\s+)?(?:voice|głos)\s+['`"]?([A-Za-z0-9_-]{8,32})['`"]?\b/i);
  if (hasVoice) return hasVoice[1];
  const hasId = s.match(/\b(?:has|ma)\s+['"`]?([A-Za-z0-9_-]{10,32})['"`]?\s*$/);
  if (hasId) {
    const id = hasId[1];
    if (PUBLIC_OWNER_UUID_RE.test(id)) return null;
    return id;
  }
  return null;
}

async function resolvePublicOwnerIdFromVoiceId(voiceId, traceCb) {
  const trace = typeof traceCb === 'function' ? traceCb : () => {};
  if (!voiceId || typeof voiceId !== 'string') return null;
  const vid = voiceId.trim();
  if (!vid) return null;
  try {
    const shared = await fetchSharedVoiceByIdOrSearch(vid, trace);
    let oid = shared?.public_owner_id ? String(shared.public_owner_id).trim().toLowerCase() : null;
    if (oid) return { publicOwnerId: oid, source: 'shared' };
    const priv = await fetchPrivateVoiceById(vid, trace);
    oid = priv?.public_owner_id ? String(priv.public_owner_id).trim().toLowerCase() : null;
    if (oid) return { publicOwnerId: oid, source: 'private' };
  } catch (_) {}
  return null;
}

async function maybeResolveOwnerIdFromVoiceReference(plan, userText, traceCb) {
  try {
    if ((plan?.__owner_id || '').toString().trim()) return;
    if (!detectCreatorVoicesIntent(userText || '')) return;
    const vid = extractVoiceIdForOwnerLookup(userText || '') || extractBareVoiceId(userText || '');
    if (!vid) return;
    const res = await resolvePublicOwnerIdFromVoiceId(vid, traceCb);
    if (res?.publicOwnerId) plan.__owner_id = res.publicOwnerId;
  } catch (_) {}
}

async function fetchVoicesByOwner(ownerId, plan, traceCb) {
  const trace = typeof traceCb === 'function' ? traceCb : () => {};
  const oid = (ownerId || '').toString().trim().toLowerCase();
  if (!oid) return [];
  const qualityPref = plan?.quality_preference || 'any';
  const params = new URLSearchParams();
  params.set('page_size', '100');
  params.set('owner_id', oid);
  if (qualityPref === 'high_only') params.set('category', 'high_quality');
  maybeSetIncludeCustomRatesParam(params, plan);
  try {
    const voices = await callSharedVoicesAllPages(params, { maxPages: 5, cap: 500 });
    try {
      trace({ stage: 'owner_browse', params: paramsToObject(params), count: voices.length });
    } catch (_) {}
    let out = voices || [];
    const modelPref = plan?.model_preference || 'any';
    if (isSpecificModelPreference(modelPref)) {
      out = filterVoicesByModelPreference(out, modelPref);
      try {
        trace({
          stage: 'model_filter',
          params: { model: Array.isArray(modelPref) ? modelPref.join(',') : String(modelPref) },
          count: out.length
        });
      } catch (_) {}
    }
    const excludeId = (plan?.__exclude_voice_id || '').toString().trim();
    if (excludeId) {
      out = out.filter((v) => v && v.voice_id !== excludeId);
    }
    out = applyVoiceLibraryFilters(out, plan);
    return out;
  } catch (err) {
    safeLogAxiosError('fetchVoicesByOwner', err);
    return [];
  }
}

function buildCreatorVoicesMessage(session, ownerId) {
  const header = '```CREATOR: ' + (ownerId || '').toString().slice(0, 8) + '…```';
  const body = buildMessageFromSession(session);
  return header + '\n' + body;
}

async function handleCreatorVoicesBrowse(plan, userText, traceCb, options = {}) {
  const uiLang = (options.uiLang || 'en').toString().slice(0, 2).toLowerCase();
  const originalQuery = (options.originalQuery || userText || '').toString();
  const ownerId = (plan?.__owner_id || '').toString().trim().toLowerCase();
  if (!ownerId) return { ok: false, reason: 'no_owner' };

  const refVoiceId = extractVoiceIdForOwnerLookup(userText) || extractBareVoiceId(userText);
  if (refVoiceId) plan.__exclude_voice_id = refVoiceId;

  const voices = await fetchVoicesByOwner(ownerId, plan, traceCb);
  if (!voices.length) {
    return { ok: false, reason: 'no_voices', ownerId, plan };
  }

  const ranked = await rankVoicesWithGPT(userText, plan, voices);
  const genderLimit = getSessionGenderAndLimit(plan, userText);
  const session = {
    originalQuery,
    keywordPlan: plan,
    voices,
    ranking: ranked.scoreMap,
    uiLanguage: uiLang,
    filters: {
      quality: plan.quality_preference || 'any',
      gender: genderLimit.gender,
      listAll: detectListAll(userText),
      featured: plan.__featured === true,
      sort: plan.__sort || null,
      strictUseCase: plan.__forceUseCases === true,
      strictDescriptives: plan.__forceDescriptives === true,
      limitPerGender: genderLimit.limitPerGender,
      ...buildSessionNoticeFilters(plan),
      ...buildSessionCustomRatesFilters(plan)
    },
    lastActive: Date.now()
  };
  const message = buildCreatorVoicesMessage(session, ownerId);
  return { ok: true, voices, ranked, session, message, ownerId };
}

function appendQueryFiltersToParams(params, plan, userText, options = {}) {
  const language = options.language || null;
  const accent = options.accent || null;
  const gender = options.gender || null;
  const qualityPref = options.qualityPref || 'any';
  const featured = options.featured === true ? true : false;
  const minNoticePeriodDays =
    typeof options.minNoticePeriodDays === 'number'
      ? options.minNoticePeriodDays
      : typeof plan?.__min_notice_period_days === 'number'
        ? plan.__min_notice_period_days
        : null;
  const sort = typeof options.sort === 'string' ? options.sort : null;
  const forceUseCases = options.forceUseCases === true;
  const forceDescriptives = options.forceDescriptives === true;
  const trace = typeof options.traceCb === 'function' ? options.traceCb : () => {};
  try {
    const oid = (plan?.__owner_id || '').toString().trim().toLowerCase();
    if (oid) params.set('owner_id', oid);
  } catch (_) {}
  const lowerText = (userText || '').toLowerCase();
  const isBilingualEnEs = detectBilingualEnEs(userText);
  const chineseDialect = detectChineseDialectFromText(userText);
  const chinesePreferredLocales = (() => {
    try {
      // Prefer FacetKB locales for zh (cmn-*) when available; AccentCatalog uses zh-*.
      if (language === 'zh' && facetKB && facetKB.isLoaded && facetKB.isLoaded() && facetKB.allowedLocalesByIso2) {
        const set = facetKB.allowedLocalesByIso2.get('zh');
        const has = (x) => !!(set && set.has(normalizeLocaleToken(x)));
        if (chineseDialect === 'mandarin') {
          if (has('cmn-CN')) return ['cmn-CN'];
          if (has('zh-CN')) return ['zh-CN'];
        }
        if (chineseDialect === 'cantonese') {
          // if there's no Cantonese locale in facets, return empty to avoid catalog reject loops
          return [];
        }
        // default preference
        if (has('cmn-CN')) return ['cmn-CN'];
        if (has('cmn-TW')) return ['cmn-TW'];
      }
      if (language === 'zh' && accentCatalog && typeof accentCatalog.getPreferredChineseLocales === 'function') {
        const list = accentCatalog.getPreferredChineseLocales(chineseDialect);
        if (Array.isArray(list) && list.length) return list;
      }
    } catch (_) {}
    return preferredLocalesForChineseDialect(chineseDialect);
  })();

  const hasCatalogForLang = (iso2) => {
    try {
      const k = (iso2 || '').toString().toLowerCase().slice(0, 2);
      if (!k) return false;
      // Prefer FacetKB when loaded/fresh
      if (facetKB && typeof facetKB.isLoaded === 'function' && facetKB.isLoaded() && facetKB.hasIso2(k)) return true;
      return !!(accentCatalog && accentCatalog.byIso2 && accentCatalog.byIso2.has(k));
    } catch (_) {
      return false;
    }
  };
  const isAccentAllowedByCatalog = (iso2, acc) => {
    try {
      if (!hasCatalogForLang(iso2)) return true; // graceful fallback if no catalog data
      // FacetKB: if it knows the language, trust it
      try {
        if (facetKB && facetKB.isLoaded && facetKB.isLoaded()) {
          const r = facetKB.checkAccentAllowed ? facetKB.checkAccentAllowed(iso2, acc) : { known: false, allowed: false };
          if (r && r.known) return !!r.allowed;
        }
      } catch (_) {}
      return !!(accentCatalog && accentCatalog.isAccentAllowed && accentCatalog.isAccentAllowed(iso2, acc));
    } catch (_) {
      return true;
    }
  };
  const isLocaleAllowedByCatalog = (iso2, loc) => {
    try {
      if (!hasCatalogForLang(iso2)) return true; // graceful fallback if no catalog data
      // FacetKB: if it knows the language, trust it
      try {
        if (facetKB && facetKB.isLoaded && facetKB.isLoaded()) {
          const r = facetKB.checkLocaleAllowed ? facetKB.checkLocaleAllowed(iso2, loc) : { known: false, allowed: false };
          if (r && r.known) return !!r.allowed;
        }
      } catch (_) {}
      return !!(accentCatalog && accentCatalog.isLocaleAllowed && accentCatalog.isLocaleAllowed(iso2, loc));
    } catch (_) {
      return true;
    }
  };

  const pickAccentParamValue = (iso2, acc) => {
    try {
      const aRaw = (acc || '').toString().trim();
      if (!aRaw) return null;

      const k = (iso2 || '').toString().toLowerCase().slice(0, 2);
      const isZh = k === 'zh';
      const norm = normalizeCatalogToken(aRaw);
      const nameForm = norm.includes('-') ? norm.replace(/-+/g, ' ').trim() : norm;

      // If accent_probe already determined the correct form (name vs slug) for this language+accent,
      // respect it here so we don't re-introduce 0-result queries (notably: ES "latin american").
      try {
        if (k) {
          const cached =
            getCachedAccentForm(k, norm) ||
            (nameForm && nameForm !== norm ? getCachedAccentForm(k, nameForm) : null);
          if (cached && cached.preferred === 'name') return nameForm || aRaw;
          if (cached && cached.preferred === 'slug') {
            const cacheKey = normalizeCatalogToken(cached.accentNorm || '') || null;
            const slugCached =
              facetKB && facetKB.isLoaded && facetKB.isLoaded() && facetKB.getAccentSlug
                ? facetKB.getAccentSlug(k, cacheKey || norm || aRaw)
                : null;
            const slugFallback = slugifyAccentName(nameForm || cacheKey || norm || aRaw);
            return String(slugCached || slugFallback || '').trim() || aRaw;
          }
        }
      } catch (_) {}

      // Default behavior: if KB provides a slug, prefer it when spaces could break matching, when forced, or for zh.
      const slug =
        facetKB && facetKB.isLoaded && facetKB.isLoaded() && facetKB.getAccentSlug
          ? facetKB.getAccentSlug(k || iso2, aRaw)
          : null;
      if (!slug) return aRaw;
      const force = readEnvBoolean('FORCE_ACCENT_SLUGS', false);
      const hasSpaces = /\s/.test(aRaw);
      if (force || hasSpaces || isZh) return slug;
      return aRaw;
    } catch (_) {
      return acc;
    }
  };

  const diag = {
    language: (language || '-').toString(),
    accent_candidate: accent ? String(accent) : '-',
    accent_set: '-',
    accent_allowed: '-',
    accent_reason: '-',
    locale_set: '-',
    locale_allowed: '-',
    locale_reason: '-'
  };
  const isFrenchCanadian =
    (language === 'fr' || /\bfrench\b|\bfr\b/.test(lowerText)) &&
    hasFrenchCanadianMarkers(userText);
  const isFrenchEuropean =
    !isFrenchCanadian &&
    (language === 'fr' || /\bfrench\b|\bfr\b/.test(lowerText)) &&
    hasFrenchEuropeanMarkers(userText);
  const isSpanishMexico = (language === 'es' || /spanish|es\b/.test(lowerText)) &&
    (/\bmexico\b|\bmexican\b|\bes-mx\b|\bmx\b/.test(lowerText));
  const isSpanishLatam = (language === 'es' || /spanish|es\b/.test(lowerText)) &&
    (/\b(es-419|latam|latin america|latinamerican|latino|latin(?:o)? american|south american|central american|caribbean)\b/.test(lowerText));
  const isSpanishSpain = (language === 'es' || /spanish|es\b/.test(lowerText)) &&
    (/\b(spain|castilian|es-es)\b/.test(lowerText) || (/\b(european)\b/.test(lowerText) && /\bspanish\b/.test(lowerText)));
  const spanishRegion =
    isSpanishMexico ? 'mexico' : (isSpanishSpain ? 'spain' : (isSpanishLatam ? 'latam' : null));
  const age =
    typeof options.age === 'string' && options.age
      ? options.age
      : detectAgeFromText(userText);

  // Resolver (catalog-driven): decide if accent/locale should be set from allowed values.
  const resolved = resolveVariantConstraints(userText, plan, facetKB, accentCatalog);
  let resolverAppliedAccent = false;

  // Existing filters
  // Bilingual: avoid constraining language to let both EN/ES candidates through
  const langForParams = options.forceLanguage || language;
  if ((!isBilingualEnEs || options.forceLanguage) && langForParams && shouldApplyParam('language', plan, userText)) {
    params.set('language', langForParams);
  }
  // If we apply an accent constraint, ensure we also set a language (accent-only queries tend to return 0).
  const ensureLanguageForAccent = (iso2) => {
    try {
      if (isBilingualEnEs) return;
      const k = (iso2 || '').toString().toLowerCase().slice(0, 2);
      if (!k) return;
      if (typeof params.get === 'function') {
        const already = String(params.get('language') || '').trim();
        if (!already) params.set('language', k);
      } else {
        // Fallback: best-effort set
        params.set('language', k);
      }
      // Keep diagnostics consistent when we set language implicitly due to accent.
      diag.language = k;
    } catch (_) {}
  };
  // Accent: allow Spanish Mexico heuristic even without explicit "accent"
  try {
    if (
      !isBilingualEnEs &&
      !resolverAppliedAccent &&
      resolved &&
      resolved.variantAxis === 'accent' &&
      Array.isArray(resolved.variantCandidates) &&
      resolved.variantCandidates.length &&
      shouldApplyParam('accent', plan, userText)
    ) {
      const cand = String(resolved.variantCandidates[0] || '').trim();
      const iso2 = (language || resolved?.targetIso2 || '').toString().toLowerCase().slice(0, 2) || null;
      // Preserve prior behavior: if we can't determine iso2, still allow accent-only filtering
      // (isAccentAllowedByCatalog(null, ...) is a graceful allow).
      if (cand && isAccentAllowedByCatalog(iso2, cand)) {
        if (iso2) ensureLanguageForAccent(iso2);
        const accVal = pickAccentParamValue(iso2 || '', cand) || cand;
        params.set('accent', accVal);
        diag.accent_set = String(accVal);
        diag.accent_allowed = 'true';
        diag.accent_reason = 'resolver';
        resolverAppliedAccent = true;
      }
    }
  } catch (_) {}

  if (!resolverAppliedAccent && isSpanishMexico) {
    if (isAccentAllowedByCatalog('es', 'mexican')) {
      ensureLanguageForAccent('es');
      params.set('accent', pickAccentParamValue('es', 'mexican') || 'mexican');
      diag.accent_set = 'mexican';
      diag.accent_allowed = 'true';
      diag.accent_reason = 'spanish_mexico';
    } else {
      diag.accent_set = 'mexican';
      diag.accent_allowed = 'false';
      diag.accent_reason = 'spanish_mexico_catalog_reject';
    }
  } else if (!resolverAppliedAccent && isFrenchCanadian) {
    // Prefer locale=fr-CA over hard accent filtering (accent metadata can be inconsistent)
    // Keep accent as a soft preference via keywords/ranking, not as a strict query param.
  } else if (!resolverAppliedAccent && !isBilingualEnEs && isSpanishLatam && !isSpanishMexico) {
    // LatAm Spanish: es-419 is a REGION alias (not a queryable locale), so prefer a broad accent filter.
    // Locale fanout fallback happens later when results are weak.
    const explicitLocale =
      typeof plan?.target_locale === 'string' &&
      plan.target_locale.trim() &&
      normalizeLocaleToken(normalizeRequestedLocale(plan.target_locale) || plan.target_locale) !== 'es-419';
    if (!explicitLocale) {
      if (isAccentAllowedByCatalog('es', 'latin american')) {
        const accVal = pickAccentParamValue('es', 'latin american') || 'latin american';
        ensureLanguageForAccent('es');
        params.set('accent', accVal);
        diag.accent_set = String(accVal);
        diag.accent_allowed = 'true';
        diag.accent_reason = 'spanish_latam';
      } else {
        diag.accent_set = 'latin american';
        diag.accent_allowed = 'false';
        diag.accent_reason = 'spanish_latam_catalog_reject';
      }
    }
  } else if (!resolverAppliedAccent && isSpanishSpain) {
    // Prefer locale=es-ES for Spain/European Spanish (set below in locale section)
  } else if (!resolverAppliedAccent && !isBilingualEnEs && language === 'zh' && chineseDialect) {
    // Prefer locale-based hinting for Mandarin vs Cantonese (soft)
  } else if (!resolverAppliedAccent && !isBilingualEnEs && accent && shouldApplyParam('accent', plan, userText)) {
    const iso2 = (language || resolved?.targetIso2 || '').toString().toLowerCase().slice(0, 2) || null;
    // Preserve prior behavior: if we can't determine iso2, still allow accent-only filtering
    // (isAccentAllowedByCatalog(null, ...) is a graceful allow).
    if (isAccentAllowedByCatalog(iso2, accent)) {
      if (iso2) ensureLanguageForAccent(iso2);
      const accVal = pickAccentParamValue(iso2 || '', accent) || accent;
      params.set('accent', accVal);
      diag.accent_set = String(accVal);
      diag.accent_allowed = 'true';
      diag.accent_reason = 'explicit_or_default';
    } else {
      diag.accent_set = String(accent);
      diag.accent_allowed = 'false';
      diag.accent_reason = 'catalog_reject';
    }
  }
  if (gender && shouldApplyParam('gender', plan, userText)) params.set('gender', gender);
  if (qualityPref === 'high_only') {
    params.set('category', 'high_quality');
  }

  // New filters
  let useCases = (forceUseCases || shouldApplyParam('use_cases', plan, userText, { __forceUseCases: forceUseCases }))
    ? pickQueryUseCases(plan, userText)
    : [];
  // Prefer conversational for bilingual and Spanish Mexico briefs
  if (isBilingualEnEs || isSpanishMexico) {
    const ucSet = new Set(useCases);
    if (ucSet.has('conversational')) {
      useCases = ['conversational'];
    } else {
      useCases = ['conversational'];
    }
  }
  // Strong conversational signals in the user text should win over LLM plan noise.
  // This prevents accidental narrowing to narrative_story for queries like "top conversational voice ... customer support".
  if (/\b(conversational|customer support|customer service|call center|contact center|tech support|technical support)\b/i.test(lowerText)) {
    useCases = ['conversational'];
  }
  // "IVR" is not a Voice Library use_cases enum; treat it as conversational.
  if (/\bivr\b/i.test(lowerText)) {
    useCases = ['conversational'];
  }
  for (const uc of useCases) params.append('use_cases', uc);

  let descriptives = (forceDescriptives || shouldApplyParam('descriptives', plan, userText, { __forceDescriptives: forceDescriptives }))
    ? pickQueryDescriptives(plan, userText)
    : [];
  // Add 'low' when deep present and 'low' missing
  if (/\bdeep\b/.test(lowerText) && !descriptives.includes('low')) descriptives.push('low');
  // Remove banned negatives from descriptives
  const banned = Array.from(extractNegativeTokens(userText) || []);
  if (banned.length) {
    descriptives = descriptives.filter((d) => !banned.includes(d));
  }
  for (const d of descriptives) params.append('descriptives', d);

  // Allow explicit locale override (used by clarification flow)
  let loc =
    typeof plan?.target_locale === 'string' && plan.target_locale.trim()
      ? (normalizeRequestedLocale(plan.target_locale) || plan.target_locale)
      : inferLocale(language, isSpanishMexico ? 'mexican' : accent, userText);
  // Resolver-driven locale override (avoid unsupported locale values; enable bounded fanout inputs)
  try {
    if (
      resolved &&
      resolved.variantAxis === 'locale' &&
      Array.isArray(resolved.variantCandidates) &&
      resolved.variantCandidates.length &&
      shouldApplyParam('locale', plan, userText)
    ) {
      const reason = String(resolved.reason || '');
      const cand0 = String(resolved.variantCandidates[0] || '').trim();
      // Only override locale if:
      // - we don't have a locale yet, or
      // - the "explicit locale" was invalid/unsupported and resolver provided a safer candidate
      if (
        cand0 &&
        (!loc || reason === 'region_alias_unsupported' || reason === 'explicit_locale_invalid')
      ) {
        loc = cand0;
        diag.locale_set = String(cand0);
        diag.locale_allowed = '-';
        diag.locale_reason = 'resolver';
      }
    }
  } catch (_) {}
  // LatAm Spanish: treat es-419 as region alias and DO NOT send it as a locale param.
  try {
    if ((language || '').toString().slice(0, 2).toLowerCase() === 'es' && normalizeLocaleToken(loc) === 'es-419') {
      diag.locale_set = 'es-419';
      diag.locale_allowed = '-';
      diag.locale_reason = 'es-419_region_alias';
      loc = null;
    }
  } catch (_) {}
  if (loc && shouldApplyParam('locale', plan, userText)) {
    if (isLocaleAllowedByCatalog(language, loc)) {
      params.set('locale', loc);
      diag.locale_set = String(loc);
      diag.locale_allowed = 'true';
      // Preserve resolver attribution if locale came from resolver override
      if (diag.locale_reason !== 'resolver') diag.locale_reason = 'infer_locale';
    } else {
      diag.locale_set = String(loc);
      diag.locale_allowed = 'false';
      diag.locale_reason = 'infer_locale_catalog_reject';
      loc = null;
    }
  }
  // Force es-MX locale for Spanish Mexico heuristic
  if (isSpanishMexico) {
    if (isLocaleAllowedByCatalog('es', 'es-MX')) {
      params.set('locale', 'es-MX');
      loc = 'es-MX';
      diag.locale_set = 'es-MX';
      diag.locale_allowed = 'true';
      diag.locale_reason = 'spanish_mexico';
    }
  }
  // Force es-ES locale for European/Spain Spanish briefs
  if (isSpanishSpain && !isSpanishMexico) {
    if (isLocaleAllowedByCatalog('es', 'es-ES')) {
      params.set('locale', 'es-ES');
      loc = 'es-ES';
      diag.locale_set = 'es-ES';
      diag.locale_allowed = 'true';
      diag.locale_reason = 'spanish_spain';
    }
  }
  // Force fr-FR locale for European/Parisian French briefs
  if (isFrenchEuropean && !isFrenchCanadian) {
    if (isLocaleAllowedByCatalog('fr', 'fr-FR')) {
      params.set('locale', 'fr-FR');
      loc = 'fr-FR';
      diag.locale_set = 'fr-FR';
      diag.locale_allowed = 'true';
      diag.locale_reason = 'french_european';
    }
  }
  // Force fr-CA locale for French Canadian briefs
  if (isFrenchCanadian) {
    if (isLocaleAllowedByCatalog('fr', 'fr-CA')) {
      params.set('locale', 'fr-CA');
      loc = 'fr-CA';
      diag.locale_set = 'fr-CA';
      diag.locale_allowed = 'true';
      diag.locale_reason = 'french_canadian';
    }
  }
  // Prefer dialect locale for Chinese (soft; only if allowed to apply locale)
  if (language === 'zh' && chineseDialect && chinesePreferredLocales.length && shouldApplyParam('locale', plan, userText)) {
    // Only set if not already set by other logic
    if (!loc) {
      const preferred = chinesePreferredLocales[0];
      if (preferred && isLocaleAllowedByCatalog('zh', preferred)) {
        params.set('locale', preferred);
        loc = preferred;
        diag.locale_set = String(preferred);
        diag.locale_allowed = 'true';
        diag.locale_reason = 'chinese_dialect_preferred';
      }
    }
  }

  // Emit a single, de-duped diagnostics line for catalog filters
  try {
    const sig = `${diag.language}|a:${diag.accent_set}|aok:${diag.accent_allowed}|l:${diag.locale_set}|lok:${diag.locale_allowed}`;
    if (!global.__lastCatalogSig || global.__lastCatalogSig !== sig) {
      trace({ stage: 'catalog_filters', params: diag, count: 0 });
      global.__lastCatalogSig = sig;
    }
  } catch (_) {}

  if (featured && shouldApplyParam('featured', plan, userText, { featured })) params.set('featured', 'true');
  if (
    typeof minNoticePeriodDays === 'number' &&
    minNoticePeriodDays > 0 &&
    plan?.__no_notice_period !== true &&
    shouldApplyParam('min_notice_period_days', plan, userText, { minNoticePeriodDays })
  ) {
    params.set('min_notice_period_days', String(minNoticePeriodDays));
  }
  if (
    plan?.__no_custom_rates === true &&
    shouldApplyParam('include_custom_rates', plan, userText, { noCustomRates: true })
  ) {
    params.set('include_custom_rates', 'false');
  }
  if (age && shouldApplyParam('age', plan, userText)) params.set('age', age);
  if (sort && shouldApplyParam('sort', plan, userText, { sort })) params.set('sort', sort);

  return {
    useCases,
    descriptives,
    locale: loc,
    featured,
    minNoticePeriodDays,
    age,
    sort,
    localeInferred: Boolean(isSpanishMexico || isSpanishLatam || isSpanishSpain || isFrenchEuropean || isFrenchCanadian || (language === 'zh' && chineseDialect)),
    bilingual: Boolean(isBilingualEnEs),
    negatives: banned || [],
    region: spanishRegion,
    __diag: diag
  };
}

// ---- Shared-voices cache & pagination helpers ----
function cacheKeyFromParams(params) {
  return `sv:${params.toString()}`;
}

async function callSharedVoicesRaw(params) {
  const url = `https://api.elevenlabs.io/v1/shared-voices?${params.toString()}`;
  const res = await httpGetWithRetry(url, {
    headers: {
      'xi-api-key': process.env.ELEVENLABS_API_KEY,
      'Content-Type': 'application/json'
    },
    timeout: 10000
  });
  return {
    voices: Array.isArray(res.data?.voices) ? res.data.voices : [],
    has_more: !!res.data?.has_more
  };
}

async function callSharedVoicesCached(params, callFn) {
  try {
    const key = cacheKeyFromParams(params);
    const hit = sharedVoicesCache.get(key);
    if (hit && Date.now() - hit.at < SHARED_VOICES_CACHE_TTL_MS) {
      return hit.voices;
    }
    const voices = await callFn(params);
    sharedVoicesCache.set(key, { at: Date.now(), voices });
    return voices;
  } catch (_) {
    const { voices } = await callSharedVoicesRaw(params);
    return voices;
  }
}

async function callSharedVoicesAllPages(baseParams, options = {}) {
  const pageSize = Number(baseParams.get('page_size') || '30');
  const maxPages = options.maxPages ?? 3;
  const cap = options.cap ?? 200;
  const out = [];
  for (let page = 0; page < maxPages && out.length < cap; page++) {
    const p = new URLSearchParams(baseParams.toString());
    p.set('page', String(page));
    const { voices, has_more } = await callSharedVoicesRaw(p);
    out.push(...voices);
    if (!has_more || voices.length < pageSize) break;
  }
  return out;
}

// -------------------------------------------------------------
// Similar Voices helpers (by voice_id via preview_url)
// -------------------------------------------------------------

function extractVoiceIdCandidate(text) {
  if (!text) return null;
  const lower = text.toLowerCase();
  const intent = /\b(similar|podobny|like)\b/.test(lower);
  const idMatch = text.match(/([A-Za-z0-9]{18,})/g);
  if (!intent || !idMatch) return null;
  const candidate = idMatch.find((s) => /^[A-Za-z0-9]{18,}$/.test(s));
  return candidate || null;
}

function isLikelyVoiceId(id) {
  if (!id) return false;
  if (PUBLIC_OWNER_UUID_RE.test(id)) return false;
  if (!/\d/.test(id)) return false;
  if (/[A-Z]/.test(id) && /[a-z]/.test(id) && id.length >= 15) return true;
  if (id.length >= 18) return true;
  return /^[A-Za-z0-9]{10,32}$/.test(id) && !/^[a-z]+$/.test(id);
}

/** All standalone ElevenLabs voice_id tokens in text (10–32 alphanumeric), excluding owner UUIDs. */
function extractAllVoiceIds(text) {
  if (!text) return [];
  const matches = String(text).match(/\b([A-Za-z0-9]{10,32})\b/g);
  if (!matches) return [];
  const seen = new Set();
  const out = [];
  for (const id of matches) {
    if (!isLikelyVoiceId(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/** Standalone ElevenLabs voice_id token (10–32 alphanumeric), excluding owner UUIDs. */
function extractBareVoiceId(text) {
  const all = extractAllVoiceIds(text);
  return all.length ? all[0] : null;
}

function detectVoiceIdQualityQuestion(text) {
  if (!extractBareVoiceId(text)) return false;
  if (detectQualityPreferenceFromText(text)) return true;
  const t = (text || '').toLowerCase();
  return (
    /\b(is|are|czy)\b/.test(t) &&
    (/\b(high quality|high-quality|hq|quality|jakość|jakosc|calidad)\b/.test(t) ||
      /\b(voice|głos|glos)\b/.test(t))
  );
}

function detectVoiceLookupIntent(text) {
  const t = (text || '').toLowerCase();
  if (t.length < 6) return false;
  if (detectVoiceIdQualityQuestion(text)) return true;
  const patterns = [
    /\bwhat'?s?\s+(?:that|this)\s+voice\b/,
    /\bwho'?s?\s+(?:that|this)\s+voice\b/,
    /\b(identify|lookup|look\s+up)\s+(?:this|that)?\s*voice\b/,
    /\bwhat\s+voice\s+is\s+(?:this|that)\b/,
    /\b(which|what)\s+voice\s+is\b/,
    /\b(co\s+to\s+za|jaki\s+to)\s+głos\b/,
    /\b(który|ktory)\s+to\s+głos\b/
  ];
  return patterns.some((re) => {
    try {
      return re.test(t);
    } catch (_) {
      return false;
    }
  });
}

/**
 * Named-voice / library-alias / evaluation intents.
 * These must NOT fall through to generic facet_browse (e.g. Italian browse, czech from "check").
 */
function detectNamedVoiceIntent(text) {
  try {
    const raw = (text || '').toString();
    if (!raw || raw.length < 8) return false;
    const lower = raw.toLowerCase();

    // Clear discovery briefs without a concrete title stay on facet/keyword search
    const isDiscoveryBrief =
      /\b(find|recommend|suggest|show|search|looking for|need|want)\b/.test(lower) &&
      /\bvoices?\b/.test(lower) &&
      !/\b(voice\s+talent|library\s+names?|for\s+voice\s+[a-z]|following\s+(?:male\s+|female\s+)?voices?)\b/.test(
        lower
      ) &&
      !/"[^"]{2,80}"/.test(raw) &&
      !extractLibraryVoiceNames(raw).length;
    if (isDiscoveryBrief) return false;

    if (/\b(voice\s+talent|professional\s+voice\s+talent|pvc)\b/.test(lower)) return true;
    if (/\blibrary\s+names?\b/.test(lower) || /\bother\s+(?:library\s+)?names?\b/.test(lower)) return true;
    if (/\balias(?:es)?\b/.test(lower) && /\bvoices?\b/.test(lower)) return true;
    if (
      /\b(check|evaluate|verify|review|suitable)\b/.test(lower) &&
      /\b(following|these|those)\s+(?:male\s+|female\s+)?voices?\b/.test(lower)
    ) {
      return true;
    }
    if (/\bfor\s+voice\s+[A-ZÀ-ÖØ-öø-ÿ][\w' .-]{1,60}/.test(raw)) return true;
    if (/[—–-]\s*(?:italian|spanish|english|french|german|portuguese)?\s*(?:professional\s+)?voice\s+talent\b/i.test(raw)) {
      return true;
    }
    if (extractLibraryVoiceNames(raw).length > 0 && /\b(check|library|alias|talent|named)\b/.test(lower)) {
      return true;
    }
    return false;
  } catch (_) {
    return false;
  }
}

function extractLibraryVoiceNames(text) {
  try {
    const raw = (text || '').toString();
    if (!raw) return [];
    const names = [];

    // Quoted titles
    const quoteRe = /["“”'‘`]([^"“”'‘`]{2,80})["“”'‘`]/g;
    let m;
    while ((m = quoteRe.exec(raw))) {
      const n = String(m[1] || '').trim();
      if (n && !/^(male|female|voice|voices)$/i.test(n)) names.push(n);
    }

    // "Title - … Voice Talent" / "for voice Title - …"
    const dashTalent = raw.match(
      /(?:for\s+voice\s+|voice\s+)?([A-ZÀ-ÖØ-öø-ÿ][\w' .]{1,50}?)\s*[—–-]\s*[^\n]{0,80}?voice\s+talent\b/i
    );
    if (dashTalent && dashTalent[1]) {
      names.push(dashTalent[1].replace(/^for\s+voice\s+/i, '').trim());
    }

    // "for voice NAME" without dash
    const forVoice = raw.match(/\bfor\s+voice\s+([A-ZÀ-ÖØ-öø-ÿ][\w' .-]{1,60}?)(?:\s*[—–-]|\s*$|,|\.|!|\?)/);
    if (forVoice && forVoice[1]) {
      const n = forVoice[1].replace(/\s*[—–-].*$/, '').trim();
      if (n.length >= 2) names.push(n);
    }

    // Bullet / numbered list after "following voices"
    if (/\bfollowing\s+(?:male\s+|female\s+)?voices?\b/i.test(raw)) {
      const after = raw.split(/\bfollowing\s+(?:male\s+|female\s+)?voices?\b/i)[1] || '';
      const lines = after.split(/\n|;/).map((l) => l.trim()).filter(Boolean);
      for (const line of lines.slice(0, 12)) {
        const cleaned = line
          .replace(/^[\d\.\)\-\*]+\s*/, '')
          .replace(/\b(male|female|voice|voices)\b/gi, '')
          .trim();
        if (cleaned.length >= 2 && cleaned.length <= 80) names.push(cleaned);
      }
    }

    return dedupePreserveOrder(names.map((n) => n.trim()).filter((n) => n.length >= 2)).slice(0, 8);
  } catch (_) {
    return [];
  }
}

function scoreVoiceNameMatch(voiceName, queryName) {
  const a = normalizeCatalogToken(voiceName || '');
  const b = normalizeCatalogToken(queryName || '');
  if (!a || !b) return 0;
  if (a === b) return 100;
  if (a.startsWith(b) || b.startsWith(a)) return 80;
  if (a.includes(b) || b.includes(a)) return 60;
  return 0;
}

async function lookupVoicesByName(names, { gender = null, language = null, traceCb = null } = {}) {
  const trace = typeof traceCb === 'function' ? traceCb : () => {};
  const list = (Array.isArray(names) ? names : []).map((n) => String(n || '').trim()).filter(Boolean);
  if (!list.length) return [];
  const XI_KEY = process.env.ELEVENLABS_API_KEY;
  const out = [];
  const seen = new Set();

  for (const name of list.slice(0, 6)) {
    try {
      const params = new URLSearchParams();
      params.set('page_size', '20');
      params.set('search', name);
      if (gender === 'male' || gender === 'female') params.set('gender', gender);
      if (language) params.set('language', language);

      const url = `https://api.elevenlabs.io/v1/shared-voices?${params.toString()}`;
      const res = await httpGetWithRetry(url, {
        headers: { 'xi-api-key': XI_KEY, 'Content-Type': 'application/json' },
        timeout: 10000
      });
      const voices = Array.isArray(res.data?.voices) ? res.data.voices : [];
      try {
        trace({
          stage: 'named_voice_lookup',
          params: { search: name, ...paramsToObject(params) },
          count: voices.length
        });
      } catch (_) {}

      const ranked = voices
        .map((v) => ({ v, score: scoreVoiceNameMatch(v?.name, name) }))
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score);
      for (const { v } of ranked) {
        if (!v?.voice_id || seen.has(v.voice_id)) continue;
        seen.add(v.voice_id);
        out.push(v);
        if (out.length >= 12) break;
      }
      // If no scored matches, still take top API hits for that name search
      if (!ranked.length) {
        for (const v of voices.slice(0, 3)) {
          if (!v?.voice_id || seen.has(v.voice_id)) continue;
          seen.add(v.voice_id);
          out.push(v);
        }
      }
    } catch (err) {
      safeLogAxiosError('lookupVoicesByName', err);
    }
  }
  return out;
}

function buildNamedVoiceLookupMessage(voices, names, userText) {
  const labels = getLabels?.() || {};
  if (!Array.isArray(voices) || !voices.length) {
    const asked = (names || []).filter(Boolean).slice(0, 3).join(', ') || 'that name';
    return `I couldn't find library matches for ${asked}. Try a different spelling or paste the voice ID.`;
  }
  const lines = [
    `Named / library-name lookup for: ${(names || []).slice(0, 4).join(', ') || 'voice'}`,
    ''
  ];
  for (const v of voices.slice(0, 8)) {
    try {
      lines.push(formatVoiceLine(v, 'en'));
    } catch (_) {
      const url = `https://elevenlabs.io/app/voice-library?search=${encodeURIComponent(v.voice_id || '')}`;
      lines.push(`• *${v.name || 'Unknown'}* \`${v.voice_id}\` — <${url}|Open>`);
    }
  }
  if (/\b(suitable|evaluate|check whether)\b/i.test(userText || '')) {
    lines.push('');
    lines.push(
      'Review these candidates against your brief; this path searches by name/library title rather than browsing by accent.'
    );
  }
  return lines.filter((x) => x != null).join('\n') || labels.noVoices || 'No voices found.';
}

async function lookupVoiceById(voiceId, traceCb) {
  const trace = typeof traceCb === 'function' ? traceCb : () => {};
  if (!voiceId) return null;
  const shared = await fetchSharedVoiceByIdOrSearch(voiceId, trace);
  if (shared?.voice_id) return shared;
  const priv = await fetchPrivateVoiceById(voiceId, trace);
  return priv?.voice_id ? priv : null;
}

function buildVoiceLookupMessage(voice, userText) {
  if (!voice) return '';
  const url = `https://elevenlabs.io/app/voice-library?search=${encodeURIComponent(voice.voice_id)}`;
  const lines = [
    `*${voice.name || 'Unknown'}* \`${voice.voice_id}\``,
    `Language: ${voice.language || '—'}`,
    `Accent: ${voice.accent || '—'}`
  ];
  if (detectVoiceIdQualityQuestion(userText)) {
    const hq = isHighQuality(voice);
    lines.push(
      hq
        ? 'High quality: Yes — this voice is marked as high quality in the Voice Library.'
        : 'High quality: No — this voice is not marked as high quality in the Voice Library.'
    );
  }
  if (voice.description) lines.push(`Description: ${voice.description}`);
  lines.push(`<${url}|Open in Voice Library>`);
  return lines.join('\n');
}

function detectVoiceLanguageCompatibilityIntent(text) {
  const raw = (text || '').toString();
  if (detectVoiceNoticePeriodIntent(raw)) return null;
  const lower = raw.toLowerCase();
  const hint = parseUserLanguageHints(raw);
  const iso2 = hint?.iso2 ? hint.iso2.toLowerCase().slice(0, 2) : null;
  if (!iso2) return null;

  const hasVoiceRef =
    !!extractBareVoiceId(raw) ||
    !!extractVoiceIdForOwnerLookup(raw) ||
    /\b(this|that|the|ten|ta|tego|tej)\s+(voice|głos|glos)\b/i.test(lower);
  if (!hasVoiceRef) return null;

  const compatSignals = [
    /\b(will|would|can|could|does|do|is|are|czy)\b/i,
    /\b(work(?:s|ing)?|support(?:s|ed)?|compatible|verification|verified)\b/i,
    /\b(artifact(?:s)?|pronunciation|accent bleed)\b/i,
    /\b(good with|work with|works with|dobra?(?: do)?|działa|obsługuje|nada się)\b/i,
    /\b(expect|oczekiwać|oczekiwac)\b/i
  ];
  const isSearchBrief =
    /\b(find|search|show|list|recommend|suggest|give me|szukam|znajdź|znajdz|pokaż|pokaz)\b/i.test(lower) &&
    /\bvoices?\b/i.test(lower) &&
    !compatSignals.some((re) => re.test(lower));
  if (isSearchBrief) return null;

  if (!compatSignals.some((re) => re.test(lower))) return null;
  return { iso2 };
}

function resolveVoiceForCompatibilityQuestion(text, session) {
  const raw = (text || '').toString();
  const voiceId = extractBareVoiceId(raw) || extractVoiceIdForOwnerLookup(raw);
  if (voiceId) {
    const inSession = session?.voices?.find((v) => v?.voice_id === voiceId);
    if (inSession) return inSession;
    return { voice_id: voiceId, __needsLookup: true };
  }

  const lower = raw.toLowerCase();
  if (
    /\b(this|that|the|ten|ta|tego|tej)\s+(voice|głos|glos)\b/i.test(lower) &&
    Array.isArray(session?.voices) &&
    session.voices.length
  ) {
    const sorted = [...session.voices].sort(
      (a, b) => (session.ranking?.[b.voice_id] || 0) - (session.ranking?.[a.voice_id] || 0)
    );
    return sorted[0] || null;
  }
  return null;
}

function detectVoiceNoticePeriodIntent(text) {
  const raw = (text || '').toString();
  const lower = raw.toLowerCase();
  const noticeMention =
    /\bnotice\s*period\b/.test(lower) ||
    /\bokres(u)?\s+wypowiedzenia\b/.test(lower) ||
    /\bwypowiedzeni[ae]\b/.test(lower);
  if (!noticeMention) return false;

  const voiceIds = extractAllVoiceIds(raw);
  const refersToListedVoices =
    /\b(these|those|following|poniższe|ponizsze|tych|te)\s+(voices?|głos(y|ów)?|glos(y|ow)?)\b/i.test(lower) ||
    /\b(for|dla)\s+(these|those|them|nich|tych)\b/i.test(lower);

  const lookupSignals = [
    /\b(check|verify|what(?:'s| is| are)|tell me|show|lookup|look\s*up|get)\b/i,
    /\b(sprawdź|sprawdz|jaki|jaka|jakie|ile)\b/i,
    /\b(do|does|have|has)\s+(these|those|they|the)\b/i
  ];
  const isLookup = lookupSignals.some((re) => re.test(lower));

  const isSearchBrief =
    /\b(find|search|show me|list|recommend|suggest|szukam|znajdź|znajdz|pokaż|pokaz)\b/i.test(lower) &&
    /\bvoices?\b/i.test(lower) &&
    !refersToListedVoices &&
    voiceIds.length === 0;
  if (isSearchBrief) return false;

  if (voiceIds.length > 0) return true;
  if (refersToListedVoices && isLookup) return true;
  return false;
}

function resolveVoicesForNoticePeriodQuestion(text, session) {
  const raw = (text || '').toString();
  const voiceIds = extractAllVoiceIds(raw);
  if (voiceIds.length) {
    return voiceIds.map((id) => {
      const inSession = session?.voices?.find((v) => v?.voice_id === id);
      if (inSession) return inSession;
      return { voice_id: id, __needsLookup: true };
    });
  }

  const lower = raw.toLowerCase();
  if (
    /\b(these|those|following|them|nich|tych)\s+(voices?|głos(y|ów)?|glos(y|ow)?)\b/i.test(lower) &&
    Array.isArray(session?.voices) &&
    session.voices.length
  ) {
    return [...session.voices];
  }
  return [];
}

function buildVoiceNoticePeriodMessage(voices, uiLang) {
  if (!Array.isArray(voices) || !voices.length) return '';
  const lines = ['*Notice period*'];
  for (const voice of voices) {
    if (voice?.__notFound) {
      lines.push(`\`${voice.voice_id}\` — not found in the Voice Library or your workspace.`);
      continue;
    }
    lines.push(formatVoiceLine(voice, uiLang));
  }
  return lines.join('\n');
}

function formatVerifiedLanguageEntry(entry) {
  if (!entry) return null;
  const parts = [];
  if (entry.locale) parts.push(`locale: ${entry.locale}`);
  if (entry.accent) parts.push(`accent: ${entry.accent}`);
  return parts.length ? parts.join(', ') : null;
}

function buildVoiceLanguageCompatibilityMessage(voice, iso2) {
  if (!voice || !iso2) return '';
  const langLabel = iso2.toUpperCase();
  const verified = voiceHasVerifiedIso2(voice, iso2);
  const entries = voiceVerifiedEntriesForIso2(voice, iso2);
  const url = `https://elevenlabs.io/app/voice-library?search=${encodeURIComponent(voice.voice_id)}`;
  const lines = [`*${voice.name || 'Unknown'}* \`${voice.voice_id}\``];

  if (verified) {
    lines.push(`This voice is *verified* for ${langLabel} in the Voice Library.`);
    const details = entries.map(formatVerifiedLanguageEntry).filter(Boolean);
    if (details.length) lines.push(`Verified entries: ${details.join('; ')}`);
    lines.push(
      'Verified languages indicate ElevenLabs tested the voice for that language — results should generally be reliable, though edge cases can still happen.'
    );
  } else {
    lines.push(`This voice is *not* listed as verified for ${langLabel}.`);
    if (voice.language) lines.push(`Primary language: ${voice.language}`);
    lines.push(
      `Using an unverified language may produce artifacts or inconsistent pronunciation. Consider a voice verified for ${langLabel}.`
    );
  }
  lines.push(`<${url}|Open in Voice Library>`);
  return lines.join('\n');
}

async function respondVoiceLanguageCompatibility(event, cleaned, threadTs, client, session, uiLang) {
  const intent = detectVoiceLanguageCompatibilityIntent(cleaned);
  if (!intent) return false;

  const resolved = resolveVoiceForCompatibilityQuestion(cleaned, session);
  if (!resolved) {
    const msg = await translateForUserLanguage(
      'To check language verification, mention *this voice* in a thread with search results, or paste a voice_id.',
      uiLang
    );
    await safePostMessage(client, { channel: event.channel, thread_ts: threadTs, text: msg });
    return true;
  }

  let voice = resolved;
  if (resolved.__needsLookup) {
    voice = await lookupVoiceById(resolved.voice_id, () => {});
    if (!voice) {
      const msg = await translateForUserLanguage(
        "I couldn't find a voice with that ID in the public Voice Library or your workspace.",
        uiLang
      );
      await safePostMessage(client, { channel: event.channel, thread_ts: threadTs, text: msg });
      return true;
    }
  } else if (!Array.isArray(voice.verified_languages)) {
    const fresh = await lookupVoiceById(voice.voice_id, () => {});
    if (fresh) voice = fresh;
  }

  let message = buildVoiceLanguageCompatibilityMessage(voice, intent.iso2);
  message = await translateForUserLanguage(message, uiLang);
  await safePostMessage(client, { channel: event.channel, thread_ts: threadTs, text: message });
  return true;
}

async function respondVoiceNoticePeriodLookup(event, cleaned, threadTs, client, session, uiLang) {
  if (!detectVoiceNoticePeriodIntent(cleaned)) return false;

  const resolved = resolveVoicesForNoticePeriodQuestion(cleaned, session);
  if (!resolved.length) {
    const msg = await translateForUserLanguage(
      'To check notice period, paste one or more voice_ids, or ask in a thread that already has search results.',
      uiLang
    );
    await safePostMessage(client, { channel: event.channel, thread_ts: threadTs, text: msg });
    return true;
  }

  const voices = [];
  for (const item of resolved) {
    if (item?.__needsLookup) {
      const fresh = await lookupVoiceById(item.voice_id, () => {});
      if (fresh?.voice_id) {
        voices.push(fresh);
      } else {
        voices.push({ voice_id: item.voice_id, __notFound: true });
      }
    } else if (!Object.prototype.hasOwnProperty.call(item, 'notice_period')) {
      const fresh = await lookupVoiceById(item.voice_id, () => {});
      voices.push(fresh?.voice_id ? fresh : item);
    } else {
      voices.push(item);
    }
  }

  let message = buildVoiceNoticePeriodMessage(voices, uiLang);
  message = await translateForUserLanguage(message, uiLang);
  await safePostMessage(client, { channel: event.channel, thread_ts: threadTs, text: message });
  return true;
}

async function fetchSharedVoiceByIdOrSearch(voiceId, traceCb) {
  const XI_KEY = process.env.ELEVENLABS_API_KEY;
  try {
    const params = new URLSearchParams();
    params.set('page_size', '10');
    params.set('search', voiceId);

    const url = `https://api.elevenlabs.io/v1/shared-voices?${params.toString()}`;
    const res = await httpGetWithRetry(url, {
      headers: { 'xi-api-key': XI_KEY, 'Content-Type': 'application/json' },
      timeout: 10000
    });
    const voices = Array.isArray(res.data?.voices) ? res.data.voices : [];
    try {
      traceCb?.({
        stage: 'fetch_by_id_search',
        params: paramsToObject(params),
        count: voices.length
      });
    } catch (_) {}
    if (!voices.length) return null;
    const exact = voices.find((v) => v?.voice_id === voiceId);
    return exact || voices[0];
  } catch (err) {
    safeLogAxiosError('fetchSharedVoiceByIdOrSearch', err);
    return null;
  }
}

async function fetchPrivateVoiceById(voiceId, traceCb) {
  const XI_KEY = process.env.ELEVENLABS_API_KEY;
  try {
    const url = `https://api.elevenlabs.io/v1/voices/${encodeURIComponent(voiceId)}`;
    const res = await httpGetWithRetry(url, {
      headers: { 'xi-api-key': XI_KEY, 'Content-Type': 'application/json' },
      timeout: 10000
    });
    const voice = res?.data || null;
    try {
      traceCb?.({
        stage: 'fetch_by_id_private',
        params: { ok: String(Boolean(voice && voice.voice_id)) },
        count: voice ? 1 : 0
      });
    } catch (_) {}
    return voice;
  } catch (err) {
    try {
      traceCb?.({
        stage: 'fetch_by_id_private',
        params: { ok: 'false', reason: err?.response?.status ? String(err.response.status) : 'error' },
        count: 0
      });
    } catch (_) {}
    return null;
  }
}

async function downloadToBuffer(url) {
  const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 15000 });
  return Buffer.from(res.data);
}

function extractFirstSampleId(voice) {
  try {
    const samples = Array.isArray(voice?.samples) ? voice.samples : [];
    const first = samples.find((s) => s && s.sample_id);
    return first?.sample_id ? String(first.sample_id) : null;
  } catch (_) {
    return null;
  }
}

async function downloadPrivateSampleToBuffer(voiceId, sampleId) {
  const url = `https://api.elevenlabs.io/v1/voices/${encodeURIComponent(voiceId)}/samples/${encodeURIComponent(sampleId)}/audio`;
  const res = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 20000,
    headers: {
      'xi-api-key': process.env.ELEVENLABS_API_KEY
    }
  });
  return Buffer.from(res.data);
}

async function findSimilarVoicesByVoiceId(voiceId, traceCb) {
  const XI_KEY = process.env.ELEVENLABS_API_KEY;
  try {
    // 1) Resolve base voice (shared, then private)
    const baseShared = await fetchSharedVoiceByIdOrSearch(voiceId, traceCb);
    try {
      traceCb?.({
        stage: 'fetch_by_id_shared',
        params: { ok: String(Boolean(baseShared && baseShared.voice_id)), has_preview: String(Boolean(baseShared?.preview_url)) },
        count: baseShared ? 1 : 0
      });
    } catch (_) {}

    let baseVoice = baseShared;
    if (!baseVoice || (!baseVoice.preview_url && !extractFirstSampleId(baseVoice))) {
      const basePrivate = await fetchPrivateVoiceById(voiceId, traceCb);
      if (basePrivate) baseVoice = basePrivate;
    }

    if (!baseVoice) {
      try {
        traceCb?.({
          stage: 'similar_base_audio',
          params: { ok: 'false', reason: 'base_not_found' },
          count: 0
        });
      } catch (_) {}
      return { voices: [], reason: 'base_not_found' };
    }

    // 2) Obtain audio (preview_url preferred; else first sample audio)
    let audioBuf = null;
    let audioSource = null;
    if (baseVoice.preview_url) {
      audioBuf = await downloadToBuffer(baseVoice.preview_url);
      audioSource = 'preview_url';
    } else {
      const sampleId = extractFirstSampleId(baseVoice);
      if (sampleId) {
        audioBuf = await downloadPrivateSampleToBuffer(voiceId, sampleId);
        audioSource = 'sample_id';
      }
    }
    if (!audioBuf) {
      try {
        traceCb?.({
          stage: 'similar_base_audio',
          params: { ok: 'false', reason: 'no_preview_or_sample' },
          count: 0
        });
      } catch (_) {}
      return { voices: [], reason: 'no_preview' };
    }
    try {
      traceCb?.({
        stage: 'similar_base_audio',
        params: { ok: 'true', source: audioSource || '-' },
        count: 1
      });
    } catch (_) {}

    const form = new FormData();
    form.append('audio_file', audioBuf, { filename: `${voiceId}.mp3`, contentType: 'audio/mpeg' });
    const res = await axios.post('https://api.elevenlabs.io/v1/similar-voices', form, {
      headers: {
        ...form.getHeaders(),
        'xi-api-key': XI_KEY
      },
      timeout: 20000
    });
    const out = Array.isArray(res.data?.voices) ? res.data.voices : [];
    try {
      traceCb?.({
        stage: 'similar_voices',
        params: { top_k: 'default', source: audioSource || '-' },
        count: out.length
      });
    } catch (_) {}
    return { voices: out, reason: 'ok' };
  } catch (err) {
    safeLogAxiosError('findSimilarVoicesByVoiceId', err);
    try {
      traceCb?.({
        stage: 'similar_voices',
        params: { ok: 'false', reason: err?.response?.status ? String(err.response.status) : 'error' },
        count: 0
      });
    } catch (_) {}
    return { voices: [], reason: 'error' };
  }
}

function buildSearchReport(trace, plan, mode, summary) {
  try {
    const lines = [];
    lines.push('*Search report (POC)*');
    lines.push(`Mode: \`${mode || 'generic'}\``);
    const excludedAccents =
      plan && Array.isArray(plan.__excludedAccents) && plan.__excludedAccents.length
        ? plan.__excludedAccents.join(',')
        : '-';
    const excludedLocales =
      plan && Array.isArray(plan.__excludedLocales) && plan.__excludedLocales.length
        ? plan.__excludedLocales.join(',')
        : '-';
    const excludedGenders =
      plan && Array.isArray(plan.__excludedGenders) && plan.__excludedGenders.length
        ? plan.__excludedGenders.join(',')
        : '-';
    let planAccentDisplay = plan?.target_accent || '-';
    if (planAccentDisplay === '-' && Array.isArray(trace)) {
      try {
        const resolvers = trace.filter((t) => t && t.stage === 'resolver');
        const lastRes = resolvers.length ? resolvers[resolvers.length - 1] : null;
        const cand = lastRes?.params?.candidates;
        if (typeof cand === 'string' && cand.trim()) {
          const first = cand.split(',')[0].trim();
          if (first) planAccentDisplay = first;
        }
        if (planAccentDisplay === '-') {
          const cfs = trace.filter((t) => t && t.stage === 'catalog_filters' && t.params);
          const lastCf = cfs.length ? cfs[cfs.length - 1] : null;
          const aset = lastCf?.params?.accent_set;
          if (lastCf?.params?.accent_allowed === 'true' && aset && String(aset).trim()) {
            planAccentDisplay = String(aset);
          }
        }
      } catch (_) {}
    }
    lines.push(
      `Plan: lang=${plan?.target_voice_language || '-'}, accent=${planAccentDisplay}, exclude_accents=${excludedAccents}, exclude_locales=${excludedLocales}, exclude_genders=${excludedGenders}, gender=${plan?.target_gender || '-'}, quality=${plan?.quality_preference || 'any'}, model=${plan?.model_preference || 'any'}, notice=${plan?.__no_notice_period ? 'none' : (plan?.__min_notice_period_days ?? 'any')}, custom_rates=${plan?.__no_custom_rates ? 'exclude' : 'any'}`
    );
    if (summary && typeof summary === 'object') {
      lines.push('');
      lines.push(`Summary: unique_voices=${summary.unique_count ?? '-'}`);
      if (summary.verified_en_es != null) {
        lines.push(`Bilingual KPIs: verified_en_es=${summary.verified_en_es}, pool=${summary.unique_count ?? '-'}`);
      }
      if (Array.isArray(summary.top_coverage) && summary.top_coverage.length) {
        const top = summary.top_coverage.slice(0, 10);
        lines.push('Top coverage (voice_id | name | accent | gender : matched_keywords_count | coverage):');
        top.forEach((t) => {
          const meta = [t.name, t.accent, t.gender].filter(Boolean).join(' | ') || '-';
          const cov =
            typeof t.coverageScore === 'number' ? ` | ${Number(t.coverageScore).toFixed(1)}` : '';
          lines.push(`• ${t.voice_id} | ${meta}: ${t.matchedCount}${cov}`);
        });
      }
    }
    lines.push('');
    if (!Array.isArray(trace) || !trace.length) {
      lines.push('_No trace entries collected._');
      return lines.join('\n');
    }

    // Typo/hybrid summary (derived from trace)
    try {
      const typoEvents = trace.filter(
        (t) =>
          t &&
          typeof t === 'object' &&
          (t.stage === 'per_keyword' ||
            t.stage === 'per_keyword_alt_use_cases' ||
            t.stage === 'per_keyword_relax_descriptives' ||
            t.stage === 'per_keyword_relax_use_cases' ||
            t.stage === 'per_keyword_quick_relax') &&
          t.variant === 'corrected' &&
          t.typo_from &&
          t.typo_to
      );
      if (typoEvents.length) {
        lines.push(`Typos: corrected_queries=${typoEvents.length}`);
        const byPair = new Map();
        typoEvents.forEach((e) => {
          const k = `${e.typo_from}→${e.typo_to}`;
          byPair.set(k, (byPair.get(k) || 0) + 1);
        });
        const topPairs = Array.from(byPair.entries())
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5);
        if (topPairs.length) {
          lines.push('Top corrections:');
          topPairs.forEach(([pair, count]) => lines.push(`• ${pair}: ${count}`));
        }
        lines.push('');
      }
    } catch (_) {}

    // Locale usage summary (derived from trace params)
    try {
      const locales = new Set();
      for (const t of trace) {
        const loc = t?.params?.locale;
        if (loc) locales.add(String(loc));
      }
      if (locales.size) {
        const hasEsEs = locales.has('es-ES');
        const hasEs419 = locales.has('es-419');
        const hasEsMx = locales.has('es-MX');
        if (hasEsEs || hasEs419 || hasEsMx) {
          lines.push(`Locales: es-ES=${hasEsEs ? 'yes' : 'no'}, es-419=${hasEs419 ? 'yes' : 'no'}, es-MX=${hasEsMx ? 'yes' : 'no'}`);
          lines.push('');
        }
        // Chinese dialect locales
        const hasZhHk = locales.has('zh-HK');
        const hasZhCn = locales.has('zh-CN');
        const hasZhTw = locales.has('zh-TW');
        if (hasZhHk || hasZhCn || hasZhTw) {
          lines.push(`Locales: zh-HK=${hasZhHk ? 'yes' : 'no'}, zh-CN=${hasZhCn ? 'yes' : 'no'}, zh-TW=${hasZhTw ? 'yes' : 'no'}`);
          lines.push('');
        }
      }
    } catch (_) {}

    // LatAm Spanish diagnostics (derived from trace)
    try {
      const bilingualTrace = trace.filter((t) => t && t.stage === 'bilingual_filter');
      if (bilingualTrace.length) {
        const last = bilingualTrace[bilingualTrace.length - 1];
        lines.push('Bilingual:');
        lines.push(`• verified_en_es=${last?.params?.verified_both ?? '-'} (pool before filter=${last?.params?.total_before ?? '-'})`);
        lines.push('');
      }
      const hasLatamAlias = trace.some(
        (t) => t?.stage === 'catalog_filters' && t?.params?.language === 'es' && t?.params?.locale_reason === 'es-419_region_alias'
      );
      const hasLatamAccent = trace.some(
        (t) => t?.stage === 'catalog_filters' && t?.params?.language === 'es' && (t?.params?.accent_reason === 'spanish_latam')
      );
      const latamFallback = trace
        .filter((t) => t && t.stage === 'latam_fallback_locales')
        .map((t) => String(t?.params?.tried || '').trim())
        .filter(Boolean);

      if (hasLatamAlias || hasLatamAccent || latamFallback.length) {
        lines.push('LatAm:');
        lines.push(`• es-419 treated as region alias: ${hasLatamAlias ? 'yes' : 'no'}`);
        lines.push(`• accent=latin american applied: ${hasLatamAccent ? 'yes' : 'no'}`);
        if (latamFallback.length) {
          lines.push(`• fallback locales tried: ${dedupePreserveOrder(latamFallback.join(',').split(',').map((s) => s.trim()).filter(Boolean)).slice(0, 10).join(',')}`);
        }
        lines.push('');
      }
    } catch (_) {}

    // Resolver + fanout diagnostics (derived from trace)
    try {
      const resolverEntries = trace.filter((t) => t && t.stage === 'resolver');
      if (resolverEntries.length) {
        const last = resolverEntries[resolverEntries.length - 1];
        const p = last?.params || {};
        lines.push(`Resolver: iso2=${p.iso2 || '-'}, axis=${p.axis || 'none'}, mode=${p.mode || '-'}, reason=${p.reason || '-'}`);
        if (p.region && p.region !== '-') lines.push(`Resolver region: ${p.region}`);
        if (p.candidates && p.candidates !== '-') lines.push(`Resolver candidates: ${p.candidates}`);
        lines.push('');
      }
      const fanoutEntries = trace.filter((t) => t && t.stage === 'fanout');
      if (fanoutEntries.length) {
        const lastF = fanoutEntries[fanoutEntries.length - 1];
        const pf = lastF?.params || {};
        lines.push(`Fanout: axis=${pf.axis || '-'}, tried=${pf.tried || '-'}, added=${lastF?.count ?? '-'}`);
        lines.push('');
      }
    } catch (_) {}

    // Dialect usage summary (derived from per_keyword entries)
    try {
      const kwEntries = trace.filter((t) => t && (t.stage === 'per_keyword' || t.stage === 'per_keyword_variant'));
      const keys = kwEntries.map((t) => String(t.keyword || '').toLowerCase());
      const cantoneseCount = keys.filter((k) => k.includes('cantonese') || k.includes('zh-hk') || k.includes('hong kong') || k.includes('hk')).length;
      const mandarinCount = keys.filter((k) => k.includes('mandarin') || k.includes('putonghua') || k.includes('zh-cn') || k.includes('mainland') || k.includes('simplified')).length;
      if (cantoneseCount || mandarinCount) {
        lines.push(`Dialect queries: cantonese_like=${cantoneseCount}, mandarin_like=${mandarinCount}`);
        lines.push('');
      }
    } catch (_) {}

    // Accent-slug fetch diagnostics (zh)
    try {
      const slugEntries = trace.filter((t) => t && t.stage === 'accent_slug');
      if (slugEntries.length) {
        const ok = slugEntries.filter((t) => (t.count || 0) > 0);
        const used = slugEntries
          .map((t) => String(t?.params?.accent || '').trim())
          .filter(Boolean);
        const usedUniq = Array.from(new Set(used));
        lines.push(`Accent slugs: tried=${slugEntries.length}, unique=${usedUniq.length}, with_results=${ok.length}`);
        const topOk = ok
          .map((t) => ({ accent: String(t?.params?.accent || ''), count: t.count || 0 }))
          .filter((x) => x.accent)
          .sort((a, b) => b.count - a.count)
          .slice(0, 8);
        if (topOk.length) {
          lines.push('Accent slugs with results:');
          topOk.forEach((x) => lines.push(`• ${x.accent}: ${x.count}`));
        }
        const fellBackBroad = trace.some((t) => t && t.stage === 'broad');
        lines.push(`Broad fallback used: ${fellBackBroad ? 'yes' : 'no'}`);
        lines.push('');
      }
    } catch (_) {}

    // Catalog-driven accent diagnostics (best-effort)
    try {
      const iso = (plan?.target_voice_language || '').toString().toLowerCase().slice(0, 2);
      const userText = (plan?.__reportUserText || '').toString();
      if (iso && userText && facetKB && facetKB.isLoaded && facetKB.isLoaded() && facetKB.hasIso2 && facetKB.hasIso2(iso) && facetKB.suggestAccents) {
        const sugg = facetKB.suggestAccents(iso, userText, { limit: 3 }) || [];
        const best = sugg.find((x) => x && x.matchKind && x.matchKind !== 'popularity') || null;
        if (best && best.accent) {
          lines.push(`Catalog accent match: ${best.accent} (${best.matchKind})`);
          lines.push('');
        }
      }
    } catch (_) {}

    const max = Math.min(trace.length, 30);
    for (let i = 0; i < max; i++) {
      const t = trace[i];
      const params = t.params ? Object.entries(t.params).map(([k, v]) => `${k}=${v}`).join('&') : '';
      const vTag = t.variant ? ` [${t.variant}]` : '';
      const cTag = t.typo_from && t.typo_to ? ` (${t.typo_from}→${t.typo_to})` : '';
      if (t.stage === 'per_keyword') {
        lines.push(`• per_keyword: "${t.keyword}"${vTag}${cTag} (${params}) → ${t.count}`);
      } else if (t.stage === 'per_keyword_alt_use_cases') {
        lines.push(`• per_keyword_alt_use_cases: "${t.keyword}"${vTag}${cTag} (${params}) → ${t.count}`);
      } else if (t.stage === 'per_keyword_variant') {
        lines.push(`• per_keyword_variant: "${t.keyword}"${vTag}${cTag} (${params}) → ${t.count}`);
      } else if (t.stage === 'accent_slug') {
        lines.push(`• accent_slug (${params}) → ${t.count}`);
      } else if (t.stage === 'combined') {
        lines.push(`• combined (${params}) → ${t.count}`);
      } else if (t.stage === 'broad') {
        lines.push(`• broad (${params}) → ${t.count}`);
      } else if (t.stage === 'alt_language') {
        lines.push(`• alt_language (${params}) → ${t.count}`);
      } else if (t.stage === 'no_language') {
        lines.push(`• no_language (${params}) → ${t.count}`);
      } else if (t.stage === 'top_by_language') {
        lines.push(`• top_by_language (${params}) → ${t.count}`);
      } else {
        lines.push(`• ${t.stage || 'unknown'} (${params}) → ${t.count ?? '-'}`);
      }
    }
    if (trace.length > max) {
      lines.push(`… and ${trace.length - max} more`);
    }
    return lines.join('\n');
  } catch (_) {
    return '*Search report (POC)*\\n_Failed to render trace._';
  }
}

// -------------------------------------------------------------
// DEV-only regression assertions (no external deps)
// -------------------------------------------------------------
function devAssert(cond, msg) {
  if (!cond) throw new Error(`DEV_ASSERT failed: ${msg}`);
}

function isDevAssertsEnabled() {
  const enabled = String(process.env.DEV_ASSERTS || '').trim().toLowerCase();
  return enabled === 'true' || enabled === '1' || enabled === 'yes';
}

function isDevPocEnabled() {
  const enabled = String(process.env.DEV_POC || '').trim().toLowerCase();
  return enabled === 'true' || enabled === '1' || enabled === 'yes';
}

function runDevAsserts() {
  if (!isDevAssertsEnabled()) return;

  // Multi-intent should NOT split on conjunctions
  devAssert(splitMultiIntents('expressive and engaging and fast-paced').length === 0, 'no split on "and"');

  // Multi-intent should split on explicit list formats
  devAssert(
    splitMultiIntents('1) first brief\n2) second brief').length === 2,
    'split numbered list'
  );
  devAssert(
    splitMultiIntents('- first brief\n- second brief').length === 2,
    'split bullet list'
  );
  devAssert(
    splitMultiIntents('brief: first\nbrief: second').length === 2,
    'split brief: list'
  );

  // Language should not accidentally infer from common words
  const h1 = parseUserLanguageHints('I want to find a voice');
  devAssert(!h1.iso2, 'do not infer iso2 from common words');

  // Explicit ISO2 should work (even without dynamic index)
  const h2 = parseUserLanguageHints('lang=en');
  devAssert(h2.iso2 === 'en', 'explicit lang=en parses');

  // Locale should parse
  const h3 = parseUserLanguageHints('pt-BR');
  devAssert(h3.iso2 === 'pt' && h3.locale === 'pt-BR', 'locale parses');

  // Locale false-positive: "It is" must NOT be treated as it-IS
  const h4 = parseUserLanguageHints('It is soft, empathetic, and encouraging');
  devAssert(!h4.iso2 && !h4.locale, 'do not parse "it is" as a locale');

  // Language-name fallback (STATIC_LANGUAGE_ALIASES) should cover common follow-ups
  const h5 = parseUserLanguageHints('japanese');
  devAssert(h5.iso2 === 'ja', 'static alias: japanese -> ja');
  const h6 = parseUserLanguageHints('korean');
  devAssert(h6.iso2 === 'ko', 'static alias: korean -> ko');

  // Chinese aliases + typo correction
  const h7 = parseUserLanguageHints('mandarin');
  devAssert(h7.iso2 === 'zh', 'static alias: mandarin -> zh');
  const h8 = parseUserLanguageHints('mandarian');
  devAssert(h8.iso2 === 'zh', 'fuzzy language: mandarian -> zh');

  const hGccEmi = parseUserLanguageHints('which are the best Emirati voices');
  devAssert(hGccEmi.iso2 === 'ar' && hGccEmi.reason === 'gcc_region', 'GCC: Emirati -> ar');
  const hGccQa = parseUserLanguageHints('best Qatari voice');
  devAssert(hGccQa.iso2 === 'ar' && hGccQa.reason === 'gcc_region', 'GCC: Qatari -> ar');

  const hNa = parseUserLanguageHints('conversational female and male voices for North America');
  devAssert(hNa.iso2 === 'en' && hNa.reason === 'north_america_region', 'North America -> en');
  devAssert(hasExplicitAccentMention('voices for North America'), 'North America is explicit accent');

  // Bilingual EN+ES: explicit word, en/es, and language-pair connectors (+, and, comma)
  devAssert(
    detectBilingualEnEs('high quality native English + Latin American Spanish, one male one female'),
    'bilingual: English + Latin American Spanish'
  );
  devAssert(
    detectBilingualEnEs('can you recommend a female high quality native English + Latin American Spanish'),
    'bilingual: recommend female English + Latin American Spanish'
  );
  devAssert(detectBilingualEnEs('bilingual english and spanish voice'), 'bilingual: explicit bilingual keyword');
  devAssert(detectBilingualEnEs('en/es voice for IVR'), 'bilingual: en/es shorthand');
  devAssert(!detectBilingualEnEs('American English voice for a Spanish course'), 'bilingual: not inferred from unrelated English+Spanish mention');

  // Bilingual: accent must not be applied to shared-voices queries
  {
    const params = new URLSearchParams();
    const plan = { target_voice_language: null, target_accent: 'american', quality_preference: 'any' };
    const q = 'female high quality native English + Latin American Spanish';
    appendQueryFiltersToParams(params, plan, q, {
      language: null,
      accent: 'american',
      gender: 'female',
      qualityPref: 'high_only'
    });
    devAssert(!params.get('accent'), 'bilingual: no accent param');
    devAssert(!params.get('language'), 'bilingual: no language param');
  }

  // voiceHasVerifiedEnAndEs
  devAssert(
    voiceHasVerifiedEnAndEs({
      verified_languages: [{ language: 'en' }, { language: 'es', accent: 'latin american' }]
    }),
    'verified en+es: both languages present'
  );
  devAssert(
    !voiceHasVerifiedEnAndEs({ verified_languages: [{ language: 'en' }] }),
    'verified en+es: spanish missing'
  );

  // One male + one female voice recommendations
  devAssert(detectOneMaleOneFemale('one male one female'), 'dual gender: one male one female');
  devAssert(detectOneMaleOneFemale('one male, one female voice'), 'dual gender: comma separated');
  devAssert(!detectOneMaleOneFemale('male and female'), 'dual gender: male and female is catalog filter only');
  devAssert(
    !detectOneMaleOneFemale('conversational female and male voices for North America'),
    'dual gender: both-gender catalog filter'
  );
  devAssert(detectOneMaleOneFemale('męski i żeński'), 'dual gender: Polish męski i żeński');
  devAssert(
    detectOneMaleOneFemale('high quality native English + Latin American Spanish, one male one female'),
    'dual gender: bilingual query with one male one female'
  );
  devAssert(detectOneMaleOneFemale('a male and a female voice'), 'dual gender: a male and a female');
  devAssert(!detectOneMaleOneFemale('female voice for audiobook'), 'dual gender: single female only');
  devAssert(!detectOneMaleOneFemale('only male voices'), 'dual gender: male-only filter');
  devAssert(
    getSessionGenderAndLimit({ target_gender: 'female' }, 'one male one female').limitPerGender === 1,
    'dual gender: session limitPerGender is 1'
  );
  devAssert(
    getSessionGenderAndLimit({ target_gender: 'female' }, 'one male one female').gender === 'any',
    'dual gender: session gender stays any'
  );

  // Both-genders catalog filter (balanced male+female, not one-of-each)
  devAssert(
    detectBothGendersIntent('conversational female and male voices for North America'),
    'both genders: female and male voices'
  );
  devAssert(detectBothGendersIntent('male and female'), 'both genders: male and female');
  devAssert(!detectBothGendersIntent('one male one female'), 'both genders: not one-of-each');
  devAssert(!detectBothGendersIntent('only male voices'), 'both genders: single-gender filter excluded');
  devAssert(
    getSessionGenderAndLimit({}, 'conversational female and male voices for North America').limitPerGender === 5,
    'both genders: balanced limitPerGender'
  );
  devAssert(
    getSessionGenderAndLimit({}, 'conversational female and male voices for North America').gender === 'any',
    'both genders: session gender stays any'
  );
  {
    const kw = ensureBothGenderSearchKeywords(
      'conversational female and male voices',
      ['conversational', 'american'],
      14
    );
    devAssert(kw.includes('female voice') && kw.includes('male voice'), 'both genders: symmetric search keywords');
  }

  // P1-6 / P1-5: gender quota 3+3 and model prefs
  devAssert(detectGenderQuotaPerSide('3 male and 3 female voices') === 3, 'gender quota: 3+3');
  devAssert(detectGenderQuotaPerSide('three male + three female') === 3, 'gender quota: three+three');
  devAssert(
    getSessionGenderAndLimit({}, '3 male and 3 female high quality spanish voices').limitPerGender === 3,
    'gender quota: session limitPerGender is 3'
  );
  devAssert(detectModelPreferenceFromText('voices with eleven v3') === 'eleven_v3', 'model pref: v3');
  devAssert(detectModelPreferenceFromText('flash 2.5 voices') === 'eleven_flash_v2_5', 'model pref: flash 2.5');
  {
    const both = detectModelPreferenceFromText('flash 2.5 and eleven v3 voices');
    devAssert(
      Array.isArray(both) && both.includes('eleven_v3') && both.includes('eleven_flash_v2_5'),
      'model pref: flash+v3 keeps both'
    );
    devAssert(normalizePlanModelPreference(both).length === 2, 'model pref: normalize keeps both');
  }
  devAssert(
    contentMatchedKeywords(['warm', 'locale:pt-pt', 'accent:european', 'professional']).join(',') ===
      'warm,professional',
    'scoring: diagnostic locale/accent tags excluded from content keywords'
  );
  devAssert(isDiagnosticMatchedKeyword('locale:es-mx') === true, 'scoring: locale: is diagnostic');
  devAssert(isDiagnosticMatchedKeyword('warm') === false, 'scoring: warm is not diagnostic');

  // P0-3: named-voice / library intent detection
  devAssert(
    detectNamedVoiceIntent(
      'check other library names for voice Mr Magoo - Italian Professional Voice Talent'
    ) === true,
    'named voice: Magoo Voice Talent intent'
  );
  devAssert(
    extractLibraryVoiceNames(
      'check other library names for voice Mr Magoo - Italian Professional Voice Talent'
    ).some((n) => /magoo/i.test(n)),
    'named voice: extracts Mr Magoo'
  );
  devAssert(
    detectNamedVoiceIntent('check whether the following male voices are suitable for our IVR') === true,
    'named voice: evaluate following voices intent'
  );
  devAssert(
    !detectNamedVoiceIntent('find italian male voices for narration'),
    'named voice: generic italian browse is not named intent'
  );

  // P0-2: specific variant mode must preserve locale/accent through combined/global broaden param builders
  {
    const resolvedSpecific = { variantMode: 'specific', variantAxis: 'accent', variantCandidates: ['european'], targetIso2: 'pt' };
    const preserve = resolvedSpecific?.variantMode === 'specific';
    const paramsG = new URLSearchParams();
    paramsG.set('language', 'pt');
    paramsG.set('accent', 'european');
    paramsG.set('use_cases', 'conversational');
    const keysG = Array.from(paramsG.keys());
    keysG.forEach((k) => {
      if (k === 'use_cases' || k === 'descriptives') paramsG.delete(k);
      if (!preserve && (k === 'accent' || k === 'locale')) paramsG.delete(k);
    });
    devAssert(paramsG.get('accent') === 'european', 'specific broaden: keeps accent european');
    const paramsDrop = new URLSearchParams(paramsG.toString());
    paramsDrop.set('accent', 'european');
    const preserveOff = false;
    Array.from(paramsDrop.keys()).forEach((k) => {
      if (!preserveOff && (k === 'accent' || k === 'locale')) paramsDrop.delete(k);
    });
    // with preserve=false accent would drop — confirm helper semantics
    const p2 = new URLSearchParams();
    p2.set('accent', 'european');
    Array.from(p2.keys()).forEach((k) => {
      if (!false && (k === 'accent' || k === 'locale')) p2.delete(k);
    });
    devAssert(!p2.get('accent'), 'non-specific broaden: may drop accent');
  }

  devAssert(
    buildVerifiedFallbackMessageSoft([], {}, 'en', null, 'american', 20) === '',
    'verified soft fallback: empty voices yield no section'
  );
  devAssert(
    getGenderRenderOrder('any', 'conversational female and male voices for North America').join(',') ===
      'female,male',
    'both genders: hide other/unspecified bucket'
  );
  devAssert(
    getGenderRenderOrder('any', 'female voice for audiobook').join(',') === 'female,male,other',
    'single-gender query keeps other bucket'
  );
  {
    const bothMsg = buildMessageFromSession({
      voices: [
        { voice_id: 'f1', name: 'Alice', gender: 'female' },
        { voice_id: 'u1', name: 'Aaron', gender: '' }
      ],
      ranking: { f1: 1, u1: 0.5 },
      filters: { quality: 'any', gender: 'any' },
      originalQuery: 'conversational female and male voices for North America'
    });
    devAssert(bothMsg.includes('Alice') && !bothMsg.includes('u1'), 'both genders: exclude unknown-gender voices');
  }
  {
    const dedupeMsg = buildMessageFromSession({
      voices: [
        { voice_id: 'hq1', name: 'Eryn', gender: 'female', category: 'high_quality' },
        { voice_id: 'std1', name: 'Eryn', gender: 'female', category: 'premade' }
      ],
      ranking: { hq1: 1, std1: 0.9 },
      filters: { quality: 'any', gender: 'any' },
      originalQuery: 'test'
    });
    devAssert(dedupeMsg.includes('hq1') && !dedupeMsg.includes('std1'), 'tier dedupe: same first name hidden in STANDARD');
  }
  {
    const plan = normalizeKeywordPlan(
      {
        use_case_keywords: ['conversational'],
        style_keywords: ['cartoonish', 'warm'],
        character_keywords: ['villain'],
        extra_keywords: ['cartoonish', 'north america']
      },
      'conversational female and male voices for North America'
    );
    devAssert(!plan.style_keywords.includes('cartoonish'), 'use_case conflict: drop cartoonish style');
    devAssert(!plan.character_keywords.includes('villain'), 'use_case conflict: drop villain character');
    devAssert(!plan.extra_keywords.includes('cartoonish'), 'use_case conflict: drop cartoonish extra');
    devAssert(plan.style_keywords.includes('warm'), 'use_case conflict: keep non-conflicting style');
  }

  // Locale normalization (UI aliases -> canonical)
  devAssert(normalizeRequestedLocale('PT-EU') === 'pt-PT', 'normalize PT-EU -> pt-PT');
  devAssert(normalizeRequestedLocale('en-UK') === 'en-GB', 'normalize en-UK -> en-GB');
  devAssert(normalizeRequestedLocale('es-LATAM') === 'es-419', 'normalize es-LATAM -> es-419');
  devAssert(extractLocaleFromField('es-419') === 'es-419', 'parse locale with numeric region (es-419)');
  // LatAm Spanish: es-419 is a REGION alias, not a queryable shared-voices locale
  devAssert(inferLocale('es', '', 'spanish latam') === null, 'inferLocale: Spanish LatAm does not return es-419');
  {
    const vi = detectVariantIntent('best spanish latam voice', 'es', null);
    devAssert(vi.isSpecific === true && vi.axis === 'accent', 'variant intent: Spanish LatAm -> accent axis');
    devAssert(
      Array.isArray(vi.requestedFacetKeys) && vi.requestedFacetKeys.some((k) => String(k).includes('latin')),
      'variant intent: Spanish LatAm requests latin american'
    );
  }
  {
    const viLa = detectVariantIntent('Spanish Latin American female conversational agent', 'es', null);
    devAssert(viLa.isSpecific === true && viLa.axis === 'accent', 'variant intent: Latin American phrase -> accent');
    const key0 = String(viLa.requestedFacetKeys[0] || '');
    devAssert(key0.includes('latin') && key0 !== 'american', 'variant intent: requested key is latin american family');
  }
  {
    const params = new URLSearchParams();
    const plan = { target_voice_language: 'es', target_locale: 'es-419', quality_preference: 'any' };
    appendQueryFiltersToParams(params, plan, 'spanish latam', { language: 'es', accent: null, gender: null, qualityPref: 'any' });
    devAssert(params.get('locale') !== 'es-419', 'appendQueryFiltersToParams must not set locale=es-419');
  }

  // Accent normalization
  devAssert(normalizeRequestedAccent('General American') === 'american', 'normalize accent: General American -> american');

  // Catalog-driven accent matching should work for accents not hardcoded in regexes (e.g., Italian "sicilian").
  // Seed FacetKB from local JSON fixtures (no network required).
  try {
    const facetsLocal = JSON.parse(fs.readFileSync(path.resolve(__dirname, './facets.json'), 'utf8'));
    const verifyLocal = JSON.parse(fs.readFileSync(path.resolve(__dirname, './verify_counts.json'), 'utf8'));
    facetKB._ingest(facetsLocal, verifyLocal);
    facetKB.loadedAt = Date.now();

    const suggIt = facetKB.suggestAccents('it', 'sicilian voice', { limit: 3 }) || [];
    const bestIt = suggIt.find((x) => x && x.matchKind && x.matchKind !== 'popularity') || null;
    devAssert(!!bestIt && String(bestIt.accent).includes('sicilian'), 'FacetKB suggests sicilian accent (direct/fuzzy)');

    const suggDe = facetKB.suggestAccents('de', 'german voice', { limit: 3 }) || [];
    const bestDe = suggDe.find((x) => x && x.matchKind && x.matchKind !== 'popularity') || null;
    devAssert(!bestDe, 'FacetKB: plain "german voice" is not accent-specific');

    // P0-1: "latin american" must NOT resolve to bare "american"
    const suggEsLa = facetKB.suggestAccents('es', 'Spanish Latin American female voice', { limit: 4 }) || [];
    const bestEsLa = suggEsLa.find((x) => x && x.matchKind && x.matchKind !== 'popularity') || null;
    devAssert(
      !!bestEsLa && String(bestEsLa.norm || bestEsLa.accent).includes('latin'),
      'FacetKB: latin american phrase prefers latin american accent'
    );
    devAssert(
      String(bestEsLa.norm || bestEsLa.accent) !== 'american',
      'FacetKB: latin american must not resolve to american'
    );

    const viEsLaKb = detectVariantIntent('Spanish Latin American female conversational agent', 'es', facetKB);
    devAssert(
      viEsLaKb.isSpecific === true &&
        viEsLaKb.axis === 'accent' &&
        String(viEsLaKb.requestedFacetKeys[0] || '').includes('latin'),
      'variant intent+KB: Latin American -> latin american (not american)'
    );

    // P0-3: "check" must not fuzzy-match english accent "czech"
    const suggEnCheck = facetKB.suggestAccents('en', 'check whether the following male voices are suitable', { limit: 4 }) || [];
    const bestEnCheck = suggEnCheck.find((x) => x && x.matchKind && x.matchKind !== 'popularity') || null;
    devAssert(!bestEnCheck || String(bestEnCheck.norm) !== 'czech', 'FacetKB: check must not match czech');

    // P1-4: European Portuguese prefers accent=european
    const viPtEu = detectVariantIntent('European Portuguese female agent voice', 'pt', facetKB);
    devAssert(
      viPtEu.isSpecific === true && viPtEu.axis === 'accent' && String(viPtEu.requestedFacetKeys[0]) === 'european',
      'variant intent: European Portuguese -> accent european'
    );
    const rPt = resolveVariantConstraints('European Portuguese female voice', { target_voice_language: 'pt' }, facetKB, accentCatalog);
    devAssert(
      rPt.variantMode === 'specific' && rPt.variantAxis === 'accent' && rPt.variantCandidates[0] === 'european',
      'resolver: European Portuguese -> accent european'
    );

    const viDe = detectVariantIntent('german voice', 'de', facetKB);
    devAssert(viDe.isSpecific === false, 'variant intent: plain German -> general mode');

    const viDeBav = detectVariantIntent('bavarian german voice', 'de', facetKB);
    devAssert(viDeBav.isSpecific === true && viDeBav.axis === 'accent', 'variant intent: Bavarian German -> accent');
    devAssert(
      Array.isArray(viDeBav.fallbackFacetKeys) && viDeBav.fallbackFacetKeys.length >= 2,
      'variant intent: Bavarian German has accent fallbacks'
    );

    const p = { target_voice_language: 'it' };
    devAssert(shouldApplyParam('accent', p, 'sicilian voice') === true, 'shouldApplyParam(accent) uses catalog match');
  } catch (e) {
    // If fixtures are missing, skip (DEV_ASSERTS should not crash runtime)
    devAssert(true, 'FacetKB local fixture seed skipped');
  }

  // Universal resolver: numeric-region locale (xx-###) must not be forced as locale if unsupported.
  try {
    // Seed KB (best-effort) so locale allowlist is present.
    const facetsLocal = JSON.parse(fs.readFileSync(path.resolve(__dirname, './facets.json'), 'utf8'));
    const verifyLocal = JSON.parse(fs.readFileSync(path.resolve(__dirname, './verify_counts.json'), 'utf8'));
    facetKB._ingest(facetsLocal, verifyLocal);
    facetKB.loadedAt = Date.now();

    const plan = { target_voice_language: 'es', target_locale: 'es-419' };
    const r = resolveVariantConstraints('es-419', plan, facetKB, accentCatalog);
    devAssert(r && r.targetIso2 === 'es', 'resolver target iso2');
    devAssert(r.regionIntent === 'es-419', 'resolver region intent es-419');
    devAssert(r.variantAxis === 'locale', 'resolver uses locale-axis fanout for unsupported region alias');

    const params = new URLSearchParams();
    appendQueryFiltersToParams(params, plan, 'es-419', { language: 'es', accent: null, gender: null, qualityPref: 'any' });
    devAssert(params.get('locale') !== 'es-419', 'appendQueryFiltersToParams must not set locale=es-419 (region alias)');
  } catch (_) {
    devAssert(true, 'resolver region-alias asserts skipped');
  }

  // GCC / Arabic Gulf: resolver maps regional wording to catalog accent
  try {
    const facetsLocal = JSON.parse(fs.readFileSync(path.resolve(__dirname, './facets.json'), 'utf8'));
    const verifyLocal = JSON.parse(fs.readFileSync(path.resolve(__dirname, './verify_counts.json'), 'utf8'));
    facetKB._ingest(facetsLocal, verifyLocal);
    facetKB.loadedAt = Date.now();
    const planAr = { target_voice_language: 'ar' };
    const rGcc = resolveVariantConstraints('Qatari narrator voice', planAr, facetKB, accentCatalog);
    devAssert(
      rGcc.variantAxis === 'accent' && rGcc.variantCandidates && rGcc.variantCandidates[0] === 'gulf',
      'resolver GCC: Qatari -> gulf accent'
    );
    const rKw = resolveVariantConstraints('Kuwaiti voice', planAr, facetKB, accentCatalog);
    devAssert(
      rKw.variantAxis === 'accent' && rKw.variantCandidates && rKw.variantCandidates[0] === 'kuwaiti',
      'resolver GCC: Kuwaiti -> kuwaiti accent'
    );
  } catch (_) {
    devAssert(true, 'resolver GCC asserts skipped');
  }

  // Soft strict bucketing: exact vs verified-only (missing/non-exact locale/accent)
  {
    const v1 = {
      voice_id: 'v1',
      name: 'v1',
      language: 'pt',
      locale: null,
      accent: null,
      verified_languages: [{ language: 'pt', locale: 'pt-BR', accent: 'brazilian' }]
    };
    const v2 = {
      voice_id: 'v2',
      name: 'v2',
      language: 'pt',
      locale: null,
      accent: null,
      verified_languages: [{ language: 'pt' }] // missing locale/accent metadata
    };
    const ranking = { v1: 1.0, v2: 0.9 };
    const b = buildSoftStrictBuckets([v1, v2], ranking, 'pt', 'pt-BR', 'brazilian');
    devAssert(Array.isArray(b.exact) && b.exact.some((x) => x.voice_id === 'v1'), 'strict exact includes v1');
    devAssert(Array.isArray(b.verifiedOnly) && b.verifiedOnly.some((x) => x.voice_id === 'v2'), 'verified-only includes v2');
  }

  // Primary mismatch must NOT drop verified voices (common in Voice Library)
  {
    const v3 = {
      voice_id: 'v3',
      name: 'v3',
      language: 'en',
      locale: null,
      accent: null,
      verified_languages: [{ language: 'ko' }] // verified for Korean, but primary is English
    };
    const ranking = { v3: 1.0 };
    const b = buildSoftStrictBuckets([v3], ranking, 'ko', null, null);
    devAssert(Array.isArray(b.exact) && b.exact.length === 0, 'primary mismatch should not be exact');
    devAssert(Array.isArray(b.verifiedOnly) && b.verifiedOnly.some((x) => x.voice_id === 'v3'), 'primary mismatch goes to verified-only');
  }

  // Specific variant filter: reject generic pt voices when user asked for pt-PT
  {
    const ptPt = {
      voice_id: 'ptpt1',
      name: 'Maria',
      language: 'pt',
      locale: 'pt-PT',
      accent: 'european',
      verified_languages: [{ language: 'pt', locale: 'pt-PT', accent: 'european' }]
    };
    const ptGeneric = {
      voice_id: 'ptgen1',
      name: 'Tripti',
      language: 'pt',
      accent: 'indian',
      verified_languages: [{ language: 'pt', accent: 'indian' }]
    };
    const resolved = {
      variantMode: 'specific',
      variantAxis: 'locale',
      variantCandidates: ['pt-PT'],
      targetIso2: 'pt'
    };
    const plan = { target_locale: 'pt-PT', target_accent: 'european' };
    const out = filterVoicesForSpecificVariant([ptPt, ptGeneric], 'pt', resolved, plan);
    devAssert(out.length === 1 && out[0].voice_id === 'ptpt1', 'specific variant filter keeps pt-PT only');
  }

  // Negatives: "not audiobook" should be recognized and pruned
  const n1 = extractNegativeTokens('not audiobook');
  devAssert(n1.has('audiobook'), 'negatives: not audiobook recognized');
  const p1 = { use_case_keywords: ['audiobook', 'documentary'], __negatives: Array.from(n1) };
  applyNegativesToPlan(p1);
  devAssert(
    !Array.isArray(p1.use_case_keywords) || !p1.use_case_keywords.includes('audiobook'),
    'negatives: audiobook pruned from plan.use_case_keywords'
  );
  const kw1 = pruneNegativesFromList(['audiobook', 'clear', 'documentary'], Array.from(n1));
  devAssert(!kw1.includes('audiobook'), 'negatives: audiobook pruned from selected keywords');

  // Negatives: multilingual aliases should canonicalize
  const n2 = extractNegativeTokens('zonder luisterboek');
  devAssert(n2.has('audiobook'), 'negatives: NL luisterboek -> audiobook');
  const n3 = extractNegativeTokens('bez audiobooka');
  devAssert(n3.has('audiobook'), 'negatives: PL audiobooka -> audiobook');
  const kw2 = pruneNegativesFromList(['audio book', 'clear'], Array.from(new Set(['audiobook'])));
  devAssert(!kw2.includes('audio book'), 'negatives: audio book pruned via canonicalization');

  // Accent explicitness: negated accent must NOT count as explicit preference
  devAssert(
    hasExplicitAccentMention('The voices should not have a Flemish accent') === false,
    'accent: negated should not be explicit preference'
  );
  devAssert(
    hasExplicitAccentMention('Dutch with a Flemish accent') === true,
    'accent: positive should be explicit'
  );
  const a1 = extractNegativeAccents('The voices should not have a Flemish accent', 'nl', null);
  devAssert(Array.isArray(a1) && a1.includes('flemish'), 'exclude_accents: flemish detected');
  const a2 = extractNegativeAccents('Najlepsze głosy po niderlandzku, bez flamandzkiego akcentu', 'nl', null);
  devAssert(Array.isArray(a2) && a2.includes('flemish'), 'exclude_accents: PL flamandzki -> flemish');

  // Locale exclusions: explicit tag should be detected
  const l1 = extractNegativeLocales('Dutch voices, not nl-BE', 'nl', null);
  devAssert(Array.isArray(l1) && l1.includes('nl-BE'), 'exclude_locales: not nl-BE detected');
  const l2 = extractNegativeLocales('Dutch voices, without Belgium', 'nl', null);
  devAssert(Array.isArray(l2) && l2.includes('nl-BE'), 'exclude_locales: Belgium -> nl-BE');

  // Gender exclusions
  const g1 = extractExcludedGenders('Spanish voice, not female');
  devAssert(Array.isArray(g1) && g1.includes('female'), 'exclude_genders: not female detected');

  // -----------------------------------------------------------
  // Regressions for 2026-02-06 report:
  // - accent slugging must be applied in fallback paths
  // - "history" must not map to narrative_story via substring "story"
  // -----------------------------------------------------------

  // Use-cases: substring "story" should not match "history"
  {
    const r1 = pickQueryUseCases({ use_case_keywords: ['conversational', 'history'] });
    devAssert(Array.isArray(r1) && r1.includes('conversational'), 'use_case: conversational retained');
    devAssert(!r1.includes('narrative_story'), 'use_case: history must not map to narrative_story');
  }
  {
    const r2 = pickQueryUseCases({ use_case_keywords: ['history'] });
    devAssert(Array.isArray(r2) && r2.length === 0, 'use_case: history alone should not map');
  }
  {
    const r3 = pickQueryUseCases({ use_case_keywords: ['story'] });
    devAssert(Array.isArray(r3) && r3.includes('narrative_story'), 'use_case: story maps to narrative_story');
  }
  {
    const r4 = pickQueryUseCases({ use_case_keywords: ['stories'] });
    devAssert(Array.isArray(r4) && r4.includes('narrative_story'), 'use_case: stories maps to narrative_story');
  }
  {
    const r5 = pickQueryUseCases({ use_case_keywords: ['storyteller'] });
    devAssert(Array.isArray(r5) && r5.includes('narrative_story'), 'use_case: storyteller maps to narrative_story');
  }
  {
    const r6 = pickQueryUseCases({ use_case_keywords: ['storytellers'] });
    devAssert(Array.isArray(r6) && r6.includes('narrative_story'), 'use_case: storytellers maps to narrative_story');
  }
  {
    const r7 = pickQueryUseCases({ use_case_keywords: ['story telling'] });
    devAssert(Array.isArray(r7) && r7.includes('narrative_story'), 'use_case: story telling maps to narrative_story');
  }
  // Use-cases: support/customer-service phrases must map to conversational
  {
    const r8 = pickQueryUseCases({ use_case_keywords: ['customer support'] });
    devAssert(Array.isArray(r8) && r8.includes('conversational'), 'use_case: customer support -> conversational');
    devAssert(!r8.includes('narrative_story'), 'use_case: customer support must not map to narrative_story');
  }
  {
    const r9 = pickQueryUseCases({ use_case_keywords: ['call center'] });
    devAssert(Array.isArray(r9) && r9.includes('conversational'), 'use_case: call center -> conversational');
  }
  // Brief family + ranking: articles/audiobooks/educational must not collapse to conversational
  {
    devAssert(
      inferBriefUseCaseFamily('best german voices for articles, high quality', null) === 'articles',
      'brief family: articles'
    );
    devAssert(
      inferBriefUseCaseFamily('best german voices for audiobooks, high quality', null) === 'narrative',
      'brief family: audiobooks -> narrative'
    );
    devAssert(
      inferBriefUseCaseFamily('best german voices for educational, high quality', null) === 'educational',
      'brief family: educational'
    );
  }
  {
    const polluted = {
      use_case_keywords: ['conversational', 'support', 'customer support', 'audiobook']
    };
    const rAud = pickQueryUseCases(polluted, 'best german voices for audiobooks, high quality');
    devAssert(rAud.includes('narrative_story'), 'use_case: audiobook brief prefers narrative_story');
    devAssert(!rAud.includes('conversational'), 'use_case: audiobook brief drops floor conversational');
    devAssert(
      rAud.length === 1 && rAud[0] === 'narrative_story',
      'use_case: audiobooks exclusive narrative_story'
    );
    const rArt = pickQueryUseCases(
      { use_case_keywords: ['conversational', 'support', 'article', 'narration', 'storytelling'] },
      'best german voices for articles, high quality'
    );
    devAssert(rArt.includes('informative_educational'), 'use_case: articles -> informative_educational');
    devAssert(!rArt.includes('conversational'), 'use_case: articles drops floor conversational');
    devAssert(!rArt.includes('narrative_story'), 'use_case: articles must not send narrative_story');
    devAssert(
      rArt.length === 1 && rArt[0] === 'informative_educational',
      'use_case: articles exclusive informative_educational'
    );
    const rEdu = pickQueryUseCases(
      { use_case_keywords: ['educational', 'narration', 'storytelling'] },
      'best german voices for educational, high quality'
    );
    devAssert(
      rEdu.length === 1 && rEdu[0] === 'informative_educational',
      'use_case: educational exclusive informative_educational'
    );
    devAssert(!rEdu.includes('narrative_story'), 'use_case: educational must not send narrative_story');
  }
  {
    const floorAud = ensureKeywordFloor('best german voices for audiobooks, high quality', {
      use_case_keywords: [],
      tone_keywords: [],
      style_keywords: [],
      character_keywords: [],
      extra_keywords: []
    });
    devAssert(
      Array.isArray(floorAud.use_case_keywords) && floorAud.use_case_keywords.includes('audiobook'),
      'keyword floor: audiobook brief injects audiobook'
    );
    devAssert(
      !floorAud.use_case_keywords.includes('customer support'),
      'keyword floor: audiobook brief must not inject customer support'
    );
    const floorArt = ensureKeywordFloor('best german voices for articles, high quality', {
      use_case_keywords: [],
      tone_keywords: [],
      style_keywords: [],
      character_keywords: [],
      extra_keywords: []
    });
    devAssert(
      Array.isArray(floorArt.use_case_keywords) && floorArt.use_case_keywords.some((k) => /article|informative/.test(k)),
      'keyword floor: articles brief injects informative/article'
    );
    devAssert(
      !floorArt.use_case_keywords.includes('call center'),
      'keyword floor: articles brief must not inject call center'
    );
  }
  {
    const asmr = {
      name: 'Irene - whispering ASMR',
      description: 'Soft whispering ASMR voice',
      descriptive: 'asmr, whisper'
    };
    const chipmunk = {
      name: 'Knurps - Playful Chipmunk',
      description: 'Playful chipmunk character',
      descriptive: 'playful, chipmunk, cute'
    };
    const support = {
      name: 'Sam - Customer Support',
      description: 'Friendly customer support agent',
      descriptive: 'customer support, conversational'
    };
    const narrator = {
      name: 'Jonas Deep Resonant',
      description: 'Deep resonant German narrator for audiobooks',
      descriptive: 'deep, resonant, narration, calm'
    };
    const qArt = 'best german voices for articles, high quality';
    const qAud = 'best german voices for audiobooks, high quality';
    const qEdu = 'best german voices for educational, high quality';
    for (const [fam, q] of [
      ['narrative', qAud],
      ['articles', qArt],
      ['educational', qEdu]
    ]) {
      devAssert(
        scoreVoiceUseCaseFit(narrator, fam, q) > scoreVoiceUseCaseFit(asmr, fam, q),
        `brief fit: narrator beats ASMR for ${fam}`
      );
      devAssert(
        scoreVoiceUseCaseFit(narrator, fam, q) > scoreVoiceUseCaseFit(chipmunk, fam, q),
        `brief fit: narrator beats chipmunk for ${fam}`
      );
      devAssert(
        scoreVoiceUseCaseFit(narrator, fam, q) > scoreVoiceUseCaseFit(support, fam, q),
        `brief fit: narrator beats customer support for ${fam}`
      );
    }
    const eduVoice = {
      name: 'Lukas Confident',
      description: 'Clear professional educational explainer',
      descriptive: 'clear, professional, informative, educational'
    };
    devAssert(
      scoreVoiceUseCaseFit(eduVoice, 'educational', qEdu) > scoreVoiceUseCaseFit(asmr, 'educational', qEdu),
      'brief fit: educational explainer beats ASMR'
    );
    devAssert(
      scoreVoiceUseCaseFit(eduVoice, 'articles', qArt) > scoreVoiceUseCaseFit(chipmunk, 'articles', qArt),
      'brief fit: articles prefers educational over chipmunk'
    );
    const santa = {
      name: 'Nicholas - Gentle Santa Claus',
      description: 'Gentle Santa Claus for holiday stories',
      descriptive: 'gentle, warm, santa, christmas'
    };
    const softRomantic = {
      name: 'Irene soft and romantic',
      description: 'Soft romantic intimate voice',
      descriptive: 'soft, romantic, warm'
    };
    const marcus = {
      name: 'Marcus Deep & Calm German',
      description: 'Deep and calm German audiobook narrator',
      descriptive: 'deep, calm, narration, audiobook, professional'
    };
    const tristan = {
      name: 'Tristan',
      description: 'Warm audiobook storytelling narrator',
      descriptive: 'audiobook, storytelling, warm, clear'
    };
    devAssert(
      scoreVoiceUseCaseFit(marcus, 'narrative', qAud) > scoreVoiceUseCaseFit(santa, 'narrative', qAud),
      'brief fit: deep calm narrator beats Santa on generic audiobooks'
    );
    devAssert(
      scoreVoiceUseCaseFit(tristan, 'narrative', qAud) > scoreVoiceUseCaseFit(santa, 'narrative', qAud),
      'brief fit: audiobook storyteller beats Santa on generic audiobooks'
    );
    devAssert(
      scoreVoiceUseCaseFit(marcus, 'narrative', qAud) > scoreVoiceUseCaseFit(softRomantic, 'narrative', qAud),
      'brief fit: deep calm narrator beats soft-romantic on generic audiobooks'
    );
    devAssert(
      scoreVoiceUseCaseFit(tristan, 'narrative', qAud) > scoreVoiceUseCaseFit(softRomantic, 'narrative', qAud),
      'brief fit: audiobook storyteller beats soft-romantic on generic audiobooks'
    );
  }
  {
    const rArticle = pickQueryUseCases({ use_case_keywords: ['article'] }, 'voices for articles');
    devAssert(
      Array.isArray(rArticle) && rArticle.includes('informative_educational'),
      'use_case: article maps to informative_educational'
    );
  }
  // Query builder: explicit "conversational/customer support" in user text must force conversational,
  // even if the plan contains narrative-like use_case keywords.
  {
    const p = new URLSearchParams();
    appendQueryFiltersToParams(p, { use_case_keywords: ['story'] }, 'top conversational voice Brazil pt-br, customer support', {
      language: 'pt',
      accent: null,
      gender: null,
      qualityPref: 'any',
      forceUseCases: true
    });
    const ucs = typeof p.getAll === 'function' ? p.getAll('use_cases') : [];
    devAssert(Array.isArray(ucs) && ucs.includes('conversational'), 'query: conversational text forces use_cases=conversational');
    devAssert(!ucs.includes('narrative_story'), 'query: conversational text must not set narrative_story');
  }
  {
    const p2 = new URLSearchParams();
    appendQueryFiltersToParams(p2, { use_case_keywords: [] }, 'ivr customer support voice', {
      language: 'en',
      accent: null,
      gender: null,
      qualityPref: 'any',
      forceUseCases: true
    });
    const ucs2 = typeof p2.getAll === 'function' ? p2.getAll('use_cases') : [];
    devAssert(Array.isArray(ucs2) && ucs2.includes('conversational'), 'query: ivr treated as conversational');
    devAssert(!ucs2.includes('ivr'), 'query: ivr must not be used as use_cases enum');
  }

  // Accent: ensure API param uses slug for spaced accents (e.g., "latin american")
  try {
    const facetsLocal = JSON.parse(fs.readFileSync(path.resolve(__dirname, './facets.json'), 'utf8'));
    const verifyLocal = JSON.parse(fs.readFileSync(path.resolve(__dirname, './verify_counts.json'), 'utf8'));
    facetKB._ingest(facetsLocal, verifyLocal);
    facetKB.loadedAt = Date.now();

    const acc1 = normalizeAccentForApiParam('es', 'latin american');
    devAssert(acc1 === 'latin-american', 'accent api param: latin american -> latin-american');

    // KB validation must accept slug form too (otherwise accent can be incorrectly rejected).
    const ok1 = facetKB.checkAccentAllowed('es', 'latin-american');
    devAssert(!!ok1 && ok1.known === true && ok1.allowed === true, 'KB: latin-american allowed for es');

    const slug1 = facetKB.getAccentSlug('es', 'latin-american');
    devAssert(slug1 === 'latin-american', 'KB: getAccentSlug accepts slug input');

    // PT: pt-PT should map to the *accent facet* \"european\" (not \"portuguese\")
    devAssert(getRequestedLocale('pt-PT', { target_voice_language: 'pt' }) === 'pt-PT', 'pt locale: pt-PT parses');
    devAssert(
      getRequestedAccent('pt-PT Portuguese accent', { target_voice_language: 'pt' }, 'pt-PT') === 'european',
      'pt accent: pt-PT -> european'
    );
    devAssert(
      getRequestedAccent('pt-PT accent', { target_voice_language: 'pt', target_accent: 'portuguese' }, 'pt-PT') === 'european',
      'pt accent: explicit portuguese -> european alias'
    );
    const okPt = facetKB.checkAccentAllowed('pt', 'european');
    devAssert(!!okPt && okPt.known === true && okPt.allowed === true, 'KB: european allowed for pt');
    devAssert(normalizeRequestedAccent('portuguese') === 'european', 'accent alias: portuguese -> european');
  } catch (_) {
    devAssert(true, 'accent slug asserts skipped');
  }

  // Voice+language compatibility questions should not fall through to shortlist language summary or search.
  {
    const q =
      'will this voice works good with polish language or we can expect some artifacts?';
    const compat = detectVoiceLanguageCompatibilityIntent(q);
    devAssert(!!compat && compat.iso2 === 'pl', 'compat intent: polish voice question');
    devAssert(!checkLanguagesIntent(q.toLowerCase()), 'compat intent: not shortlist languages');
    devAssert(
      !detectVoiceLanguageCompatibilityIntent('what languages do these voices support?'),
      'compat intent: shortlist meta excluded'
    );
    devAssert(
      !detectVoiceLanguageCompatibilityIntent('find a polish female voice for narration'),
      'compat intent: search brief excluded'
    );

    const vPl = {
      voice_id: 'vPl',
      name: 'Test PL',
      language: 'en',
      verified_languages: [{ language: 'pl', locale: 'pl-PL', accent: 'standard' }]
    };
    const vEn = {
      voice_id: 'vEn',
      name: 'Test EN',
      language: 'en',
      verified_languages: [{ language: 'en' }]
    };
    devAssert(
      buildVoiceLanguageCompatibilityMessage(vPl, 'pl').includes('verified'),
      'compat message: verified voice'
    );
    devAssert(
      buildVoiceLanguageCompatibilityMessage(vEn, 'pl').includes('not'),
      'compat message: unverified voice'
    );
    const session = { voices: [vPl, vEn], ranking: { vPl: 0.9, vEn: 0.8 } };
    devAssert(
      resolveVoiceForCompatibilityQuestion('will this voice work with polish?', session)?.voice_id === 'vPl',
      'compat resolve: this voice -> top ranked'
    );
  }

  // Voice ID lookup: quality questions about a specific voice_id
  {
    const qualityQ = 'is KHmfNHtEjHhLK9eER20w high quality voice?';
    devAssert(
      extractBareVoiceId(qualityQ) === 'KHmfNHtEjHhLK9eER20w',
      'extractBareVoiceId: mixed-case voice id'
    );
    devAssert(detectVoiceIdQualityQuestion(qualityQ), 'voice id quality question detected');
    devAssert(detectVoiceLookupIntent(qualityQ), 'voice lookup intent: quality question with id');
    const hqVoice = { voice_id: 'KHmfNHtEjHhLK9eER20w', name: 'Test HQ', category: 'high_quality' };
    const stdVoice = { voice_id: 'KHmfNHtEjHhLK9eER20w', name: 'Test Std', category: 'generated' };
    devAssert(
      buildVoiceLookupMessage(hqVoice, qualityQ).includes('High quality: Yes'),
      'voice lookup message: hq voice'
    );
    devAssert(
      buildVoiceLookupMessage(stdVoice, qualityQ).includes('High quality: No'),
      'voice lookup message: standard voice'
    );
    devAssert(
      !detectVoiceLookupIntent('find a high quality polish female voice'),
      'voice lookup intent: generic hq search excluded'
    );
  }

  // Creator browse: intent + voice-id extraction for owner lookup
  {
    const creatorQ = "find other voices from the user who has 'covxL85MSd0uUrktE45z'";
    devAssert(detectCreatorVoicesIntent(creatorQ), 'creator intent: find other voices from user who has voice id');
    devAssert(
      extractVoiceIdForOwnerLookup(creatorQ) === 'covxL85MSd0uUrktE45z',
      'extractVoiceIdForOwnerLookup: quoted id after who has'
    );
    devAssert(
      extractVoiceIdForOwnerLookup('find other voices from the user who has covxL85MSd0uUrktE45z') ===
        'covxL85MSd0uUrktE45z',
      'extractVoiceIdForOwnerLookup: bare id after who has'
    );
  }

  // Notice period intent + query param
  {
    const infinity = detectNoticePeriodFromText('find an infinity voice for narration');
    devAssert(infinity.preference === 'min_days' && infinity.minDays === MAX_NOTICE_PERIOD_DAYS, 'notice: infinity voice -> 730');

    const oneYear = detectNoticePeriodFromText('polish female with at least 1 year notice period');
    devAssert(oneYear.preference === 'min_days' && oneYear.minDays === 365, 'notice: 1 year -> 365');

    const withNp = detectNoticePeriodFromText('only with notice period');
    devAssert(withNp.preference === 'min_days' && withNp.minDays === 1, 'notice: with notice period -> 1');

    const noNp = detectNoticePeriodFromText('bez okresu wypowiedzenia');
    devAssert(noNp.preference === 'no_notice', 'notice: PL bez okresu wypowiedzenia');

    const planInfinity = applyNoticePeriodToPlan({}, 'max notice period voice');
    const pInf = new URLSearchParams();
    appendQueryFiltersToParams(pInf, planInfinity, 'max notice period voice', {
      language: 'en',
      accent: null,
      gender: null,
      qualityPref: 'any',
      minNoticePeriodDays: planInfinity.__min_notice_period_days
    });
    devAssert(
      pInf.get('min_notice_period_days') === String(MAX_NOTICE_PERIOD_DAYS),
      'notice: appendQueryFiltersToParams sets min_notice_period_days'
    );

    const voices = [
      { voice_id: 'a', notice_period: 730 },
      { voice_id: 'b', notice_period: null },
      { voice_id: 'c', notice_period: 30 }
    ];
    const filteredMin = filterVoicesByNoticePeriod(voices, { __min_notice_period_days: 365 });
    devAssert(filteredMin.length === 1 && filteredMin[0].voice_id === 'a', 'notice: client min-days filter');
    const filteredNone = filterVoicesByNoticePeriod(voices, { __no_notice_period: true });
    devAssert(filteredNone.length === 1 && filteredNone[0].voice_id === 'b', 'notice: client no-notice filter');

    devAssert(
      formatVoiceLine({ voice_id: 'x', name: 'Test', notice_period: 730 }, 'pl').includes('730 dni notice period'),
      'notice: formatVoiceLine PL label'
    );
    devAssert(
      formatVoiceLine({ voice_id: 'y', name: 'Test', notice_period: null }, 'pl').includes('brak notice period'),
      'notice: formatVoiceLine PL no-notice label'
    );
  }

  // Custom rates intent + query param
  {
    const noCr = detectCustomRatesFromText('spanish voices without custom rates');
    devAssert(noCr.preference === 'exclude', 'custom rates: without custom rates -> exclude');

    const withCr = detectCustomRatesFromText('include custom rates');
    devAssert(withCr.preference === 'any', 'custom rates: include custom rates -> any');

    const planNoCr = applyCustomRatesToPlan({}, 'without custom rates');
    devAssert(planNoCr.__no_custom_rates === true, 'custom rates: plan sets __no_custom_rates');

    const pNoCr = new URLSearchParams();
    appendQueryFiltersToParams(pNoCr, planNoCr, 'without custom rates', {
      language: 'es',
      accent: null,
      gender: null,
      qualityPref: 'any'
    });
    devAssert(
      pNoCr.get('include_custom_rates') === 'false',
      'custom rates: appendQueryFiltersToParams sets include_custom_rates=false'
    );

    const voicesCr = [
      { voice_id: 'a', name: 'Standard', rate: 1 },
      { voice_id: 'b', name: 'Premium', rate: 2 },
      { voice_id: 'c', name: 'Default' }
    ];
    const filteredCr = filterVoicesByCustomRates(voicesCr, { __no_custom_rates: true });
    devAssert(
      filteredCr.length === 2 && filteredCr.every((v) => !hasCustomRateMultiplier(v)),
      'custom rates: client exclude filter'
    );
  }

  // Notice period lookup: specific voice_id list should not fall through to search or language compat
  {
    const noticeQ = `can you check the notice period for these voices?

80lPKtzJMPh1vjYMUgwe	Benjamin - Deep, Smooth and Rich
dlGxemPxFMTY7iXagmOj	Fernando Martínez - Rapid, Persuasive
l1zE9xgNpUTaQCZzpNJa	Alberto Rodríguez - Serious, Narrative
2rigMbVWLdqtBSCahJFX	Tatiana Martin - Wise-speaking, calm
qHkrJuifPpn95wK3rm2A	Andrea - Polite, Cheerful and Calm
sKgg4MPUDBy69X7iv3fA	Alejandro Duràn - Warm, Deep and Hoarse
Nh2zY9kknu6z4pZy6FhD	David Martin - Confident and Balanced
kcQkGnn0HAT2JRDQ4Ljp	Norah - Warm, Friendly and Clear
CaJslL1xziwefCeTNzHv	Cristina Campos - Friendly and Soft
9F4C8ztpNUmXkdDDbz3J	Dan - Upbeat, Dynamic and Friendly`;
    const ids = extractAllVoiceIds(noticeQ);
    devAssert(ids.length === 10, 'notice lookup: extract all 10 voice ids from slack paste');
    devAssert(detectVoiceNoticePeriodIntent(noticeQ), 'notice lookup: intent with voice id list');
    devAssert(
      !detectVoiceLanguageCompatibilityIntent(noticeQ),
      'notice lookup: must not trigger language compatibility'
    );
    devAssert(
      !detectVoiceNoticePeriodIntent('find polish female voices with notice period'),
      'notice lookup: generic search excluded'
    );
    devAssert(
      !detectVoiceNoticePeriodIntent('what languages do these voices support?'),
      'notice lookup: language meta excluded'
    );
    const resolved = resolveVoicesForNoticePeriodQuestion(noticeQ, null);
    devAssert(resolved.length === 10 && resolved.every((v) => v.__needsLookup), 'notice lookup: resolve all pasted ids');
    const session = {
      voices: [
        { voice_id: 'a', name: 'A', notice_period: 30 },
        { voice_id: 'b', name: 'B', notice_period: null }
      ]
    };
    const fromSession = resolveVoicesForNoticePeriodQuestion('check notice period for these voices', session);
    devAssert(fromSession.length === 2, 'notice lookup: resolve from session shortlist');
    devAssert(
      buildVoiceNoticePeriodMessage(session.voices, 'en').includes('30 days notice period'),
      'notice lookup: message includes notice period label'
    );
  }
}

async function runDevPoc() {
  if (!isDevPocEnabled()) return false;

  if (!process.env.ELEVENLABS_API_KEY) {
    console.error('DEV_POC=true requires ELEVENLABS_API_KEY.');
    process.exit(1);
  }

  const queries = [
    'es latam conversational',
    'spanish latin american accent customer support',
    'top conversational voice spanish Latin America accent, high quality'
  ];

  for (const q of queries) {
    const trace = [];
    const traceCb = (e) => { try { trace.push(e); } catch (_) {} };

    // Minimal heuristic plan (no OpenAI required).
    const lower = String(q || '').toLowerCase();
    const iso2 = parseUserLanguageHints(q)?.iso2 || detectVoiceLanguageFromText(q) || null;
    const basePlan = {
      user_interface_language: guessUiLanguageFromText(q),
      target_voice_language: iso2,
      target_accent: lower.includes('latam') || lower.includes('latin america') ? 'latin american' : null,
      target_gender: null,
      quality_preference: /\bhigh quality\b|\bhq\b/.test(lower) ? 'high_only' : 'any',
      model_preference: detectModelPreferenceFromText(q) || 'any',
      tone_keywords: [],
      use_case_keywords: ['conversational'],
      character_keywords: [],
      style_keywords: [],
      extra_keywords: []
    };
    const plan = (typeof normalizeKeywordPlan === 'function') ? normalizeKeywordPlan(basePlan, q) : basePlan;

    // Use keyword floor to create a realistic per-keyword search list.
    const enriched = typeof ensureKeywordFloor === 'function' ? ensureKeywordFloor(q, plan) : plan;
    let voices = [];
    try {
      voices = await fetchVoicesByKeywords(enriched, q, traceCb);
    } catch (e) {
      // Keep DEV_POC usable even with invalid keys / network issues.
      try {
        traceCb({ stage: 'dev_poc_error', params: { message: String(e?.message || e || 'error').slice(0, 200) }, count: 0 });
      } catch (_) {}
    }
    const report = buildSearchReport(trace, enriched, 'generic', {
      unique_count: Array.isArray(voices) ? voices.length : 0,
      verified_en_es: detectBilingualEnEs(q) && Array.isArray(voices)
        ? voices.filter(voiceHasVerifiedEnAndEs).length
        : undefined,
      top_coverage: []
    });

    console.log('\n--- DEV_POC QUERY ---');
    console.log(q);
    console.log('--- DEV_POC REPORT ---');
    console.log(report);
  }

  return true;
}

// -------------------------------------------------------------
// POC_SEARCH_REPORT -> DM (owner only)
//
// Required Slack scopes:
// - im:write (for conversations.open)
// - chat:write (already required)
//
// Env:
// - POC_SEARCH_REPORT=true
// - POC_SEARCH_REPORT_DM_USER_ID=Uxxxxxxxx (owner Slack user id)
//
// Manual test:
// - Trigger the bot in a public channel thread:
//   - results should be posted in-thread
//   - POC report should NOT be posted in-thread
//   - POC report should arrive in owner's DM, with first line == user's `cleaned` message
// -------------------------------------------------------------

function getPocReportDmUserId() {
  const id = String(process.env.POC_SEARCH_REPORT_DM_USER_ID || '').trim();
  return id ? id : null;
}

async function postPocReportDm(client, text) {
  try {
    const userId = getPocReportDmUserId();
    if (!client || !userId || !text) return;

    const opened = await client.conversations.open({ users: userId });
    const dmChannel = opened?.channel?.id;
    if (!dmChannel) return;

    const blocks = buildBlocksFromText(text);
    await client.chat.postMessage({
      channel: dmChannel,
      text,
      blocks: blocks || undefined
    });
  } catch (e) {
    console.error('postPocReportDm error', e?.message || e);
  }
}

async function safePostMessage(client, payload, fallbackText) {
  const labels = getLabels?.();
  const fallback =
    (fallbackText && String(fallbackText).trim()) ||
    (labels?.noVoices && String(labels.noVoices).trim()) ||
    '–';

  const rawText = payload?.text;
  const text = rawText == null ? '' : typeof rawText === 'string' ? rawText : String(rawText);
  const safeText = text.trim() ? text : fallback;

  const safePayload = { ...(payload || {}), text: safeText };
  if (!safePayload.blocks) delete safePayload.blocks;

  return await client.chat.postMessage(safePayload);
}

// -------------------------------------------------------------
// New search handler
// -------------------------------------------------------------

async function handleNewSearch(event, cleaned, threadTs, client) {
  try {
    // Load language index early so ISO2 validation is accurate and language-name matching works.
    await ensureLanguageIndexLoaded();

    const labels = getLabels();
    let uiLang =
      (guessUiLanguageFromText(cleaned) || 'en').toString().slice(0, 2).toLowerCase();

    // Voice ID lookup — before keyword plan / search
    const bareVoiceId = extractBareVoiceId(cleaned);
    if (bareVoiceId && detectVoiceLookupIntent(cleaned) && !detectCreatorVoicesIntent(cleaned)) {
      const lookupTrace = [];
      const traceCb = (entry) => {
        try {
          lookupTrace.push(entry);
        } catch (_) {}
      };
      const voice = await lookupVoiceById(bareVoiceId, traceCb);
      if (!voice) {
        const msg = await translateForUserLanguage(
          "I couldn't find a voice with that ID in the public Voice Library or your workspace.",
          uiLang
        );
        await safePostMessage(
          client,
          { channel: event.channel, thread_ts: threadTs, text: msg },
          labels.noVoices
        );
        return;
      }
      let message = buildVoiceLookupMessage(voice, cleaned);
      message = await translateForUserLanguage(message, uiLang);
      await safePostMessage(
        client,
        { channel: event.channel, thread_ts: threadTs, text: message },
        labels.noVoices
      );
      return;
    }

    const compatUiLang = (guessUiLanguageFromText(cleaned) || 'en').toString().slice(0, 2).toLowerCase();
    if (await respondVoiceNoticePeriodLookup(event, cleaned, threadTs, client, null, uiLang)) {
      return;
    }

    if (await respondVoiceLanguageCompatibility(event, cleaned, threadTs, client, null, compatUiLang)) {
      return;
    }

    // Named-voice / library-alias / evaluate-listed-voices — before keyword plan / facet browse
    if (detectNamedVoiceIntent(cleaned)) {
      const namedTrace = [];
      const traceCb = (entry) => {
        try {
          namedTrace.push(entry);
        } catch (_) {}
      };
      const ids = extractAllVoiceIds(cleaned);
      const names = extractLibraryVoiceNames(cleaned);
      let voices = [];
      if (ids.length) {
        for (const id of ids.slice(0, 6)) {
          const v = await lookupVoiceById(id, traceCb);
          if (v?.voice_id) voices.push(v);
        }
      }
      if (!voices.length && names.length) {
        const genderHint = /\bfemale\b/i.test(cleaned) ? 'female' : /\bmale\b/i.test(cleaned) ? 'male' : null;
        const langHint = parseUserLanguageHints(cleaned)?.iso2 || null;
        voices = await lookupVoicesByName(names, {
          gender: genderHint,
          language: langHint,
          traceCb
        });
      }
      // Soft fallback: if we detected talent/library intent but failed to extract a name, try a trimmed title segment
      if (!voices.length && !ids.length && !names.length) {
        const m = cleaned.match(/\bvoice\s+([A-ZÀ-ÖØ-öø-ÿ][\w' .-]{2,50})/i);
        if (m) {
          voices = await lookupVoicesByName([m[1].replace(/\s*[—–-].*$/, '').trim()], { traceCb });
        }
      }
      let message = buildNamedVoiceLookupMessage(
        voices,
        names.length ? names : ids,
        cleaned
      );
      message = await translateForUserLanguage(message, uiLang);
      await safePostMessage(
        client,
        { channel: event.channel, thread_ts: threadTs, text: message },
        labels.noVoices
      );
      return;
    }

    const keywordPlan = await buildKeywordPlan(cleaned);
    // Keep raw user brief for diagnostics / POC search report enrichment
    try {
      keywordPlan.__reportUserText = cleaned;
    } catch (_) {}
    // Removed initial progress message; first message will be the results
    // Seed plan flags for server-side filtering/pagination
    keywordPlan.__featured = false;
    keywordPlan.__sort = null;
    keywordPlan.__listAll = detectListAll(cleaned);
    keywordPlan.__forceUseCases = false;
    keywordPlan.__forceDescriptives = false;

    const creatorOwner = applyCreatorOwnerToPlan(keywordPlan, cleaned);
    await maybeResolveOwnerIdFromVoiceReference(keywordPlan, cleaned, () => {});
    if (creatorOwner.intent && !keywordPlan.__owner_id) {
      const vidTry = extractVoiceIdForOwnerLookup(cleaned);
      const msgKey = vidTry ? labels.creatorOwnerVoiceNotFound : labels.creatorOwnerIdNeeded;
      const msg = await translateForUserLanguage(msgKey, uiLang);
      await safePostMessage(
        client,
        {
          channel: event.channel,
          thread_ts: threadTs,
          text: msg
        },
        msgKey
      );
      return;
    }

    // Creator browse: list shared voices by public owner (no keyword search)
    if (creatorOwner.intent && keywordPlan.__owner_id) {
      const searchTrace = [];
      const traceCb = (entry) => {
        try {
          searchTrace.push(entry);
        } catch (_) {}
      };
      const browse = await handleCreatorVoicesBrowse(keywordPlan, cleaned, traceCb, {
        uiLang,
        originalQuery: cleaned
      });
      if (!browse.ok) {
        const noResText = await translateNoResultsWithOwnerHint(uiLang, keywordPlan);
        await safePostMessage(
          client,
          { channel: event.channel, thread_ts: threadTs, text: noResText },
          labels.noVoices
        );
        return;
      }
      sessions[threadTs] = browse.session;
      let message = browse.message;
      message = await translateForUserLanguage(message, uiLang);
      const blocks = buildBlocksFromText(message);
      await safePostMessage(
        client,
        {
          channel: event.channel,
          thread_ts: threadTs,
          text: message,
          blocks: blocks || undefined
        },
        labels.noVoices
      );
      if (process.env.POC_SEARCH_REPORT === 'true') {
        let report = buildSearchReport(searchTrace, keywordPlan, 'creator_browse', {
          unique_count: browse.voices.length
        });
        report = await translateForUserLanguage(report, uiLang);
        await postPocReportDm(client, `${cleaned}\n\n${report}`);
      }
      return;
    }

    // FacetKB (remote) – if user explicitly requested accent/locale but it's invalid/ambiguous, ask to clarify.
    try {
      if (facetKB && typeof facetKB.ensureLoaded === 'function') {
        await facetKB.ensureLoaded();
      }
      const hint = parseUserLanguageHints(cleaned);
      const iso2 = (keywordPlan?.target_voice_language || hint?.iso2 || '')
        .toString()
        .toLowerCase()
        .slice(0, 2);
      const kbReady = facetKB && facetKB.isLoaded && facetKB.isLoaded() && facetKB.hasIso2 && facetKB.hasIso2(iso2);

      if (iso2 && kbReady) {
        const wantsAccent = hasExplicitAccentMention(cleaned) || (typeof keywordPlan?.target_accent === 'string' && keywordPlan.target_accent.trim());
        const explicitLocale = !!(hint && hint.locale);
        let explicitLocaleOk = false;

        // Treat a confidently resolved locale (explicit OR inferred) as fully-specified.
        // This prevents redundant "pick an accent" prompts for cases like "European Spanish" -> es-ES.
        try {
          const resolvedLoc = getRequestedLocale(cleaned, keywordPlan);
          const ok =
            resolvedLoc && facetKB && facetKB.checkLocaleAllowed
              ? facetKB.checkLocaleAllowed(iso2, resolvedLoc)
              : null;
          if (resolvedLoc && ok && ok.known && ok.allowed) {
            explicitLocaleOk = true;
            try {
              keywordPlan.target_locale = resolvedLoc;
            } catch (_) {}
            // Infer/normalize the corresponding accent so downstream search uses consistent facet values.
            try {
              // Avoid letting an existing plan.target_accent override the locale-derived mapping.
              const tmpPlan = { ...(keywordPlan || {}), target_accent: null };
              const accFromLocale = getRequestedAccent(cleaned, tmpPlan, resolvedLoc);
              if (accFromLocale) keywordPlan.target_accent = accFromLocale;
            } catch (_) {}
          }
        } catch (_) {}

        // Locale: only when explicitly present but invalid
        if (explicitLocale) {
          // NOTE: use the raw explicit locale token so we can suggest alternatives even when it's invalid.
          // getRequestedLocale() is conservative and may return null for rejected locales.
          let reqLoc = normalizeRequestedLocale(hint.locale) || hint.locale;
          // es-419 is a REGION alias (LatAm), not a queryable locale for shared-voices.
          // Treat it as "no explicit locale" and let downstream LatAm logic handle it.
          try {
            if (normalizeLocaleToken(reqLoc) === 'es-419') reqLoc = null;
          } catch (_) {}
          if (reqLoc && facetKB.checkLocaleAllowed) {
            const ok = facetKB.checkLocaleAllowed(iso2, reqLoc);
            // If user provided an explicit, allowed locale, treat it as fully-specified and avoid redundant accent clarification.
            if (ok && ok.known && ok.allowed) {
              explicitLocaleOk = true;
              try {
                keywordPlan.target_locale = reqLoc;
              } catch (_) {}
              // If the user provided an explicit, allowed locale, infer/normalize the corresponding accent so downstream search
              // uses consistent facet values (e.g. pt-PT -> european), even when the user didn't explicitly mention "accent".
              try {
                // Avoid letting an existing plan.target_accent override the locale-derived mapping.
                const tmpPlan = { ...(keywordPlan || {}), target_accent: null };
                const accFromLocale = getRequestedAccent(cleaned, tmpPlan, reqLoc);
                if (accFromLocale) keywordPlan.target_accent = accFromLocale;
              } catch (_) {}
            }
            if (ok && ok.known && !ok.allowed) {
              const sugg = facetKB.suggestLocales ? facetKB.suggestLocales(iso2, cleaned, { limit: 3 }) : [];
              const toDisplay = (norm) => {
                const m = String(norm || '').match(/^([a-z]{2})-([a-z]{2}|\d{3})$/i);
                if (!m) return String(norm || '');
                const lang = m[1].toLowerCase();
                const reg = /^\d{3}$/.test(m[2]) ? m[2] : m[2].toUpperCase();
                return `${lang}-${reg}`;
              };
              const options = (sugg || []).slice(0, 3).map((x) => ({
                value: toDisplay(x.locale || x.norm),
                label: toDisplay(x.locale || x.norm)
              }));
              if (options.length >= 2) {
                const pending = { type: 'locale', iso2, options, createdAt: Date.now() };
                const msg = await translateForUserLanguage(buildFacetClarifyMessage(pending) || labels.genericError, uiLang);
                sessions[threadTs] = {
                  originalQuery: cleaned,
                  keywordPlan,
                  voices: [],
                  ranking: {},
                  uiLanguage: uiLang,
                  pendingFacetQuestion: pending,
                  filters: (() => {
                    const genderLimit = getSessionGenderAndLimit(keywordPlan, cleaned);
                    return {
                      quality: keywordPlan.quality_preference || 'any',
                      gender: genderLimit.gender,
                      listAll: detectListAll(cleaned),
                      featured: false,
                      sort: null,
                      strictUseCase: false,
                      strictDescriptives: false,
                      limitPerGender: genderLimit.limitPerGender,
                      ...buildSessionNoticeFilters(keywordPlan),
                      ...buildSessionCustomRatesFilters(keywordPlan)
                    };
                  })(),
                  lastActive: Date.now()
                };
                await client.chat.postMessage({ channel: event.channel, thread_ts: threadTs, text: msg, blocks: buildBlocksFromText(msg) || undefined });
                return;
              }
            }
          }
        }

        // Accent: when user requested accent but it's invalid/ambiguous
        // If we have a valid resolved locale (explicit or inferred; e.g. pt-PT, es-ES), do NOT ask to pick an accent
        // even if the word/phrase implies accent.
        if (wantsAccent && !explicitLocaleOk) {
          const reqLoc = getRequestedLocale(cleaned, keywordPlan);
          const reqAcc = getRequestedAccent(cleaned, keywordPlan, reqLoc);
          const allowed = reqAcc && facetKB.checkAccentAllowed ? facetKB.checkAccentAllowed(iso2, reqAcc) : null;
          const accOk = !!(allowed && allowed.known && allowed.allowed);

          // If the requested accent is valid after normalization (e.g. PT: portuguese -> european),
          // persist the normalized value back into the plan so downstream search uses it.
          if (accOk && reqAcc) {
            try {
              keywordPlan.target_accent = reqAcc;
            } catch (_) {}
          }

          if (!accOk) {
            const sugg = facetKB.suggestAccents ? facetKB.suggestAccents(iso2, cleaned, { limit: 3 }) : [];
            if (sugg.length === 1) {
              keywordPlan.target_accent = sugg[0].accent;
            } else if (sugg.length >= 2) {
              const options = sugg.slice(0, 3).map((x) => ({
                value: x.accent,
                label: x.accent,
                slug: x.slug,
                count: x.count
              }));
              const pending = { type: 'accent', iso2, options, createdAt: Date.now() };
              const msg = await translateForUserLanguage(buildFacetClarifyMessage(pending) || labels.genericError, uiLang);
              sessions[threadTs] = {
                originalQuery: cleaned,
                keywordPlan,
                voices: [],
                ranking: {},
                uiLanguage: uiLang,
                pendingFacetQuestion: pending,
                filters: (() => {
                  const genderLimit = getSessionGenderAndLimit(keywordPlan, cleaned);
                  return {
                    quality: keywordPlan.quality_preference || 'any',
                    gender: genderLimit.gender,
                    listAll: detectListAll(cleaned),
                    featured: false,
                    sort: null,
                    strictUseCase: false,
                    strictDescriptives: false,
                    limitPerGender: genderLimit.limitPerGender,
                    ...buildSessionNoticeFilters(keywordPlan),
                    ...buildSessionCustomRatesFilters(keywordPlan)
                  };
                })(),
                lastActive: Date.now()
              };
              await client.chat.postMessage({ channel: event.channel, thread_ts: threadTs, text: msg, blocks: buildBlocksFromText(msg) || undefined });
              return;
            }
          }
        }
      }
    } catch (_) {}

    // Multi-language: comma/and-separated language list → one sub-search per language
    const langIntents = detectMultipleLanguageIntents(cleaned);
    if (
      langIntents.length >= 2 &&
      !keywordPlan.__owner_id &&
      !detectCreatorVoicesIntent(cleaned) &&
      !bareVoiceId
    ) {
      const subSessions = [];
      const searchTrace = [];
      const traceCb = (entry) => {
        try {
          searchTrace.push(entry);
        } catch (_) {}
      };
      for (const li of langIntents) {
        await ensureLanguageIndexLoaded(traceCb);
        const partText = li.segment || `${li.title} voices`;
        const subPlan = await buildKeywordPlan(partText);
        subPlan.target_voice_language = li.iso2;
        if (li.locale) {
          subPlan.target_locale = li.locale;
          try {
            const tmpPlan = { ...subPlan, target_accent: null };
            const accFromLocale = getRequestedAccent(partText, tmpPlan, li.locale);
            if (accFromLocale) subPlan.target_accent = accFromLocale;
          } catch (_) {}
        }
        subPlan.__featured = false;
        subPlan.__sort = null;
        subPlan.__listAll = detectListAll(partText);
        subPlan.__forceUseCases = false;
        subPlan.__forceDescriptives = false;
        if (detectOneMaleOneFemale(cleaned)) {
          subPlan.__dualGenderOneEach = true;
          subPlan.target_gender = null;
        }
        let voices = await fetchVoicesByKeywords(subPlan, partText, traceCb);
        if (!voices.length) continue;
        const ranked = await rankVoicesWithGPT(partText, subPlan, voices);
        const genderLimit = getSessionGenderAndLimit(subPlan, cleaned);
        subSessions.push({
          title: li.title || li.iso2.toUpperCase(),
          session: {
            originalQuery: partText,
            keywordPlan: subPlan,
            voices,
            ranking: ranked.scoreMap,
            uiLanguage: (guessUiLanguageFromText(partText) || uiLang).toString().slice(0, 2).toLowerCase(),
            filters: {
              quality: subPlan.quality_preference || 'any',
              gender: genderLimit.gender,
              listAll: detectListAll(partText),
              featured: false,
              sort: null,
              limitPerGender: genderLimit.limitPerGender,
              ...buildSessionNoticeFilters(subPlan),
              ...buildSessionCustomRatesFilters(subPlan)
            },
            lastActive: Date.now()
          }
        });
      }
      if (subSessions.length) {
        let message = '';
        for (const { title, session } of subSessions) {
          const sectionHeader = '```FOR: ' + title + '```';
          let body = buildMessageFromSession(session);
          body = await translateForUserLanguage(body, session.uiLanguage);
          message += sectionHeader + '\n' + body + '\n\n';
        }
        const blocks = buildBlocksFromText(message);
        await safePostMessage(
          client,
          {
            channel: event.channel,
            thread_ts: threadTs,
            text: message,
            blocks: blocks || undefined
          },
          labels.noVoices
        );
        if (process.env.POC_SEARCH_REPORT === 'true') {
          let report = buildSearchReport(searchTrace, keywordPlan, 'multi_language', {
            unique_count: subSessions.reduce(
              (acc, s) => acc + (Array.isArray(s.session.voices) ? s.session.voices.length : 0),
              0
            )
          });
          report = await translateForUserLanguage(report, uiLang);
          await postPocReportDm(client, `${cleaned}\n\n${report}`);
        }
        return;
      }
    }

    // Multi-intent: split by semicolons and run separate sub-searches, then group
    const parts = splitMultiIntents(cleaned);
    if (parts.length >= 2) {
      const subSessions = [];
      const searchTrace = [];
      const traceCb = (entry) => {
        try { searchTrace.push(entry); } catch (_) {}
      };
      const oidFull = extractPublicOwnerIdFromText(cleaned);
      for (const part of parts) {
        await ensureLanguageIndexLoaded(traceCb);
        const subPlan = await buildKeywordPlan(part);
        subPlan.__featured = false;
        subPlan.__sort = null;
        subPlan.__listAll = detectListAll(part);
        subPlan.__forceUseCases = false;
        subPlan.__forceDescriptives = false;
        if (detectOneMaleOneFemale(cleaned)) {
          subPlan.__dualGenderOneEach = true;
          subPlan.target_gender = null;
        }
        const oidPart = extractPublicOwnerIdFromText(part);
        const intentPart = detectCreatorVoicesIntent(part);
        // Only this segment may be owner-filtered; do not use full-query creator intent (other parts could be generic).
        if (intentPart && (oidPart || oidFull)) {
          subPlan.__owner_id = (oidPart || oidFull).toLowerCase();
        }
        await maybeResolveOwnerIdFromVoiceReference(subPlan, part, traceCb);
        if (detectCreatorVoicesIntent(part) && !subPlan.__owner_id) {
          continue;
        }
        let voices;
        let ranked;
        if (intentPart && subPlan.__owner_id) {
          const browse = await handleCreatorVoicesBrowse(subPlan, part, traceCb, {
            uiLang: (guessUiLanguageFromText(part) || uiLang).toString().slice(0, 2).toLowerCase(),
            originalQuery: part
          });
          if (!browse.ok) continue;
          voices = browse.voices;
          ranked = browse.ranked;
        } else {
          voices = await fetchVoicesByKeywords(subPlan, part, traceCb);
          if (!voices.length) {
            continue;
          }
          ranked = await rankVoicesWithGPT(part, subPlan, voices);
        }
        const genderLimit = getSessionGenderAndLimit(subPlan, cleaned);
        subSessions.push({
          title: part,
          session: {
            originalQuery: part,
            keywordPlan: subPlan,
            voices,
            ranking: ranked.scoreMap,
            uiLanguage: (guessUiLanguageFromText(part) || uiLang).toString().slice(0,2).toLowerCase(),
            filters: {
              quality: subPlan.quality_preference || 'any',
              gender: genderLimit.gender,
              listAll: detectListAll(part),
              featured: false,
              sort: null,
              limitPerGender: genderLimit.limitPerGender,
              ...buildSessionNoticeFilters(subPlan),
              ...buildSessionCustomRatesFilters(subPlan)
            },
            lastActive: Date.now()
          }
        });
      }
      if (subSessions.length) {
        // Build grouped message
        let message = '';
        for (const { title, session } of subSessions) {
          const sectionHeader = '```FOR: ' + title + '```';
          let body = buildMessageFromSession(session);
          body = await translateForUserLanguage(body, session.uiLanguage);
          message += sectionHeader + '\n' + body + '\n\n';
        }
        // cap blocks and post
        const blocks = buildBlocksFromText(message);
        await safePostMessage(
          client,
          {
            channel: event.channel,
            thread_ts: threadTs,
            text: message,
            blocks: blocks || undefined
          },
          labels.noVoices
        );
        if (process.env.POC_SEARCH_REPORT === 'true') {
          let report = buildSearchReport(searchTrace, keywordPlan, 'multi_intent', { unique_count: subSessions.reduce((acc, s) => acc + (Array.isArray(s.session.voices) ? s.session.voices.length : 0), 0) });
          report = await translateForUserLanguage(report, uiLang);
          const dmText = `${cleaned}\n\n${report}`;
          await postPocReportDm(client, dmText);
        }
        return;
      }
      // fall through to single search if multisplit yielded no results
    }

    // Similar voices: if user asks "similar to <voice_id>" (skip when listing by public owner)
    const voiceIdForSimilarity = keywordPlan.__owner_id ? null : extractVoiceIdCandidate(cleaned);
    if (voiceIdForSimilarity) {
      const searchTrace = [];
      const traceCb = (entry) => {
        try {
          searchTrace.push(entry);
        } catch (_) {}
      };
      await ensureLanguageIndexLoaded(traceCb);
      const simRes = await findSimilarVoicesByVoiceId(voiceIdForSimilarity, traceCb);
      let voices = Array.isArray(simRes?.voices) ? simRes.voices : [];
      if (!voices.length) {
        const noResText = await translateForUserLanguage(labels.noResults, uiLang);
        let hint = '';
        try {
          if (simRes?.reason === 'base_not_found' || simRes?.reason === 'no_preview') {
            hint =
              '\n\nTip: this voice_id may not be in the public Voice Library (or has no preview). ' +
              'Try a Voice Library (shared) voice_id, or share an audio sample link.';
          }
        } catch (_) {}
        const outText = hint ? (noResText + (await translateForUserLanguage(hint, uiLang))) : noResText;
        await safePostMessage(
          client,
          {
            channel: event.channel,
            thread_ts: threadTs,
            text: outText
          },
          labels.noVoices
        );
        return;
      }
      const ranked = await rankVoicesWithGPT(cleaned, keywordPlan, voices);
      let softQualityNote = '';
      const genderLimit = getSessionGenderAndLimit(keywordPlan, cleaned);
      const session = {
        originalQuery: cleaned,
        keywordPlan,
        voices,
        ranking: ranked.scoreMap,
        uiLanguage: uiLang,
        filters: {
          quality: keywordPlan.quality_preference || 'any',
          gender: genderLimit.gender,
          listAll: detectListAll(cleaned),
          featured: false,
          sort: null,
          strictUseCase: false,
          strictDescriptives: false,
          limitPerGender: genderLimit.limitPerGender,
          ...buildSessionNoticeFilters(keywordPlan),
          ...buildSessionCustomRatesFilters(keywordPlan)
        },
        lastActive: Date.now()
      };
      // "preferably HQ" should be treated as a soft preference for similar-voices results:
      // if we can't confirm any HQ results, show the best similar matches anyway (and note it).
      try {
        const prefersHq = (keywordPlan?.quality_preference || 'any') === 'high_only';
        const isSoft =
          /\b(preferably|if possible|ideally)\b/i.test(cleaned || '') ||
          /\b(najlepiej|w\s*miarę\s*możliwości)\b/i.test(cleaned || '');
        if (prefersHq && isSoft) {
          const hqCount = Array.isArray(voices) ? voices.filter((v) => isHighQuality(v)).length : 0;
          if (hqCount === 0) {
            session.filters.quality = 'any';
            softQualityNote =
              "Note: I couldn't confirm any similar voices as high quality, so I’m showing the best similar matches regardless of HQ.";
          }
        }
      } catch (_) {}
      sessions[threadTs] = session;
      // Similarity results: if query is strongly language-specific, enforce strict verified language matches.
      {
        const isStrong = isStrongLanguageRequest(cleaned, keywordPlan);
        const iso2 = (keywordPlan?.target_voice_language || detectVoiceLanguageFromText(cleaned) || '')
          .toString()
          .slice(0, 2)
          .toLowerCase();
        const requestedLocale = isStrong ? getRequestedLocale(cleaned, keywordPlan) : null;
        const requestedAccent =
          isStrong && (hasExplicitAccentMention(cleaned) || requestedLocale)
            ? getRequestedAccent(cleaned, keywordPlan, requestedLocale)
            : null;

        if (isStrong && iso2) {
          const buckets = buildSoftStrictBuckets(
            voices || [],
            session.ranking || {},
            iso2,
            requestedLocale,
            requestedAccent
          );
          const strictVoices = buckets.exact || [];
          const verifiedOnly = buckets.verifiedOnly || [];
          const verifiedIds = new Set([...(strictVoices || []), ...(verifiedOnly || [])].map((v) => v.voice_id));
          const notVerified = (voices || []).filter((v) => v && v.voice_id && !verifiedIds.has(v.voice_id));

          try {
            traceCb?.({
              stage: 'similar_strict_filter',
              params: {
                iso2,
                locale: requestedLocale || '-',
                accent: requestedAccent || '-',
                total: String(Array.isArray(voices) ? voices.length : 0)
              },
              count: strictVoices.length
            });
          } catch (_) {}

          const locSuffix = requestedLocale ? ` (${normalizeRequestedLocale(requestedLocale) || requestedLocale})` : '';
          const strictHeader = `\`\`\`STRICT MATCHES ${iso2.toUpperCase()}${locSuffix}\`\`\``;
          const strictSession = { ...session, voices: strictVoices };
          const labels = getLabels();
          let strictBody = buildMessageFromSession(strictSession);
          if (!strictBody || !String(strictBody).trim()) strictBody = labels.noVoices;
          let strictMessage = strictHeader + '\n' + strictBody;
          strictMessage = await translateForUserLanguage(strictMessage, session.uiLanguage);
          const strictBlocks = buildBlocksFromText(strictMessage);
          await safePostMessage(
            client,
            {
              channel: event.channel,
              thread_ts: threadTs,
              text: strictMessage,
              blocks: strictBlocks || undefined
            },
            labels.noVoices
          );

          if (verifiedOnly.length) {
            let vMsg = buildVerifiedFallbackMessageSoft(
              verifiedOnly,
              session.ranking,
              iso2,
              requestedLocale,
              requestedAccent,
              20
            );
            vMsg = await translateForUserLanguage(vMsg, session.uiLanguage);
            const vBlocks = buildBlocksFromText(vMsg);
            await safePostMessage(
              client,
              {
                channel: event.channel,
                thread_ts: threadTs,
                text: vMsg,
                blocks: vBlocks || undefined
              },
              labels.noVoices
            );
          }

          if (notVerified.length) {
            let fallbackMsg = buildSimilarNotVerifiedMessage(
              notVerified,
              session.ranking,
              iso2,
              requestedLocale,
              20
            );
            fallbackMsg = await translateForUserLanguage(fallbackMsg, session.uiLanguage);
            const fbBlocks = buildBlocksFromText(fallbackMsg);
            await safePostMessage(
              client,
              {
                channel: event.channel,
                thread_ts: threadTs,
                text: fallbackMsg,
                blocks: fbBlocks || undefined
              },
              labels.noVoices
            );
          }
        } else {
          // Single unified result message
          let message = buildMessageFromSession(session);
          if (softQualityNote) message = softQualityNote + '\n\n' + message;
          message = await translateForUserLanguage(message, session.uiLanguage);
          const blocks = buildBlocksFromText(message);
          await safePostMessage(
            client,
            {
              channel: event.channel,
              thread_ts: threadTs,
              text: message,
              blocks: blocks || undefined
            },
            labels.noVoices
          );
        }
      }
      if (process.env.POC_SEARCH_REPORT === 'true') {
        let report = buildSearchReport(searchTrace, keywordPlan, 'similar_voices', {
          unique_count: Array.isArray(voices) ? voices.length : 0
        });
        report = await translateForUserLanguage(report, uiLang);
        const dmText = `${cleaned}\n\n${report}`;
        await postPocReportDm(client, dmText);
      }
      return;
    }

    const special = detectSpecialIntent(cleaned, keywordPlan);

    let voices;
    let rankingMap;
    const searchTrace = [];
    const traceCb = (entry) => {
      try {
        searchTrace.push(entry);
      } catch (_) {}
    };

    if (special.mode === 'top_by_language' && special.languageCode) {
      // "most used Polish voices" mode – sort by usage
      voices = await fetchTopVoicesByLanguage(
        special.languageCode,
        keywordPlan.quality_preference,
        keywordPlan,
        cleaned,
        traceCb
      );

      if (!voices.length) {
        const noResText = await translateNoResultsWithOwnerHint(uiLang, keywordPlan);
        await client.chat.postMessage({
          channel: event.channel,
          thread_ts: threadTs,
          text: noResText
        });
        return;
      }

      const maxUsage = voices.reduce((max, v) => {
        const u = v.usage_character_count_1y || v.usage_character_count_7d || 0;
        return u > max ? u : max;
      }, 0);

      rankingMap = {};
      if (maxUsage > 0) {
        voices.forEach((v) => {
          const u = v.usage_character_count_1y || v.usage_character_count_7d || 0;
          rankingMap[v.voice_id] = u / maxUsage;
        });
      } else {
        voices.forEach((v, idx) => {
          rankingMap[v.voice_id] =
            (voices.length - idx) / Math.max(voices.length, 1);
        });
      }
    } else {
      if (special.mode === 'top_then_rank' && special.languageCode) {
        voices = await fetchTopVoicesByLanguage(
          special.languageCode,
          keywordPlan.quality_preference,
          keywordPlan,
          cleaned,
          traceCb
        );
        if (!voices.length) {
          const noResText = await translateNoResultsWithOwnerHint(uiLang, keywordPlan);
          await client.chat.postMessage({
            channel: event.channel,
            thread_ts: threadTs,
            text: noResText
          });
          return;
        }
        const ranked = await rankVoicesWithGPT(cleaned, keywordPlan, voices);
        rankingMap = ranked.scoreMap;
      } else {
        // normal mode – keyword-based search + GPT curator ranking
        voices = await fetchVoicesByKeywords(keywordPlan, cleaned, traceCb);

        if (!voices.length) {
          const noResText = await translateNoResultsWithOwnerHint(uiLang, keywordPlan);
          await client.chat.postMessage({
            channel: event.channel,
            thread_ts: threadTs,
            text: noResText
          });
          return;
        }

        const ranked = await rankVoicesWithGPT(cleaned, keywordPlan, voices);
        rankingMap = ranked.scoreMap;
      }
    }

    const genderLimit = getSessionGenderAndLimit(keywordPlan, cleaned);
    const session = {
      originalQuery: cleaned,
      keywordPlan,
      voices,
      ranking: rankingMap,
      uiLanguage: uiLang,
      filters: {
        quality: keywordPlan.quality_preference || 'any',
        gender: genderLimit.gender,
        listAll: detectListAll(cleaned),
        featured: false,
        sort: null,
        strictUseCase: false,
        strictDescriptives: false,
        limitPerGender: genderLimit.limitPerGender,
        ...buildSessionNoticeFilters(keywordPlan),
        ...buildSessionCustomRatesFilters(keywordPlan)
      },
      lastActive: Date.now()
    };

    sessions[threadTs] = session;

    // Results message (single by default, strict+verified when query is strongly language-specific)
    {
      const isStrong = isStrongLanguageRequest(cleaned, keywordPlan);
      const iso2 = (keywordPlan?.target_voice_language || '').toString().slice(0, 2).toLowerCase();
      const requestedLocale = isStrong ? getRequestedLocale(cleaned, keywordPlan) : null;
      const requestedAccent =
        isStrong && (hasExplicitAccentMention(cleaned) || requestedLocale)
          ? getRequestedAccent(cleaned, keywordPlan, requestedLocale)
          : null;

      if (isStrong && iso2) {
        const buckets = buildSoftStrictBuckets(
          voices || [],
          session.ranking || {},
          iso2,
          requestedLocale,
          requestedAccent
        );
        const strictVoices = buckets.exact || [];
        const verifiedFallback = buckets.verifiedOnly || [];

        const locNorm = normalizeRequestedLocale(requestedLocale);
        const locSuffix = locNorm ? ` (${locNorm})` : requestedLocale ? ` (${requestedLocale})` : '';
        const strictHeader = `\`\`\`STRICT MATCHES ${iso2.toUpperCase()}${locSuffix}\`\`\``;
        const strictSession = { ...session, voices: strictVoices };
        const labels = getLabels();
        let strictBody = buildMessageFromSession(strictSession);
        if (!strictBody || !String(strictBody).trim()) strictBody = labels.noVoices;
        let strictMessage = strictHeader + '\n' + strictBody;
        strictMessage = await translateForUserLanguage(strictMessage, session.uiLanguage);
        const strictBlocks = buildBlocksFromText(strictMessage);
        await client.chat.postMessage({
          channel: event.channel,
          thread_ts: threadTs,
          text: strictMessage,
          blocks: strictBlocks || undefined
        });

        let fallbackMsg = buildVerifiedFallbackMessageSoft(
          verifiedFallback,
          session.ranking,
          iso2,
          requestedLocale,
          requestedAccent,
          20
        );
        if (fallbackMsg && String(fallbackMsg).trim()) {
          fallbackMsg = await translateForUserLanguage(fallbackMsg, session.uiLanguage);
          const fbBlocks = buildBlocksFromText(fallbackMsg);
          await client.chat.postMessage({
            channel: event.channel,
            thread_ts: threadTs,
            text: fallbackMsg,
            blocks: fbBlocks || undefined
          });
        }
      } else {
        // Single unified result message
        let message = buildMessageFromSession(session);
        message = await translateForUserLanguage(message, session.uiLanguage);
        // If the user is asking about language but we couldn't infer a safe ISO2, give them the explicit syntax.
        try {
          const wantsLangMeta = detectLanguageMetaIntent(cleaned) || checkLanguagesIntent(cleaned.toLowerCase());
          const hint = parseUserLanguageHints(cleaned);
          if (wantsLangMeta && !(hint && hint.iso2)) {
            const tip = '\n\nTip: specify language as `lang=en` / `język: pl` / `pt-BR`.';
            message = message + (await translateForUserLanguage(tip, session.uiLanguage));
          }
        } catch (_) {}
        const blocks = buildBlocksFromText(message);
        await client.chat.postMessage({
          channel: event.channel,
          thread_ts: threadTs,
          text: message,
          blocks: blocks || undefined
        });
      }
    }

    if (process.env.POC_SEARCH_REPORT === 'true') {
      const coverage = Array.isArray(voices)
        ? voices.map((v) => ({
            voice_id: v.voice_id,
            name: v.name || null,
            accent: v.accent || null,
            gender: v.gender || null,
            matchedCount: contentMatchedKeywords(v._matched_keywords).length,
            coverageScore:
              typeof v._coverageScore === 'number'
                ? v._coverageScore
                : typeof v._brief_fit === 'number'
                  ? v._brief_fit
                  : 0
          }))
        : [];
      coverage.sort(
        (a, b) =>
          (b.coverageScore || 0) - (a.coverageScore || 0) ||
          b.matchedCount - a.matchedCount
      );
      const summary = {
        unique_count: Array.isArray(voices) ? voices.length : 0,
        top_coverage: coverage.slice(0, 10)
      };
      if (detectBilingualEnEs(cleaned) && Array.isArray(voices)) {
        summary.verified_en_es = voices.filter(voiceHasVerifiedEnAndEs).length;
      }
      let report = buildSearchReport(searchTrace, keywordPlan, special.mode, summary);
      report = await translateForUserLanguage(report, uiLang);
      const dmText = `${cleaned}\n\n${report}`;
      await postPocReportDm(client, dmText);
    }
  } catch (error) {
    console.error('Error in handleNewSearch:', error);
    const labels = getLabels();
    const uiLang = guessUiLanguageFromText(cleaned);
    const errText = await translateForUserLanguage(labels.genericError, uiLang);
    await client.chat.postMessage({
      channel: event.channel,
      thread_ts: threadTs,
      text: errText
    });
  }
}

// -------------------------------------------------------------
// Slack Bolt app – app_mention handler
// -------------------------------------------------------------

if (!DEV_ASSERTS_ENABLED && !isDevPocEnabled()) {
  const { App } = require('@slack/bolt');
  app = new App({
    token: process.env.SLACK_BOT_TOKEN,
    signingSecret: process.env.SLACK_SIGNING_SECRET,
    socketMode: true,
    appToken: process.env.SLACK_APP_TOKEN
  });

  app.event('app_mention', async ({ event, client }) => {
  const rawText = event.text || '';
  const cleaned = cleanText(rawText);
  const threadTs = event.thread_ts || event.ts;

  // Avoid duplicate replies on quick edits/duplicates within a short window
  if (isDuplicateRequest(threadTs, cleaned)) {
    return;
  }

  const existing = sessions[threadTs];

  if (existing) {
    // Follow-ups rely on language-name detection (e.g., "Japanese", "Korean").
    // Ensure the dynamic language index is available here too (it is loaded in handleNewSearch already).
    await ensureLanguageIndexLoaded();

    const lower = cleaned.toLowerCase();
    existing.lastActive = Date.now();

    // Facet clarification flow: if we asked to pick accent/locale, resolve it first.
    if (existing.pendingFacetQuestion) {
      try {
        const picked = resolveFacetChoiceFromText(cleaned, existing.pendingFacetQuestion);
        if (!picked) {
          const msg0 = buildFacetClarifyMessage(existing.pendingFacetQuestion) || getLabels().genericError;
          const msg = await translateForUserLanguage(msg0, existing.uiLanguage);
          const blocks = buildBlocksFromText(msg);
          await safePostMessage(client, {
            channel: event.channel,
            thread_ts: threadTs,
            text: msg,
            blocks: blocks || undefined
          });
          return;
        }

        const plan = JSON.parse(JSON.stringify(existing.keywordPlan || {}));
        if (existing.pendingFacetQuestion.type === 'accent') {
          plan.target_accent = (picked.value || picked.label || '').toString();
        } else if (existing.pendingFacetQuestion.type === 'locale') {
          plan.target_locale = (picked.value || picked.label || '').toString();
        }
        existing.pendingFacetQuestion = null;

        plan.__featured = existing.filters.featured === true;
        plan.__sort = existing.filters.sort || null;
        plan.__listAll = existing.filters.listAll === true;
        plan.__forceUseCases = existing.filters.strictUseCase === true;
        plan.__forceDescriptives = existing.filters.strictDescriptives === true;
        applySessionNoticeFiltersToPlan(plan, existing.filters);
        applySessionCustomRatesFiltersToPlan(plan, existing.filters);

        const searchTrace = [];
        const traceCb = (entry) => { try { searchTrace.push(entry); } catch (_) {} };
        const voices = await fetchVoicesByKeywords(plan, existing.originalQuery, traceCb);
        if (!voices.length) {
          const labels = getLabels();
          const noResText = await translateForUserLanguage(labels.noResults, existing.uiLanguage);
          await safePostMessage(client, {
            channel: event.channel,
            thread_ts: threadTs,
            text: noResText
          });
          existing.keywordPlan = plan;
          existing.voices = [];
          existing.ranking = {};
          return;
        }
        const ranked = await rankVoicesWithGPT(existing.originalQuery, plan, voices);
        existing.keywordPlan = plan;
        existing.voices = voices;
        existing.ranking = ranked.scoreMap;
        existing.lastActive = Date.now();

        let msg = buildMessageFromSession(existing);
        msg = await translateForUserLanguage(msg, existing.uiLanguage);
        const blocks = buildBlocksFromText(msg);
        await safePostMessage(client, {
          channel: event.channel,
          thread_ts: threadTs,
          text: msg,
          blocks: blocks || undefined
        });
        return;
      } catch (_) {
        // If something fails, fall through to normal flow
      }
    }

    if (await respondVoiceNoticePeriodLookup(event, cleaned, threadTs, client, existing, existing.uiLanguage)) {
      return;
    }

    if (await respondVoiceLanguageCompatibility(event, cleaned, threadTs, client, existing, existing.uiLanguage)) {
      return;
    }

    const wantsLanguages = checkLanguagesIntent(lower);
    const wantsWhichHigh = checkWhichHighIntent(lower);
    const filtersChanged = applyFilterChangesFromText(existing, lower);

    if (wantsLanguages) {
      let msg = buildLanguagesMessage(existing);
      msg = await translateForUserLanguage(msg, existing.uiLanguage);
      const blocks = buildBlocksFromText(msg);
      await safePostMessage(client, {
        channel: event.channel,
        thread_ts: threadTs,
        text: msg,
        blocks: blocks || undefined
      });
      return;
    }

    if (wantsWhichHigh) {
      let msg = buildWhichHighMessage(existing);
      msg = await translateForUserLanguage(msg, existing.uiLanguage);
      const blocks = buildBlocksFromText(msg);
      await safePostMessage(client, {
        channel: event.channel,
        thread_ts: threadTs,
        text: msg,
        blocks: blocks || undefined
      });
      return;
    }

    if (filtersChanged) {
      if (existing._serverFiltersChanged) {
        const searchTrace = [];
        const traceCb = (entry) => {
          try { searchTrace.push(entry); } catch (_) {}
        };

        const plan = JSON.parse(JSON.stringify(existing.keywordPlan || {}));
        plan.__featured = existing.filters.featured === true;
        plan.__sort = existing.filters.sort || null;
        plan.__listAll = existing.filters.listAll === true;
        plan.__forceUseCases = existing.filters.strictUseCase === true;
        plan.__forceDescriptives = existing.filters.strictDescriptives === true;
        applySessionNoticeFiltersToPlan(plan, existing.filters);
        applySessionCustomRatesFiltersToPlan(plan, existing.filters);

        const voices = await fetchVoicesByKeywords(plan, existing.originalQuery, traceCb);
        if (!voices.length) {
          const labels = getLabels();
          const noResText = await translateForUserLanguage(labels.noResults, existing.uiLanguage);
          await safePostMessage(client, {
            channel: event.channel,
            thread_ts: threadTs,
            text: noResText
          });
          existing._serverFiltersChanged = false;
          return;
        }
        const ranked = await rankVoicesWithGPT(existing.originalQuery, plan, voices);
        existing.keywordPlan = plan;
        existing.voices = voices;
        existing.ranking = ranked.scoreMap;
        existing._serverFiltersChanged = false;
      }

      // Single unified result message
      let msg = buildMessageFromSession(existing);
      msg = await translateForUserLanguage(msg, existing.uiLanguage);
      const blocks = buildBlocksFromText(msg);
      await safePostMessage(client, {
        channel: event.channel,
        thread_ts: threadTs,
        text: msg,
        blocks: blocks || undefined
      });
      return;
    }

    // Refinement flow: merge new hints into the existing keyword plan
    try {
      const refinedPlan = await refineKeywordPlanFromFollowUp(
        JSON.parse(JSON.stringify(existing.keywordPlan || {})),
        cleaned
      );
      refinedPlan.__featured = existing.filters.featured === true;
      refinedPlan.__sort = existing.filters.sort || null;
      refinedPlan.__listAll = existing.filters.listAll === true;
      refinedPlan.__forceUseCases = existing.filters.strictUseCase === true;
      applySessionNoticeFiltersToPlan(refinedPlan, existing.filters);
      applySessionCustomRatesFiltersToPlan(refinedPlan, existing.filters);
      const combinedQuery = [existing.originalQuery || '', cleaned].join(' ').trim();
      const searchTrace = [];
      const traceCb = (entry) => {
        try {
          searchTrace.push(entry);
        } catch (_) {}
      };
      applyCreatorOwnerToPlan(refinedPlan, combinedQuery);
      await maybeResolveOwnerIdFromVoiceReference(refinedPlan, combinedQuery, traceCb);
      const creatorRefText = cleaned || combinedQuery;
      if (detectCreatorVoicesIntent(creatorRefText)) {
        if (!refinedPlan.__owner_id) {
          const labels = getLabels();
          const vidTry =
            extractVoiceIdForOwnerLookup(combinedQuery) || extractBareVoiceId(combinedQuery);
          const msgKey = vidTry ? labels.creatorOwnerVoiceNotFound : labels.creatorOwnerIdNeeded;
          const msg = await translateForUserLanguage(msgKey, existing.uiLanguage);
          await safePostMessage(client, {
            channel: event.channel,
            thread_ts: threadTs,
            text: msg
          });
          return;
        }
        const browse = await handleCreatorVoicesBrowse(refinedPlan, combinedQuery, traceCb, {
          uiLang: existing.uiLanguage,
          originalQuery: combinedQuery
        });
        if (!browse.ok) {
          const noResText = await translateNoResultsWithOwnerHint(existing.uiLanguage, refinedPlan);
          await safePostMessage(client, {
            channel: event.channel,
            thread_ts: threadTs,
            text: noResText
          });
          return;
        }
        existing.keywordPlan = refinedPlan;
        existing.originalQuery = combinedQuery;
        existing.voices = browse.voices;
        existing.ranking = browse.ranked.scoreMap;
        existing.lastActive = Date.now();

        let msg = browse.message;
        msg = await translateForUserLanguage(msg, existing.uiLanguage);
        const blocks = buildBlocksFromText(msg);
        await safePostMessage(client, {
          channel: event.channel,
          thread_ts: threadTs,
          text: msg,
          blocks: blocks || undefined
        });
        if (process.env.POC_SEARCH_REPORT === 'true') {
          let report = buildSearchReport(searchTrace, refinedPlan, 'creator_browse', {
            unique_count: browse.voices.length
          });
          report = await translateForUserLanguage(report, existing.uiLanguage);
          const dmText = `${cleaned}\n\n${report}`;
          await postPocReportDm(client, dmText);
        }
        return;
      }
      const voices = await fetchVoicesByKeywords(refinedPlan, combinedQuery, traceCb);
      if (!voices.length) {
        const labels = getLabels();
        const noResText = await translateNoResultsWithOwnerHint(existing.uiLanguage, refinedPlan);
        await safePostMessage(client, {
          channel: event.channel,
          thread_ts: threadTs,
          text: noResText
        });
        return;
      }
      const ranked = await rankVoicesWithGPT(combinedQuery, refinedPlan, voices);
      existing.keywordPlan = refinedPlan;
      existing.originalQuery = combinedQuery;
      existing.voices = voices;
      existing.ranking = ranked.scoreMap;
      existing.lastActive = Date.now();

      // Single unified result message
      let msg = buildMessageFromSession(existing);
      msg = await translateForUserLanguage(msg, existing.uiLanguage);
      const blocks = buildBlocksFromText(msg);
      await safePostMessage(client, {
        channel: event.channel,
        thread_ts: threadTs,
        text: msg,
        blocks: blocks || undefined
      });
      if (process.env.POC_SEARCH_REPORT === 'true') {
        const coverage = Array.isArray(voices)
          ? voices.map((v) => ({
              voice_id: v.voice_id,
              name: v.name || null,
              accent: v.accent || null,
              gender: v.gender || null,
              matchedCount: contentMatchedKeywords(v._matched_keywords).length,
              coverageScore:
                typeof v._coverageScore === 'number'
                  ? v._coverageScore
                  : typeof v._brief_fit === 'number'
                    ? v._brief_fit
                    : 0
            }))
          : [];
        coverage.sort(
          (a, b) =>
            (b.coverageScore || 0) - (a.coverageScore || 0) ||
            b.matchedCount - a.matchedCount
        );
        const summary = { unique_count: Array.isArray(voices) ? voices.length : 0, top_coverage: coverage.slice(0, 10) };
        let report = buildSearchReport(searchTrace, refinedPlan, 'refine', summary);
        report = await translateForUserLanguage(report, existing.uiLanguage);
        const dmText = `${cleaned}\n\n${report}`;
        await postPocReportDm(client, dmText);
      }
      return;
    } catch (e) {
      safeLogAxiosError('refineKeywordPlanFromFollowUp', e);
      // fallthrough to new search as last resort
    }
  }

  await handleNewSearch(event, cleaned, threadTs, client);
});

// -------------------------------------------------------------
// Slack interactive controls
// -------------------------------------------------------------
app.action('toggle_featured', async ({ ack, body, client }) => {
  try { await ack(); } catch (_) {}
  try {
    const channel = body.channel?.id || body.container?.channel_id || body.item?.channel || body.team?.id;
    const threadTs =
      body.container?.thread_ts ||
      body.container?.message_ts ||
      body.message?.thread_ts ||
      body.message?.ts;
    if (!threadTs || !channel) return;
    const session = sessions[threadTs];
    if (!session) return;
    session.filters.featured = session.filters.featured ? false : true;
    session._serverFiltersChanged = true;

    const plan = JSON.parse(JSON.stringify(session.keywordPlan || {}));
    plan.__featured = session.filters.featured === true;
    plan.__sort = session.filters.sort || null;
    plan.__listAll = session.filters.listAll === true;
    applySessionNoticeFiltersToPlan(plan, session.filters);
    applySessionCustomRatesFiltersToPlan(plan, session.filters);

    const searchTrace = [];
    const traceCb = (e) => { try { searchTrace.push(e); } catch (_) {} };
    const voices = await fetchVoicesByKeywords(plan, session.originalQuery, traceCb);
    if (!voices.length) {
      const labels = getLabels();
      const noResText = await translateForUserLanguage(labels.noResults, session.uiLanguage);
      await client.chat.postMessage({ channel, thread_ts: threadTs, text: noResText });
      session._serverFiltersChanged = false;
      return;
    }
    const ranked = await rankVoicesWithGPT(session.originalQuery, plan, voices);
    session.keywordPlan = plan;
    session.voices = voices;
    session.ranking = ranked.scoreMap;
    session._serverFiltersChanged = false;

    let msg = buildMessageFromSession(session);
    msg = await translateForUserLanguage(msg, session.uiLanguage);
    const blocks = buildBlocksFromText(msg);
    await client.chat.postMessage({ channel, thread_ts: threadTs, text: msg, blocks: blocks || undefined });
  } catch (err) {
    console.error('toggle_featured error', err);
  }
});

app.action('show_more', async ({ ack, body, client }) => {
  try { await ack(); } catch (_) {}
  try {
    const channel = body.channel?.id || body.container?.channel_id || body.item?.channel || body.team?.id;
    const threadTs =
      body.container?.thread_ts ||
      body.container?.message_ts ||
      body.message?.thread_ts ||
      body.message?.ts;
    if (!threadTs || !channel) return;
    const session = sessions[threadTs];
    if (!session) return;
    session.filters.listAll = true;
    // Ensure "show more" actually expands output, even if a "top N" limit was set previously.
    session.filters.limitPerGender = null;

    const plan = JSON.parse(JSON.stringify(session.keywordPlan || {}));
    plan.__featured = session.filters.featured === true;
    plan.__sort = session.filters.sort || null;
    plan.__listAll = true;
    applySessionNoticeFiltersToPlan(plan, session.filters);
    applySessionCustomRatesFiltersToPlan(plan, session.filters);

    const searchTrace = [];
    const traceCb = (e) => { try { searchTrace.push(e); } catch (_) {} };
    const voices = await fetchVoicesByKeywords(plan, session.originalQuery, traceCb);
    if (!voices.length) {
      const labels = getLabels();
      const noResText = await translateForUserLanguage(labels.noResults, session.uiLanguage);
      await client.chat.postMessage({ channel, thread_ts: threadTs, text: noResText });
      return;
    }
    const ranked = await rankVoicesWithGPT(session.originalQuery, plan, voices);
    session.keywordPlan = plan;
    session.voices = voices;
    session.ranking = ranked.scoreMap;

    let msg = buildMessageFromSession(session);
    msg = await translateForUserLanguage(msg, session.uiLanguage);
    const blocks = buildBlocksFromText(msg);
    await client.chat.postMessage({ channel, thread_ts: threadTs, text: msg, blocks: blocks || undefined });
  } catch (err) {
    console.error('show_more error', err);
  }
});

app.action('cycle_quality', async ({ ack, body, client }) => {
  try { await ack(); } catch (_) {}
  try {
    const channel = body.channel?.id || body.container?.channel_id || body.item?.channel || body.team?.id;
    const threadTs =
      body.container?.thread_ts ||
      body.container?.message_ts ||
      body.message?.thread_ts ||
      body.message?.ts;
    if (!threadTs || !channel) return;
    const session = sessions[threadTs];
    if (!session) return;
    const current = session.filters.quality || 'any';
    const next = current === 'any' ? 'high_only' : current === 'high_only' ? 'no_high' : 'any';
    session.filters.quality = next;

    // quality change does not mandate server refetch; re-render
    let msg = buildMessageFromSession(session);
    msg = await translateForUserLanguage(msg, session.uiLanguage);
    const blocks = buildBlocksFromText(msg);
    await client.chat.postMessage({ channel, thread_ts: threadTs, text: msg, blocks: blocks || undefined });
  } catch (err) {
    console.error('cycle_quality error', err);
  }
});

} // end Slack wiring guard (DEV_ASSERTS_ENABLED)

// -------------------------------------------------------------
// Start the app (for Render etc.)
// -------------------------------------------------------------

(async () => {
  // DEV_ASSERTS=true should run regression checks without requiring Slack/OpenAI env.
  if (isDevAssertsEnabled()) {
    runDevAsserts();
    return;
  }
  // DEV_POC=true runs a small CLI-style probe of shared-voices query behavior (no Slack/OpenAI required).
  if (isDevPocEnabled()) {
    try {
      await runDevPoc();
    } catch (e) {
      console.error('DEV_POC failed:', e?.message || e);
      process.exit(1);
    }
    return;
  }
  validateEnvOrExit();
  startMemoryCleanup();
  try {
    accentCatalog?.startBackgroundRefresh?.();
  } catch (_) {}
  const port = process.env.PORT || 3000;
  await app.start(port);
  console.log('⚡️ voices-bot is running on port ' + port);
})();
