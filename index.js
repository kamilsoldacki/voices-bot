const { App } = require('@slack/bolt');
const axios = require('axios');
const FormData = require('form-data');

// -------------------------------------------------------------
// In-memory conversation sessions (per Slack thread)
// -------------------------------------------------------------
const sessions = {};
const recentRequests = new Map();
const REQUEST_DEDUP_TTL_MS = 15000;
const SESSION_TTL_MS = 45 * 60 * 1000; // 45 minutes
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const KEYWORD_SEARCH_CONCURRENCY = 4; // limit concurrent keyword searches

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
  const lower = text.toLowerCase();

  if (
    lower.includes('polish') ||
    lower.includes('po polsku') ||
    lower.includes('polski głos') ||
    lower.includes('polski glos') ||
    lower.includes('polski')
  ) {
    return 'pl';
  }

  if (
    lower.includes('english') ||
    lower.includes('american accent') ||
    lower.includes('us accent') ||
    lower.includes('angielski')
  ) {
    return 'en';
  }

  if (
    lower.includes('spanish') ||
    lower.includes('español') ||
    lower.includes('espanol') ||
    lower.includes('hiszpań') ||
    lower.includes('hiszpansk')
  ) {
    return 'es';
  }

  if (lower.includes('german') || lower.includes('deutsch') || lower.includes('niemieck')) {
    return 'de';
  }

  if (lower.includes('french') || lower.includes('francus')) {
    return 'fr';
  }

  if (lower.includes('italian') || lower.includes('włoski') || lower.includes('wloski')) {
    return 'it';
  }

  return null;
}

// Detect if user explicitly mentioned a language (so we should constrain by language)
function hasExplicitLanguageMention(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  const tokens = [
    'polish', 'po polsku', 'polski głos', 'polski glos', 'polski',
    'english', 'american accent', 'us accent', 'angielski',
    'spanish', 'español', 'espanol', 'hiszpań', 'hiszpansk',
    'german', 'deutsch', 'niemieck',
    'french', 'francus',
    'italian', 'włoski', 'wloski'
  ];
  return tokens.some((t) => lower.includes(t));
}

// -------------------------------------------------------------
// Global keyword noise filters
// -------------------------------------------------------------

// Generic/noise keywords – skip unless explicitly present in user text
const GENERIC_NOISE_KEYWORDS = new Set([
  'narration', 'narrator', 'voiceover', 'trailer', 'video', 'content', 'media',
  'youtube', 'tiktok', 'podcast', 'explainer',
  'gaming', 'music', 'song', 'audio', 'storytime', 'stream', 'streaming'
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
  for (let kw of keywords) {
    const k = normalizeKw(kw);
    if (!k) continue;
    if (k.length < 3 && !SHORT_WHITELIST.has(k) && !explicitlyMentionedInText(k, userText)) {
      continue;
    }
    if (isGenericNoiseKeyword(k) && !explicitlyMentionedInText(k, userText)) {
      continue;
    }
    if (!seen.has(k)) {
      out.push(k);
      seen.add(k);
    }
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

  // list all
  if (lower.includes('list all') || lower.includes('show all')) {
    session.filters.listAll = true;
    changed = true;
  }

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

  return base;
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
    const accentRegex =
      /\b(american|british|uk|us|australian|irish|scottish|canadian|polish)\b/i;
    const explicitAccent = accentRegex.test(userText || '');
    if (!explicitAccent) {
      plan.target_accent = null;
    }

    // If user didn't explicitly mention a language, don't constrain by language
    const explicitLanguage = hasExplicitLanguageMention(userText);
    if (!explicitLanguage) {
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
  const MAX_KEYWORD_QUERIES = 10;
  const budgets = { tone: 2, use: 3, style: 3, character: 2 };
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
  selectedKeywords = filterKeywordsGlobally(userText, selectedKeywords);
  // Safety: if nothing left, fall back to raw user text (filtered once)
  if (!selectedKeywords.length && userText) {
    const fallback = filterKeywordsGlobally(userText, [(userText || '').toLowerCase()]);
    selectedKeywords = fallback.length ? fallback : [(userText || '').toLowerCase()];
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

  const perKeywordResults = await runWithLimit(
    selectedKeywords,
    KEYWORD_SEARCH_CONCURRENCY,
    async (kw) => {
      const params = new URLSearchParams();
      params.set('page_size', '40');
      if (language) params.set('language', language);
      if (accent) params.set('accent', accent);
      if (gender) params.set('gender', gender);
      if (qualityPref === 'high_only') {
        params.set('category', 'high_quality');
      }
      params.set('search', kw);
      try {
        let voicesForKeyword = await callSharedVoices(params);
        try {
          trace({
            stage: 'per_keyword',
            keyword: kw,
            params: paramsToObject(params),
            count: Array.isArray(voicesForKeyword) ? voicesForKeyword.length : 0
          });
        } catch (_) {}
        // Early language alias retry if empty
        if (Array.isArray(voicesForKeyword) && voicesForKeyword.length === 0 && language) {
          const LANGUAGE_PARAM_MAP = {
            pl: ['pl', 'polish'],
            en: ['en', 'english'],
            es: ['es', 'spanish', 'español', 'espanol'],
            de: ['de', 'german', 'deutsch'],
            fr: ['fr', 'french', 'français', 'francais'],
            it: ['it', 'italian', 'italiano']
          };
          const candidates = Array.from(new Set(LANGUAGE_PARAM_MAP[language] || [language]));
          const alt = candidates.find((v) => v !== language);
          if (alt) {
            const altParams = new URLSearchParams(params.toString());
            altParams.set('language', alt);
            try {
              const altVoicesQuick = await callSharedVoices(altParams);
              try {
                trace({
                  stage: 'per_keyword_alt_lang',
                  keyword: kw,
                  params: paramsToObject(altParams),
                  count: Array.isArray(altVoicesQuick) ? altVoicesQuick.length : 0
                });
              } catch (_) {}
              if (Array.isArray(altVoicesQuick) && altVoicesQuick.length) {
                voicesForKeyword = altVoicesQuick;
              }
            } catch (_) {}
          }
        }
        return { kw, voices: voicesForKeyword || [] };
      } catch (err) {
        console.error('Error fetching voices for keyword:', kw, err.message || err);
        return { kw, voices: [] };
      }
    }
  );

  // merge results
  perKeywordResults.forEach((res) => {
    if (!res || !Array.isArray(res.voices)) return;
    const kw = res.kw;
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

  // 2) fallback: if nothing found at all, try a combined-search query
  if (seen.size === 0) {
    const params = new URLSearchParams();
    params.set('page_size', '80');
    if (language) params.set('language', language);
    if (accent) params.set('accent', accent);
    if (gender) params.set('gender', gender);
    if (qualityPref === 'high_only') {
      params.set('category', 'high_quality');
    }

    const fallbackSearch =
      (selectedKeywords.length ? selectedKeywords.join(' ') : '') ||
      ((userText ? userText.toLowerCase() : '') || '');

    if (fallbackSearch) {
      params.set('search', fallbackSearch);
    }

    try {
      const fallbackVoices = await callSharedVoices(params);
      try {
        trace({
          stage: 'combined',
          params: paramsToObject(params),
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

  // 2b) extra broad fallback with alternative language name (e.g., 'polish')
  if (seen.size === 0 && language) {
    const LANGUAGE_PARAM_MAP = {
      pl: ['pl', 'polish'],
      en: ['en', 'english'],
      es: ['es', 'spanish', 'español', 'espanol'],
      de: ['de', 'german', 'deutsch'],
      fr: ['fr', 'french', 'français', 'francais'],
      it: ['it', 'italian', 'italiano']
    };
    const candidates = Array.from(new Set(LANGUAGE_PARAM_MAP[language] || [language]));
    const alt = candidates.find((v) => v !== language);
    if (alt) {
      const params = new URLSearchParams();
      params.set('page_size', '100');
      params.set('language', alt);
      if (accent) params.set('accent', accent);
      if (gender) params.set('gender', gender);
      if (qualityPref === 'high_only') {
        params.set('category', 'high_quality');
      }
      try {
        const altVoices = await callSharedVoices(params);
        try {
          trace({
            stage: 'alt_language',
            params: paramsToObject(params),
            count: Array.isArray(altVoices) ? altVoices.length : 0
          });
        } catch (_) {}
        altVoices.forEach((voice) => {
          if (!voice || !voice.voice_id) return;
          if (!seen.has(voice.voice_id)) {
            seen.set(voice.voice_id, { voice, matchedKeywords: new Set() });
          }
        });
      } catch (err) {
        console.error('Error in alt-language broad fallback:', err.message || err);
      }
    }
  }

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
  function calcCoverageScore(v) {
    const mk = Array.isArray(v._matched_keywords) ? v._matched_keywords : [];
    const set = new Set(mk);
    const useCase = (plan.use_case_keywords || []).filter((k) => set.has(k)).length;
    const style = (plan.style_keywords || []).filter((k) => set.has(k)).length;
    const character = (plan.character_keywords || []).filter((k) => set.has(k)).length;
    const tone = (plan.tone_keywords || []).filter((k) => set.has(k)).length;
    const coverage = 3 * useCase + 3 * style + 2 * character + 1 * tone;
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

  return voices;
}

// Special mode: "top by language" – most used voices in a given language
async function fetchTopVoicesByLanguage(languageCode, qualityPreference, traceCb) {
  const XI_KEY = process.env.ELEVENLABS_API_KEY;
  const trace = typeof traceCb === 'function' ? traceCb : () => {};

  try {
    const params = new URLSearchParams();
    params.set('page_size', '100');
    if (languageCode) params.set('language', languageCode);
    if (qualityPreference === 'high_only') {
      params.set('category', 'high_quality');
    }

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
        content: JSON.stringify({
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

  const maxPerGender = filters.listAll ? 50 : 6;

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

    lines.push(`*${title}*`);
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
    appendSection(labels.standardHeader, 'standard');
  }
  if (showHighSection) {
    appendSection(labels.highHeader, 'high');
  }

  if (genderFilter === 'female') {
    lines.push(labels.femaleFilterFooter || labels.genericFooter);
  } else if (genderFilter === 'male') {
    lines.push(labels.maleFilterFooter || labels.genericFooter);
  } else {
    lines.push(labels.genericFooter);
  }

  return lines.join('\n');
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

// Post one or two messages depending on quality filter
async function postSessionMessages(client, channel, threadTs, session) {
  const quality = (session.filters?.quality || 'any').toString();
  if (quality !== 'any') {
    let message = buildMessageFromSession(session);
    message = await translateForUserLanguage(message, session.uiLanguage);
    const blocks = buildBlocksFromText(message);
    await client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text: message,
      blocks: blocks || undefined
    });
    return;
  }
  // Split into standard-only and high-only
  const qualities = ['no_high', 'high_only'];
  for (const q of qualities) {
    const copy = JSON.parse(JSON.stringify(session));
    copy.filters.quality = q;
    let message = buildMessageFromSession(copy);
    message = await translateForUserLanguage(message, copy.uiLanguage);
    const blocks = buildBlocksFromText(message);
    await client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text: message,
      blocks: blocks || undefined
    });
  }
}

function paramsToObject(params) {
  const obj = {};
  try {
    for (const [k, v] of params.entries()) obj[k] = v;
  } catch (_) {}
  return obj;
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

async function downloadToBuffer(url) {
  const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 15000 });
  return Buffer.from(res.data);
}

async function findSimilarVoicesByVoiceId(voiceId, traceCb) {
  const XI_KEY = process.env.ELEVENLABS_API_KEY;
  try {
    const baseVoice = await fetchSharedVoiceByIdOrSearch(voiceId, traceCb);
    if (!baseVoice || !baseVoice.preview_url) return [];
    const audioBuf = await downloadToBuffer(baseVoice.preview_url);
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
        params: { top_k: 'default' },
        count: out.length
      });
    } catch (_) {}
    return out;
  } catch (err) {
    safeLogAxiosError('findSimilarVoicesByVoiceId', err);
    return [];
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
    const max = Math.min(trace.length, 30);
    for (let i = 0; i < max; i++) {
      const t = trace[i];
      const params = t.params ? Object.entries(t.params).map(([k, v]) => `${k}=${v}`).join('&') : '';
      if (t.stage === 'per_keyword') {
        lines.push(`• per_keyword: "${t.keyword}" (${params}) → ${t.count}`);
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
// New search handler
// -------------------------------------------------------------

async function handleNewSearch(event, cleaned, threadTs, client) {
  try {
    const keywordPlan = await buildKeywordPlan(cleaned);
    const labels = getLabels();

    let uiLang =
      (guessUiLanguageFromText(cleaned) || 'en').toString().slice(0, 2).toLowerCase();

    const searchingText = await translateForUserLanguage(labels.searching, uiLang);

    await client.chat.postMessage({
      channel: event.channel,
      thread_ts: threadTs,
      text: searchingText
    });

    // Similar voices: if user asks "similar to <voice_id>"
    const voiceIdForSimilarity = extractVoiceIdCandidate(cleaned);
    if (voiceIdForSimilarity) {
      const searchTrace = [];
      const traceCb = (entry) => {
        try {
          searchTrace.push(entry);
        } catch (_) {}
      };
      let voices = await findSimilarVoicesByVoiceId(voiceIdForSimilarity, traceCb);
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
          listAll: detectListAll(cleaned)
        },
        lastActive: Date.now()
      };
      sessions[threadTs] = session;
      await postSessionMessages(client, event.channel, threadTs, session);
      if (process.env.POC_SEARCH_REPORT === 'true') {
        let report = buildSearchReport(searchTrace, keywordPlan, 'similar_voices', {
          unique_count: Array.isArray(voices) ? voices.length : 0
        });
        report = await translateForUserLanguage(report, uiLang);
        const reportBlocks = buildBlocksFromText(report);
        await client.chat.postMessage({
          channel: event.channel,
          thread_ts: threadTs,
          text: report,
          blocks: reportBlocks || undefined
        });
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
        listAll: detectListAll(cleaned)
      },
      lastActive: Date.now()
    };

    sessions[threadTs] = session;

    await postSessionMessages(client, event.channel, threadTs, session);

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
      const reportBlocks = buildBlocksFromText(report);
      await client.chat.postMessage({
        channel: event.channel,
        thread_ts: threadTs,
        text: report,
        blocks: reportBlocks || undefined
      });
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
    const lower = cleaned.toLowerCase();
    existing.lastActive = Date.now();

    const wantsLanguages = checkLanguagesIntent(lower);
    const wantsWhichHigh = checkWhichHighIntent(lower);
    const filtersChanged = applyFilterChangesFromText(existing, lower);

    if (wantsLanguages) {
      let msg = buildLanguagesMessage(existing);
      msg = await translateForUserLanguage(msg, existing.uiLanguage);
      const blocks = buildBlocksFromText(msg);
      await client.chat.postMessage({
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
      await client.chat.postMessage({
        channel: event.channel,
        thread_ts: threadTs,
        text: msg,
        blocks: blocks || undefined
      });
      return;
    }

    if (filtersChanged) {
      await postSessionMessages(client, event.channel, threadTs, existing);
      return;
    }

    // Refinement flow: merge new hints into the existing keyword plan
    try {
      const refinedPlan = await refineKeywordPlanFromFollowUp(
        JSON.parse(JSON.stringify(existing.keywordPlan || {})),
        cleaned
      );
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
        await client.chat.postMessage({
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

      await postSessionMessages(client, event.channel, threadTs, existing);
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
        const reportBlocks = buildBlocksFromText(report);
        await client.chat.postMessage({
          channel: event.channel,
          thread_ts: threadTs,
          text: report,
          blocks: reportBlocks || undefined
        });
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
// Start the app (for Render etc.)
// -------------------------------------------------------------

(async () => {
  validateEnvOrExit();
  startMemoryCleanup();
  const port = process.env.PORT || 3000;
  await app.start(port);
  console.log('⚡️ voices-bot is running on port ' + port);
})();
