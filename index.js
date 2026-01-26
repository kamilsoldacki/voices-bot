const { App } = require('@slack/bolt');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');

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
// Default path points to ../accents_all.json so this works when index.js lives in ~/Downloads
// and accents_all.json lives in ~/
const DEFAULT_ACCENTS_JSON_PATH = path.resolve(__dirname, '../accents_all.json');

function normalizeCatalogToken(s) {
  return (s || '')
    .toString()
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/_/g, '-');
}

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
    return { known: true, allowed: this.allowedAccentsByIso2.get(k).has(a) };
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
    return m ? m.get(a) || null : null;
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
    const tokens = dedupePreserveOrder(
      lower
        .replace(/[^\p{L}\p{N}\s\-]/gu, ' ')
        .split(/\s+/g)
        .map((t) => t.trim())
        .filter(Boolean)
    );

    // 1) direct contains match for any token (e.g., "standard" -> ["standard", "modern standard"])
    const direct = [];
    const seen = new Set();
    for (const t of tokens) {
      if (t.length < 4) continue;
      for (const cand of top) {
        if (!cand?.accent) continue;
        if (cand.accent.includes(t)) {
          const key = cand.norm;
          if (!seen.has(key)) {
            seen.add(key);
            direct.push(cand);
          }
        }
      }
      if (direct.length >= 12) break;
    }
    direct.sort((a, b) => (b.count || 0) - (a.count || 0));
    if (direct.length >= 2) return direct.slice(0, Math.max(2, Math.min(6, limit)));

    // 2) fuzzy: try closest among candidate strings for longer tokens
    try {
      const candidates = top.map((x) => x.accent).filter(Boolean);
      let best = [];
      for (const tok of tokens) {
        if (tok.length < 5) continue;
        const maxDist = maxTypoDistanceForToken(tok);
        const sugg = suggestClosest(tok, candidates, { maxDist, maxSuggestions: 3 });
        for (const s of sugg) {
          const norm = normalizeCatalogToken(s);
          const found = top.find((x) => x.norm === norm);
          if (found) best.push(found);
        }
      }
      best = dedupePreserveOrder(best.map((x) => x.norm)).map((n) => top.find((x) => x.norm === n)).filter(Boolean);
      best.sort((a, b) => (b.count || 0) - (a.count || 0));
      if (best.length) return best.slice(0, Math.max(2, Math.min(6, limit)));
    } catch (_) {}

    // 3) popularity fallback
    return top.slice(0, Math.max(2, Math.min(6, limit)));
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
  ['brazilian portuguese', 'pt']
]);

// Fallback allowlist for ISO639-1 codes when the dynamic language index isn't loaded.
// This prevents false positives like "to" being interpreted as a language code.
const FALLBACK_ISO2_ALLOWLIST = new Set([
  'en','pl','es','de','fr','it','pt','nl','sv','no','da','fi','cs','sk','hu','ro','bg','el','tr',
  'ar','he','hi','ja','ko','zh','id','ms','th','vi','uk','ru'
]);

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
  ['american', 'american'],
  ['uk', 'british'],
  ['british', 'british'],
  ['english (uk)', 'british'],
  ['australian', 'australian'],
  ['canadian', 'canadian'],
  ['irish', 'irish'],
  ['scottish', 'scottish'],
  // Spanish
  ['mexican', 'mexican'],
  ['latin american', 'latin american'],
  ['latam', 'latin american'],
  ['castilian', 'castilian'],
  ['spain', 'castilian'],
  // Portuguese
  ['brazil', 'brazilian'],
  ['br', 'brazilian'],
  ['brazilian', 'brazilian'],
  ['portugal', 'portuguese'],
  ['european portuguese', 'portuguese'],
  ['portuguese', 'portuguese']
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
    if (lower.includes(name)) {
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
    if (lower.includes(alias)) {
      let locale = null;
      if (iso2 === 'pt' && /\b(brazil|brasil|brazilian|brasile)\b/.test(lower)) locale = 'pt-BR';
      return { iso2, locale, explicit: true, reason: 'static_alias' };
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

async function httpPostWithRetry(url, data, config) {
  return withRetry(async () => {
    const res = await axios.post(url, data, config);
    return res;
  });
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
    const msg =
      err?.response?.data?.error?.message ||
      err?.message ||
      (typeof err === 'string' ? err : 'Unknown error');
    const rid =
      err?.response?.headers?.['x-request-id'] ||
      err?.response?.headers?.['x-openai-request-id'];
    console.error(
      `[${context}] ${status || ''} ${statusText || ''} ${msg}${
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

function filterKeywordsGlobally(userText, keywords) {
  const out = [];
  const seen = new Set();
  const lower = (userText || '').toLowerCase();
  const isCommercialIntent = /\b(commercial|advertising|ad|promo|promotion|brand|campaign)\b/.test(lower);
  const isPodcastIntent = /\b(podcast|broadcaster|radio|host)\b/.test(lower);
  const whitelistCommercial = new Set(['commercial','advertising','ad','ads','promo','promotion','marketing','brand','branding','campaign']);
  for (let kw of keywords) {
    const k = normalizeKw(kw);
    if (!k) continue;
    if (k.length < 3 && !SHORT_WHITELIST.has(k) && !explicitlyMentionedInText(k, userText)) {
      continue;
    }
    if (isGenericNoiseKeyword(k) && !explicitlyMentionedInText(k, userText)) {
      // allow commercial/podcast tokens when those intents are active
      if (isCommercialIntent && whitelistCommercial.has(k)) {
        // keep
      } else if (isPodcastIntent && (k === 'podcast' || k === 'radio' || k === 'host')) {
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
    else if (/\b(latam|latin america|latinamerican|es-419)\b/.test(lower)) candidate = 'es-419';
    else if (/\b(latino|latin(?:o)? american|south american|central american|caribbean)\b/.test(lower) && /\b(spanish|es)\b/.test(lower)) {
      candidate = 'es-419';
    } else if (/\b(european)\b/.test(lower) && /\b(spanish|es)\b/.test(lower)) candidate = 'es-ES';
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

function hasExplicitAccentMention(userText) {
  const lower = (userText || '').toString().toLowerCase();
  if (/\b(accent|akcent)\b/.test(lower)) return true;
  // Common implicit accent phrases (no explicit "accent" word)
  const implicit = [
    'general american',
    'standard american',
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
    'pt-pt'
  ];
  return implicit.some((t) => lower.includes(t));
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
        out.isSpecific = true;
        out.axis = 'locale';
        out.requestedFacetKeys = [key];
        out.fallbackFacetKeys = [];
        return out;
      }
    }

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

    // 3) region markers for common languages -> locale specificity
    if (lang === 'pt') {
      if (/\b(brazil|brasil|brazilian|brasile|pt-br)\b/.test(lower)) {
        out.isSpecific = true;
        out.axis = 'locale';
        out.requestedFacetKeys = ['pt-br'];
        out.fallbackFacetKeys = [];
        return out;
      }
      if (/\b(portugal|pt-pt|pt-eu|european)\b/.test(lower)) {
        out.isSpecific = true;
        out.axis = 'locale';
        out.requestedFacetKeys = ['pt-pt'];
        out.fallbackFacetKeys = [];
        return out;
      }
    }
    if (lang === 'es') {
      if (/\b(es-419|latam|latin america|latinamerican|latino|south american|central american|caribbean)\b/.test(lower)) {
        out.isSpecific = true;
        out.axis = 'locale';
        out.requestedFacetKeys = ['es-419'];
        out.fallbackFacetKeys = [];
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
    if (lang === 'fr') {
      if (/\b(fr-ca|quebec|québec|canadian french|french canadian|qc)\b/.test(lower)) {
        out.isSpecific = true;
        out.axis = 'locale';
        out.requestedFacetKeys = ['fr-ca'];
        out.fallbackFacetKeys = [];
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
        out.fallbackFacetKeys = [];
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
    const planAcc =
      typeof keywordPlan?.target_accent === 'string' && keywordPlan.target_accent.trim()
        ? normalizeRequestedAccent(keywordPlan.target_accent)
        : null;
    if (planAcc) {
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
      else if (loc === 'pt-PT') candidate = 'portuguese';
      else if (loc === 'es-MX') candidate = 'mexican';
      else if (loc === 'es-ES') candidate = 'castilian';
      else if (loc === 'fr-CA') candidate = 'canadian';
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
      else if (/\b(portugal|pt-pt|pt-eu|european)\b/.test(lower) && /\bportuguese|pt\b/.test(lower)) candidate = 'portuguese';
    }

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
  if (max === 0) {
    lines.push(labels.noVoices);
    return lines.join('\n');
  }
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
  if (max === 0) {
    lines.push(labels.noVoices);
    return lines.join('\n');
  }
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
  if (max === 0) {
    lines.push(labels.noVoices);
    return lines.join('\n');
  }
  for (let i = 0; i < max; i++) {
    lines.push(`- ${formatVoiceLine(sorted[i])}`);
  }
  return lines.join('\n');
}

// Detect if user explicitly wants only high quality / no high quality
function detectQualityPreferenceFromText(text) {
  if (!text) return null;
  const lower = text.toLowerCase();

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
      'Something went wrong between the LLM and the Voice Library API. Please try again and I’ll take another shot.'
  };
}

function formatVoiceLine(voice) {
  const url = `https://elevenlabs.io/app/voice-library?search=${encodeURIComponent(
    voice.voice_id
  )}`;
  return `<${url}|${voice.name}> \`${voice.voice_id}\``;
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
    'video'
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

  "tone_keywords": string[],
  "use_case_keywords": string[],
  "character_keywords": string[],
  "style_keywords": string[],
  "extra_keywords": string[]
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

  // sanitize gender
  if (out.target_gender !== 'male' && out.target_gender !== 'female' && out.target_gender !== 'neutral') {
    out.target_gender = null;
  }

  return out;
}

function ensureKeywordFloor(userText, plan) {
  const out = JSON.parse(JSON.stringify(plan || {}));
  const lower = (userText || '').toLowerCase();
  const countAll =
    (out.tone_keywords?.length || 0) +
    (out.use_case_keywords?.length || 0) +
    (out.character_keywords?.length || 0) +
    (out.style_keywords?.length || 0) +
    (out.extra_keywords?.length || 0);
  if (countAll >= 8) return out;

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

  out.use_case_keywords = addUnique(out.use_case_keywords, [
    'conversational','support','customer support','call center','contact center'
  ], 5);
  out.tone_keywords = addUnique(out.tone_keywords, [
    'calm','reassuring','clear','warm','professional','empathetic','confident'
  ], 8);
  out.style_keywords = addUnique(out.style_keywords, [
    'friendly','helpful','service'
  ], 6);

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
  return out;
}
RULES:

- user_interface_language:
  - Detect from the language of the user message (e.g. Polish -> "pl", English -> "en").

- target_voice_language:
  - Language of the VOICE the user wants (e.g. "en" for an American English voice, "pl" for Polish).
  - Infer from explicit mentions ("American accent", "polish voice") when possible.

- target_accent:
  - Accent of the VOICE (e.g. "american", "british", "australian", "polish"), or null if unclear.

- target_gender:
  - "male" / "female" / "neutral" when the user clearly implies it (man, woman, male/female voice, deep male, young woman, etc.), else null.

- quality_preference:
  - "high_only" ONLY if the user explicitly asks for high quality only
    (e.g. "only high quality", "high quality only", "hq only").
  - "no_high" ONLY if the user explicitly excludes high quality
    (e.g. "without high quality", "no high quality", "standard only").
  - Words like "best", "top", "great", "good", "premium" are NOT enough to set "high_only".
  - In all other cases use "any".

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

    // Accent as soft preference unless explicitly mentioned by user
    const explicitAccent = hasExplicitAccentMention(userText);
    if (!explicitAccent) {
      plan.target_accent = null;
    }

    // If user didn't explicitly mention a language, don't constrain by language
    const explicitLanguage = hasExplicitLanguageMention(userText);
    if (!explicitLanguage) {
      plan.target_voice_language = null;
    }
    // Bilingual EN+ES: avoid constraining by language
    if (detectBilingualEnEs(userText)) {
      plan.target_voice_language = null;
    }

    return plan;
  } catch (error) {
    safeLogAxiosError('buildKeywordPlan', error);

    const qp = detectQualityPreferenceFromText(userText);

    return {
      user_interface_language: guessUiLanguageFromText(userText),
      target_voice_language: detectVoiceLanguageFromText(userText),
      target_accent: null,
      target_gender: null,
      quality_preference: qp || 'any',
      tone_keywords: [],
      use_case_keywords: [],
      character_keywords: [],
      style_keywords: [],
      extra_keywords: [userText.toLowerCase()]
    };
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

  // Apply keyword floor enrichment if the plan is too thin (guarded)
  if (typeof ensureKeywordFloor === 'function') {
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
    accent = plan.target_accent.toLowerCase();
  }

  let gender = null;
  if (plan.target_gender === 'male' || plan.target_gender === 'female') {
    gender = plan.target_gender;
  }

  const qualityPref = plan.quality_preference || 'any';

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

  // Global prune of generic/noise keywords unless user explicitly asked
  {
    const before = pruneNegativesFromList(selectedKeywords.slice(), plan.__negatives);
    let filtered = filterKeywordsGlobally(userText, before);
    filtered = pruneNegativesFromList(filtered, plan.__negatives);

    // Ensure a minimum count after filtering by refilling from dropped ones
    const MIN_KEYWORDS_AFTER_FILTER = 12;
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
    const canFacetBrowse =
      language &&
      !detectBilingualEnEs(userText) &&
      facetKB &&
      facetKB.isLoaded &&
      facetKB.isLoaded() &&
      facetKB.hasIso2 &&
      facetKB.hasIso2(language) &&
      !(
        (plan.target_accent && typeof plan.target_accent === 'string' && plan.target_accent.trim()) ||
        (plan.target_locale && typeof plan.target_locale === 'string' && plan.target_locale.trim())
      );

    if (canFacetBrowse) {
      const zhDialect = language === 'zh' ? detectChineseDialectFromText(userText) : null;
      const variantIntent = detectVariantIntent(userText, language, facetKB);
      const axis = variantIntent?.isSpecific
        ? (variantIntent.axis || 'accent')
        : (language === 'zh' && zhDialect ? 'accent' : (facetKB.getAxisForIso2 ? facetKB.getAxisForIso2(language) : null));
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

      const minVariants = variantIntent && variantIntent.isSpecific ? 1 : 2;
      if (axis && Array.isArray(variants) && variants.length >= minVariants) {
        const wantMore = detectListAll(userText) === true || plan.__listAll === true;
        const pageSize = wantMore ? 80 : 50;
        const featured = plan.__featured === true;
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
            if (age) base.set('age', age);
            if (sort) base.set('sort', sort);
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

          // If still nothing, add OTHER/UNSURE (broad query) if budget allows
          if (allVoices.length === 0 && requestBudget > 0) {
            const base = new URLSearchParams();
            base.set('page_size', String(pageSize));
            base.set('language', String(language));
            if (gender) base.set('gender', gender);
            if (qualityPref === 'high_only') base.set('category', 'high_quality');
            if (featured) base.set('featured', 'true');
            if (age) base.set('age', age);
            if (sort) base.set('sort', sort);
            const p = new URLSearchParams(base.toString());
            const fetched = await fetchOnce(p, { iso2: language, axis: 'other', pass: 'no_search', facet: '__other__' });
            const group = { facetType: axis, facetKey: '__other__', facetLabel: 'OTHER/UNSURE', voices: [] };
            const seenInGroup = new Set();
            for (const voice of fetched || []) {
              if (!voice || !voice.voice_id) continue;
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
          return allVoices;
        }
      }
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
        const wantMore = detectListAll(userText) === true || plan.__listAll === true;
        if (wantMore) {
          voicesForKeyword = await callSharedVoicesAllPages(params, { maxPages: 3, cap: 200 });
        } else {
          voicesForKeyword = await callSharedVoicesCached(params, async (p) => {
            const { voices } = await callSharedVoicesRaw(p);
            return voices;
          });
        }

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
        // Quick relax (after triage): if still empty, retry without use_cases/accent/locale/age
        if (Array.isArray(voicesForKeyword) && voicesForKeyword.length === 0) {
          const pQuick = new URLSearchParams(params.toString());
          const keysQuick = Array.from(pQuick.keys());
          keysQuick.forEach((k) => {
            if (k === 'use_cases' || k === 'accent' || k === 'locale' || k === 'age') pQuick.delete(k);
          });
          try {
            const vQuick = await callSharedVoices(pQuick);
            try {
              trace({
                stage: 'per_keyword_quick_relax',
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
      // Combined fallback: with both, without use_cases, without descriptives, without locale/accent
      const paramsWith = new URLSearchParams(params.toString());
      const paramsNoUC = new URLSearchParams(params.toString());
      const keysNoUC = Array.from(paramsNoUC.keys());
      keysNoUC.forEach((k) => { if (k === 'use_cases') paramsNoUC.delete(k); });
      const paramsNoDesc = new URLSearchParams(params.toString());
      const keysNoDesc = Array.from(paramsNoDesc.keys());
      keysNoDesc.forEach((k) => { if (k === 'descriptives') paramsNoDesc.delete(k); });
      const paramsNoLocAcc = new URLSearchParams(params.toString());
      const keysNoLocAcc = Array.from(paramsNoLocAcc.keys());
      keysNoLocAcc.forEach((k) => { if (k === 'locale' || k === 'accent') paramsNoLocAcc.delete(k); });

      const wantMore = detectListAll(userText) === true || plan.__listAll === true;
      const [fa, fb, fc, fd] = await Promise.all([
        wantMore ? callSharedVoicesAllPages(paramsWith, { maxPages: 2, cap: 160 }) : callSharedVoicesCached(paramsWith, async (p) => { const { voices } = await callSharedVoicesRaw(p); return voices; }),
        wantMore ? callSharedVoicesAllPages(paramsNoUC, { maxPages: 2, cap: 160 }) : callSharedVoicesCached(paramsNoUC, async (p) => { const { voices } = await callSharedVoicesRaw(p); return voices; }),
        wantMore ? callSharedVoicesAllPages(paramsNoDesc, { maxPages: 2, cap: 160 }) : callSharedVoicesCached(paramsNoDesc, async (p) => { const { voices } = await callSharedVoicesRaw(p); return voices; }),
        wantMore ? callSharedVoicesAllPages(paramsNoLocAcc, { maxPages: 2, cap: 160 }) : callSharedVoicesCached(paramsNoLocAcc, async (p) => { const { voices } = await callSharedVoicesRaw(p); return voices; })
      ]);
      const seenIdsCF = new Set();
      const fallbackVoices = [];
      for (const v of [...(fa || []), ...(fb || []), ...(fc || []), ...(fd || [])]) {
        if (v && v.voice_id && !seenIdsCF.has(v.voice_id)) {
          seenIdsCF.add(v.voice_id);
          fallbackVoices.push(v);
        }
      }
      try {
        trace({
          stage: 'combined',
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
  if (seen.size === 0) {
    const params = new URLSearchParams();
    params.set('page_size', '100');
    if (language) params.set('language', language);
    if (accent) params.set('accent', accent);
    if (gender) params.set('gender', gender);
    if (qualityPref === 'high_only') {
      params.set('category', 'high_quality');
    }

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
  if (seen.size === 0 && language) {
    const params = new URLSearchParams();
    params.set('page_size', '100');
    if (accent) params.set('accent', accent);
    if (gender) params.set('gender', gender);
    if (qualityPref === 'high_only') {
      params.set('category', 'high_quality');
    }
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
  if (seen.size === 0 && qualityPref === 'high_only') {
    const params = new URLSearchParams();
    params.set('page_size', '100');
    if (language) params.set('language', language);
    if (accent) params.set('accent', accent);
    if (gender) params.set('gender', gender);
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
  if (seen.size > 0 && seen.size < 12) {
    const paramsG = new URLSearchParams();
    paramsG.set('page_size', '80');
    // keep language and category if set, drop accent/use_cases/locale/descriptives
    if (language) paramsG.set('language', language);
    if (qualityPref === 'high_only') paramsG.set('category', 'high_quality');
    const searchG =
      (selectedKeywords.length ? selectedKeywords.join(' ') : '') ||
      ((userText ? userText.toLowerCase() : '') || '');
    if (searchG) paramsG.set('search', searchG);
    try {
      const wantMore = detectListAll(userText) === true || plan.__listAll === true;
      // First pass: drop accent/use_cases/locale/descriptives
      const keysG = Array.from(paramsG.keys());
      keysG.forEach((k) => {
        if (k === 'use_cases' || k === 'accent' || k === 'locale' || k === 'descriptives') paramsG.delete(k);
      });
      const broadened = wantMore
        ? await callSharedVoicesAllPages(paramsG, { maxPages: 2, cap: 160 })
        : await callSharedVoicesCached(paramsG, async (p) => { const { voices } = await callSharedVoicesRaw(p); return voices; });
      try {
        trace({ stage: 'global_broaden', params: paramsToObject(paramsG), count: Array.isArray(broadened) ? broadened.length : 0 });
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
        const vH = wantMore
          ? await callSharedVoicesAllPages(pH, { maxPages: 2, cap: 160 })
          : await callSharedVoicesCached(pH, async (p) => { const { voices } = await callSharedVoicesRaw(p); return voices; });
        const onlyHigh = (vH || []).filter(isHighQuality);
        try {
          trace({ stage: 'global_broaden_hq_local', params: paramsToObject(pH), count: onlyHigh.length });
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

  // 4) convert map -> list, attach matched_keywords
  let voices = Array.from(seen.values()).map((entry) => {
    const v = entry.voice;
    v._matched_keywords = Array.from(entry.matchedKeywords || []);
    return v;
  });

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

  // Candidate ranking prep: coverage score + diversity seeding before cap
  const chineseDialect = language === 'zh' ? detectChineseDialectFromText(userText) : null;
  const preferredZhLocales = preferredLocalesForChineseDialect(chineseDialect).map((x) => String(x).toLowerCase());
  const dialectHints = new Set(dialectKeywordHints(chineseDialect).map(normalizeKw));
  const zhAccentSlugs = new Set(
    language === 'zh'
      ? [
          ...(ZH_ACCENT_SLUGS.cantonese || []),
          ...(ZH_ACCENT_SLUGS.mandarin || []),
          ...(ZH_ACCENT_SLUGS.standard || [])
        ].map(normalizeKw)
      : []
  );

  function calcCoverageScore(v) {
    const mk = Array.isArray(v._matched_keywords) ? v._matched_keywords : [];
    const set = new Set(mk);
    const useCase = (plan.use_case_keywords || []).filter((k) => set.has(k)).length;
    const style = (plan.style_keywords || []).filter((k) => set.has(k)).length;
    const character = (plan.character_keywords || []).filter((k) => set.has(k)).length;
    const tone = (plan.tone_keywords || []).filter((k) => set.has(k)).length;
    let coverage = 3 * useCase + 3 * style + 2 * character + 1 * tone;
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
    // support
    if (hasAny('support','customer support','conversational','call center','contact center')) {
      coverage += 0.8;
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
    const matchedCount = mk.length;
    const usage = v.usage_character_count_1y || v.usage_character_count_7d || 0;
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
  const candidates = voices.slice(0, MAX_VOICES).map((v) => ({
    voice_id: v.voice_id,
    name: truncate(v.name, 80),
    language: v.language || null,
    accent: truncate(v.accent, 40),
    gender: v.gender || null,
    description: truncate(v.description, 240),
    descriptive: truncate(v.descriptive, 120),
    // keep a small set of fields; omit heavy arrays/objects like verified_languages/labels
    category: v.category || null,
    usage_character_count_1y:
      v.usage_character_count_1y || v.usage_character_count_7d || null,
    matched_keywords: Array.isArray(v._matched_keywords) ? v._matched_keywords : []
  }));

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
      "category": string or null,
      "usage_character_count_1y": number or null,
      "matched_keywords": string[]
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

   - Language & accent:
     - If target_voice_language is set, strongly prefer that language.
     - If target_accent is set (e.g. "american"), prefer voices with matching accent or naming.
     - If the user explicitly asks for a Chinese dialect (e.g. "cantonese" or "mandarin"), treat it as a strong constraint:
       - Strongly reward candidates whose matched_keywords include that dialect or its obvious region hints (e.g. hong kong, zh-hk for cantonese; china, zh-cn for mandarin).
       - Prefer locale matches when present (zh-HK for cantonese; zh-CN for mandarin).
       - Also strongly reward candidates that were retrieved via an ElevenLabs accent filter slug in matched_keywords
         (e.g. hong-kong-cantonese, guangzhou-cantonese, beijing-mandarin, taiwan-mandarin, standard).

   - Gender:
     - If target_gender is clear, reward matching voices and slightly penalize opposite gender.
     - If not specified, do not enforce.

   - Quality preference:
     - If "high_only", slightly reward voices that look premium/high-quality,
       but do NOT completely discard standard if they are a great style match.
     - If "no_high", slightly prefer more neutral / standard voices.

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

  try {
    const response = await httpPostWithRetry(
      'https://api.openai.com/v1/chat/completions',
      payload,
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout: 25000
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
      scoreMap[item.voice_id] = score;
    });

    // Ensure every candidate has some score
    candidates.forEach((c, idx) => {
      if (!scoreMap[c.voice_id]) {
        scoreMap[c.voice_id] =
          ((candidates.length - idx) / Math.max(candidates.length, 1)) * 0.2;
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
  const { voices, ranking, filters, originalQuery } = session;
  const labels = getLabels();

  // Facet sections (locale/accent) – UI-like grouping
  try {
    const facetGroups = voices && Array.isArray(voices.facetGroups) ? voices.facetGroups : null;
    const facetAxis = voices && typeof voices.facetAxis === 'string' ? voices.facetAxis : null;
    const variantIntent = voices && typeof voices.variantIntent === 'object' ? voices.variantIntent : null;
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
        for (const v of uniq) {
          const isHq = isHighQuality(v);
          if (qualityFilter === 'high_only' && !isHq) continue;
          if (qualityFilter === 'no_high' && isHq) continue;
          const g = getGenderGroup(v);
          if (genderFilter !== 'any' && g !== genderFilter) continue;
          if (buckets[g].length < maxPerGender) buckets[g].push(v);
        }

        const order = genderFilter !== 'any' ? [genderFilter] : ['female', 'male', 'other'];
        const genderLabels = { female: labels.female, male: labels.male, other: labels.other };
        for (const k of order) {
          const arr = buckets[k] || [];
          if (!arr.length) continue;
          out.push(`*${genderLabels[k]}:*`);
          for (const v of arr) {
            const isHq = isHighQuality(v);
            const prefix = qualityFilter === 'any' && isHq ? '[HQ] ' : '';
            out.push(`- ${prefix}${formatVoiceLine(v)}`);
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

  const sorted = [...voices].sort(
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

  sortedUnique.forEach((v) => {
    const isHq = isHighQuality(v);

    if (qualityFilter === 'high_only' && !isHq) return;
    if (qualityFilter === 'no_high' && isHq) return;

    const group = isHq ? 'high' : 'standard';
    const genderGroup = getGenderGroup(v);

    if (genderFilter !== 'any' && genderGroup !== genderFilter) return;

    const arr = sections[group][genderGroup];
    if (arr.length < maxPerGender) {
      arr.push(v);
    }
  });

  const showStandardSection = qualityFilter !== 'high_only';
  const showHighSection = qualityFilter !== 'no_high';

  const lines = [];

  function appendSection(title, sectionKey) {
    const groups = sections[sectionKey];
    const order = genderFilter !== 'any' ? [genderFilter] : ['female', 'male', 'other'];
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
        lines.push(`- ${formatVoiceLine(v)}`);
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
  const hasBilingual = /\bbilingual\b/.test(lower) || /\ben\s*\/\s*es\b/.test(lower);
  const hasEn = /\benglish\b|\ben\b/.test(lower);
  const hasEs = /\bspanish\b|\bes\b/.test(lower);
  return hasBilingual && hasEn && hasEs;
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
    { pat: /\b(?:not|no|without)\s+(?:an?\s+)?cartoons?\b/, tok: 'cartoon' }
  ];
  for (const r of rules) if (r.pat.test(lower)) neg.add(r.tok);
  return neg;
}

function pruneNegativesFromList(items, negatives) {
  try {
    const arr = Array.isArray(items) ? items : [];
    const neg = Array.isArray(negatives) ? negatives : [];
    if (!arr.length || !neg.length) return arr;
    const negSet = new Set(neg.map((x) => normalizeKw(x)).filter(Boolean));
    return arr.filter((k) => !negSet.has(normalizeKw(k)));
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

function pickQueryUseCases(plan) {
  const src = Array.isArray(plan?.use_case_keywords) ? plan.use_case_keywords : [];
  const tokens = src.map((s) => (s || '').toString().toLowerCase().trim()).filter(Boolean);

  // Voice Library categories (per support/UI):
  // advertisement, characters_animation, conversational, entertainment_tv,
  // informative_educational, narrative_story, social_media
  const mapTokenToCategory = (t) => {
    if (!t) return null;

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

    // Educational / informative
    if (
      t.includes('documentary') ||
      t.includes('e-learning') ||
      t.includes('elearning') ||
      t.includes('presentation') ||
      t.includes('explainer') ||
      t.includes('educational') ||
      t.includes('informative')
    ) {
      return 'informative_educational';
    }

    // Narrative / audiobooks / storytelling
    if (
      t.includes('audiobook') ||
      t.includes('narration') ||
      t.includes('narrator') ||
      t.includes('story') ||
      t.includes('storytelling') ||
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

  // Deterministic priority: prefer conversational for support/call-center intents
  const priority = [
    'conversational',
    'advertisement',
    'characters_animation',
    'entertainment_tv',
    'informative_educational',
    'narrative_story',
    'social_media'
  ];

  const ordered = priority.filter((p) => set.has(p));
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
      const accentRegex = /\b(american|british|uk|us|australian|irish|scottish|canadian|polish)\b/i;
      if (hasAccentWord && accentRegex.test(userText || '')) return true;
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
    // LATAM / Latino signals (prefer locale over accent)
    if (/\b(es-419|latam|latin america|latinamerican|latino|latin(?:o)? american|south american|central american|caribbean)\b/.test(lower)) {
      return 'es-419';
    }
    // European Spanish phrasing
    if (/\b(european)\b/.test(lower) && /\b(spanish|es)\b/.test(lower)) return 'es-ES';
  }
  if (lang === 'pt') {
    if (/\b(pt-br|brazil|brasil|brazilian|brasile)\b/.test(lower) || acc.includes('brazil')) return 'pt-BR';
    if (/\b(pt-pt|portugal|european)\b/.test(lower) || acc.includes('portugal')) return 'pt-PT';
  }
  if (lang === 'fr') {
    if (/\b(fr-ca|french canadian|canadian french|quebec|québec|qc)\b/.test(lower) || acc.includes('canadian')) {
      return 'fr-CA';
    }
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

function appendQueryFiltersToParams(params, plan, userText, options = {}) {
  const language = options.language || null;
  const accent = options.accent || null;
  const gender = options.gender || null;
  const qualityPref = options.qualityPref || 'any';
  const featured = options.featured === true ? true : false;
  const sort = typeof options.sort === 'string' ? options.sort : null;
  const forceUseCases = options.forceUseCases === true;
  const forceDescriptives = options.forceDescriptives === true;
  const trace = typeof options.traceCb === 'function' ? options.traceCb : () => {};
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
      const a = (acc || '').toString();
      if (!a) return null;
      // If KB provides a slug, prefer it in cases where spaces/punctuation could break matching.
      const slug =
        facetKB && facetKB.isLoaded && facetKB.isLoaded() && facetKB.getAccentSlug
          ? facetKB.getAccentSlug(iso2, a)
          : null;
      if (!slug) return a;
      const force = readEnvBoolean('FORCE_ACCENT_SLUGS', false);
      const hasSpaces = /\s/.test(a);
      if (force || hasSpaces || (iso2 || '').toString().toLowerCase().slice(0, 2) === 'zh') return slug;
      return a;
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
    (/\b(canadian|quebec|québec|fr-ca|qc|french canadian|canadian french)\b/.test(lowerText));
  const isSpanishMexico = (language === 'es' || /spanish|es\b/.test(lowerText)) &&
    (/\bmexico\b|\bmexican\b|\bes-mx\b|\bmx\b/.test(lowerText));
  const isSpanishLatam = (language === 'es' || /spanish|es\b/.test(lowerText)) &&
    (/\b(es-419|latam|latin america|latinamerican|latino|latin(?:o)? american|south american|central american|caribbean)\b/.test(lowerText));
  const isSpanishSpain = (language === 'es' || /spanish|es\b/.test(lowerText)) &&
    (/\b(spain|castilian|es-es)\b/.test(lowerText) || (/\b(european)\b/.test(lowerText) && /\bspanish\b/.test(lowerText)));
  const age =
    typeof options.age === 'string' && options.age
      ? options.age
      : detectAgeFromText(userText);

  // Existing filters
  // Bilingual: avoid constraining language to let both EN/ES candidates through
  if (!isBilingualEnEs && language && shouldApplyParam('language', plan, userText)) params.set('language', language);
  // Accent: allow Spanish Mexico heuristic even without explicit "accent"
  if (isSpanishMexico) {
    if (isAccentAllowedByCatalog('es', 'mexican')) {
      params.set('accent', pickAccentParamValue('es', 'mexican') || 'mexican');
      diag.accent_set = 'mexican';
      diag.accent_allowed = 'true';
      diag.accent_reason = 'spanish_mexico';
    } else {
      diag.accent_set = 'mexican';
      diag.accent_allowed = 'false';
      diag.accent_reason = 'spanish_mexico_catalog_reject';
    }
  } else if (isFrenchCanadian) {
    // Prefer locale=fr-CA over hard accent filtering (accent metadata can be inconsistent)
    // Keep accent as a soft preference via keywords/ranking, not as a strict query param.
  } else if (isSpanishLatam || isSpanishSpain) {
    // Prefer locale-based regionalization for Spanish (accent metadata can be inconsistent)
  } else if (language === 'zh' && chineseDialect) {
    // Prefer locale-based hinting for Mandarin vs Cantonese (soft)
  } else if (accent && shouldApplyParam('accent', plan, userText)) {
    if (isAccentAllowedByCatalog(language, accent)) {
      const accVal = pickAccentParamValue(language, accent) || accent;
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
    ? pickQueryUseCases(plan)
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
  // IVR fast path: if ivr present in the text, start with only ivr
  if (/\bivr\b/i.test(lowerText)) {
    useCases = ['ivr'];
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
  if (loc && shouldApplyParam('locale', plan, userText)) {
    if (isLocaleAllowedByCatalog(language, loc)) {
      params.set('locale', loc);
      diag.locale_set = String(loc);
      diag.locale_allowed = 'true';
      diag.locale_reason = 'infer_locale';
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
  // Force es-419 locale for LATAM Spanish briefs
  if (isSpanishLatam && !isSpanishMexico) {
    if (isLocaleAllowedByCatalog('es', 'es-419')) {
      params.set('locale', 'es-419');
      loc = 'es-419';
      diag.locale_set = 'es-419';
      diag.locale_allowed = 'true';
      diag.locale_reason = 'spanish_latam';
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
  if (age && shouldApplyParam('age', plan, userText)) params.set('age', age);
  if (sort && shouldApplyParam('sort', plan, userText, { sort })) params.set('sort', sort);

  return {
    useCases,
    descriptives,
    locale: loc,
    featured,
    age,
    sort,
    localeInferred: Boolean(isSpanishMexico || isSpanishLatam || isSpanishSpain || (language === 'zh' && chineseDialect)),
    bilingual: Boolean(isBilingualEnEs),
    negatives: banned || []
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
    lines.push(
      `Plan: lang=${plan?.target_voice_language || '-'}, accent=${plan?.target_accent || '-'}, gender=${plan?.target_gender || '-'}, quality=${plan?.quality_preference || 'any'}`
    );
    if (summary && typeof summary === 'object') {
      lines.push('');
      lines.push(`Summary: unique_voices=${summary.unique_count ?? '-'}`);
      if (Array.isArray(summary.top_coverage) && summary.top_coverage.length) {
        const top = summary.top_coverage.slice(0, 10);
        lines.push('Top coverage (voice_id : matched_keywords_count):');
        top.forEach((t) => {
          lines.push(`• ${t.voice_id}: ${t.matchedCount}`);
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

function runDevAsserts() {
  const enabled = String(process.env.DEV_ASSERTS || '').trim().toLowerCase();
  if (!(enabled === 'true' || enabled === '1' || enabled === 'yes')) return;

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

  // Locale normalization (UI aliases -> canonical)
  devAssert(normalizeRequestedLocale('PT-EU') === 'pt-PT', 'normalize PT-EU -> pt-PT');
  devAssert(normalizeRequestedLocale('en-UK') === 'en-GB', 'normalize en-UK -> en-GB');
  devAssert(normalizeRequestedLocale('es-LATAM') === 'es-419', 'normalize es-LATAM -> es-419');
  devAssert(extractLocaleFromField('es-419') === 'es-419', 'parse locale with numeric region (es-419)');

  // Accent normalization
  devAssert(normalizeRequestedAccent('General American') === 'american', 'normalize accent: General American -> american');

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

    const keywordPlan = await buildKeywordPlan(cleaned);
    const labels = getLabels();

    let uiLang =
      (guessUiLanguageFromText(cleaned) || 'en').toString().slice(0, 2).toLowerCase();

    // Removed initial progress message; first message will be the results
    // Seed plan flags for server-side filtering/pagination
    keywordPlan.__featured = false;
    keywordPlan.__sort = null;
    keywordPlan.__listAll = detectListAll(cleaned);
    keywordPlan.__forceUseCases = false;
    keywordPlan.__forceDescriptives = false;

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

        // Locale: only when explicitly present but invalid
        if (explicitLocale) {
          const reqLoc = getRequestedLocale(cleaned, keywordPlan);
          if (reqLoc && facetKB.checkLocaleAllowed) {
            const ok = facetKB.checkLocaleAllowed(iso2, reqLoc);
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
                  filters: {
                    quality: keywordPlan.quality_preference || 'any',
                    gender:
                      keywordPlan.target_gender === 'male' || keywordPlan.target_gender === 'female'
                        ? keywordPlan.target_gender
                        : 'any',
                    listAll: detectListAll(cleaned),
                    featured: false,
                    sort: null,
                    strictUseCase: false,
                    strictDescriptives: false,
                    limitPerGender: null
                  },
                  lastActive: Date.now()
                };
                await client.chat.postMessage({ channel: event.channel, thread_ts: threadTs, text: msg, blocks: buildBlocksFromText(msg) || undefined });
                return;
              }
            }
          }
        }

        // Accent: when user requested accent but it's invalid/ambiguous
        if (wantsAccent) {
          const reqLoc = getRequestedLocale(cleaned, keywordPlan);
          const reqAcc = getRequestedAccent(cleaned, keywordPlan, reqLoc);
          const allowed = reqAcc && facetKB.checkAccentAllowed ? facetKB.checkAccentAllowed(iso2, reqAcc) : null;
          const accOk = !!(allowed && allowed.known && allowed.allowed);

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
                filters: {
                  quality: keywordPlan.quality_preference || 'any',
                  gender:
                    keywordPlan.target_gender === 'male' || keywordPlan.target_gender === 'female'
                      ? keywordPlan.target_gender
                      : 'any',
                  listAll: detectListAll(cleaned),
                  featured: false,
                  sort: null,
                  strictUseCase: false,
                  strictDescriptives: false,
                  limitPerGender: null
                },
                lastActive: Date.now()
              };
              await client.chat.postMessage({ channel: event.channel, thread_ts: threadTs, text: msg, blocks: buildBlocksFromText(msg) || undefined });
              return;
            }
          }
        }
      }
    } catch (_) {}

    // Multi-intent: split by semicolons and run separate sub-searches, then group
    const parts = splitMultiIntents(cleaned);
    if (parts.length >= 2) {
      const subSessions = [];
      const searchTrace = [];
      const traceCb = (entry) => {
        try { searchTrace.push(entry); } catch (_) {}
      };
      for (const part of parts) {
        await ensureLanguageIndexLoaded(traceCb);
        const subPlan = await buildKeywordPlan(part);
        subPlan.__featured = false;
        subPlan.__sort = null;
        subPlan.__listAll = detectListAll(part);
        subPlan.__forceUseCases = false;
        subPlan.__forceDescriptives = false;
        let voices = await fetchVoicesByKeywords(subPlan, part, traceCb);
        if (!voices.length) {
          continue;
        }
        const ranked = await rankVoicesWithGPT(part, subPlan, voices);
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
              gender:
                subPlan.target_gender === 'male' || subPlan.target_gender === 'female'
                  ? subPlan.target_gender
                  : 'any',
              listAll: detectListAll(part),
              featured: false,
              sort: null,
              limitPerGender: null
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

    // Similar voices: if user asks "similar to <voice_id>"
    const voiceIdForSimilarity = extractVoiceIdCandidate(cleaned);
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
      const session = {
        originalQuery: cleaned,
        keywordPlan,
        voices,
        ranking: ranked.scoreMap,
        uiLanguage: uiLang,
        filters: {
          quality: keywordPlan.quality_preference || 'any',
          gender:
            keywordPlan.target_gender === 'male' || keywordPlan.target_gender === 'female'
              ? keywordPlan.target_gender
              : 'any',
          listAll: detectListAll(cleaned),
          featured: false,
          sort: null,
          strictUseCase: false,
          strictDescriptives: false,
          limitPerGender: null
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
        const noResText = await translateForUserLanguage(labels.noResults, uiLang);
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
          const noResText = await translateForUserLanguage(labels.noResults, uiLang);
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
          const noResText = await translateForUserLanguage(labels.noResults, uiLang);
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

    const session = {
      originalQuery: cleaned,
      keywordPlan,
      voices,
      ranking: rankingMap,
      uiLanguage: uiLang,
      filters: {
        quality: keywordPlan.quality_preference || 'any',
        gender:
          keywordPlan.target_gender === 'male' || keywordPlan.target_gender === 'female'
            ? keywordPlan.target_gender
            : 'any',
        listAll: detectListAll(cleaned),
        featured: false,
        sort: null,
        strictUseCase: false,
        strictDescriptives: false,
        limitPerGender: null
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
        fallbackMsg = await translateForUserLanguage(fallbackMsg, session.uiLanguage);
        const fbBlocks = buildBlocksFromText(fallbackMsg);
        await client.chat.postMessage({
          channel: event.channel,
          thread_ts: threadTs,
          text: fallbackMsg,
          blocks: fbBlocks || undefined
        });
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
            matchedCount: Array.isArray(v._matched_keywords) ? v._matched_keywords.length : 0
          }))
        : [];
      coverage.sort((a, b) => b.matchedCount - a.matchedCount);
      const summary = { unique_count: Array.isArray(voices) ? voices.length : 0, top_coverage: coverage.slice(0, 10) };
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

const app = new App({
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
      const combinedQuery = [existing.originalQuery || '', cleaned].join(' ').trim();
      const searchTrace = [];
      const traceCb = (entry) => {
        try {
          searchTrace.push(entry);
        } catch (_) {}
      };
      const voices = await fetchVoicesByKeywords(refinedPlan, combinedQuery, traceCb);
      if (!voices.length) {
        const labels = getLabels();
        const noResText = await translateForUserLanguage(labels.noResults, existing.uiLanguage);
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
              matchedCount: Array.isArray(v._matched_keywords) ? v._matched_keywords.length : 0
            }))
          : [];
        coverage.sort((a, b) => b.matchedCount - a.matchedCount);
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

// -------------------------------------------------------------
// Start the app (for Render etc.)
// -------------------------------------------------------------

(async () => {
  validateEnvOrExit();
  runDevAsserts();
  startMemoryCleanup();
  try {
    accentCatalog?.startBackgroundRefresh?.();
  } catch (_) {}
  const port = process.env.PORT || 3000;
  await app.start(port);
  console.log('⚡️ voices-bot is running on port ' + port);
})();
