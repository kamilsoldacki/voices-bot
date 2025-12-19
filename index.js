const { App } = require('@slack/bolt');
const axios = require('axios');

// --------------------- In-memory sessions ---------------------
const sessions = {};

// --------------------- Helper functions -----------------------

// Remove Slack mentions like <@U123ABC> from the message
function cleanText(text) {
  if (!text) return '';
  return text.replace(/<@[^>]+>/g, '').trim();
}

// Detect whether a voice should be treated as "high quality"
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

// Rough guess of UI language from text (only as fallback)
function guessUiLanguageFromText(text) {
  if (!text) return 'en';
  const lower = text.toLowerCase();
  if (/[ąćęłńóśżź]/.test(lower) ||
      lower.includes('głos') ||
      lower.includes('glos') ||
      lower.includes('szukam')) {
    return 'pl';
  }
  return 'en';
}

// Detect target VOICE language (not UI) from text
function detectVoiceLanguageFromText(text) {
  if (!text) return null;
  const lower = text.toLowerCase();

  const patterns = [
    { code: 'pl', keys: ['polsk', 'po polsku', 'polish'] },
    { code: 'en', keys: ['english', 'angielsk', 'po angielsku'] },
    { code: 'es', keys: ['hiszpań', 'hiszpansk', 'spanish', 'español', 'espanol'] },
    { code: 'de', keys: ['niemiec', 'german', 'deutsch'] },
    { code: 'fr', keys: ['francus', 'french'] },
    { code: 'it', keys: ['włoski', 'wloski', 'italian'] }
  ];

  for (const entry of patterns) {
    for (const key of entry.keys) {
      if (lower.includes(key)) return entry.code;
    }
  }

  return null;
}

// Check if a voice "belongs" to a given language code (heuristic)
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
      if (!entry) continue;
      const el = (entry.language || '').toString().toLowerCase();
      if (!el) continue;
      if (el === lc || el.startsWith(lc + '-') || el.includes(lc)) return true;
      if (lc === 'pl' && (el.includes('polish') || el.includes('polski'))) return true;
      if (lc === 'en' && (el.includes('english') || el.includes('angielski'))) return true;
      if (lc === 'es' && (el.includes('spanish') || el.includes('hiszpan') || el.includes('español') || el.includes('espanol'))) return true;
    }
  }

  const blob = (
    (voice.name || '') + ' ' +
    (voice.description || '') + ' ' +
    (voice.descriptive || '') + ' ' +
    (voice.accent || '')
  ).toString().toLowerCase();

  if (lc === 'pl') {
    if (blob.includes('polish') || blob.includes('polski') || blob.includes('polska')) return true;
  }
  if (lc === 'en') {
    if (blob.includes('english') || blob.includes('angielski')) return true;
  }
  if (lc === 'es') {
    if (blob.includes('spanish') || blob.includes('hiszpan') || blob.includes('español') || blob.includes('espanol')) return true;
  }
  if (lc === 'de') {
    if (blob.includes('german') || blob.includes('niemiecki') || blob.includes('deutsch')) return true;
  }

  return false;
}

// Labels per language (headings, footers, etc.)
function getLabels(uiLang) {
  const lang = (uiLang || 'en').slice(0, 2).toLowerCase();

  if (lang === 'pl') {
    return {
      lang: 'pl',
      searching: 'Szukam głosów w Voice Library… 🔍',
      noResults:
        'Niestety nie znalazłem żadnych głosów pasujących do tego opisu. ' +
        'Spróbuj opisać głos trochę szerzej albo użyć innego sformułowania.',
      suggestedHeader: 'Proponowane głosy:',
      standardHeader: 'Głosy standardowe (nie high quality)',
      highHeader: 'Głosy wysokiej jakości',
      female: 'Kobiety',
      male: 'Mężczyźni',
      other: 'Inne / nieokreślone',
      noVoices: 'Brak głosów w tej sekcji.',
      genericFooter:
        'Możesz dopytać o to, które głosy są high quality, w jakich językach działają, ' +
        'albo doprecyzować swoje kryteria wyszukiwania.',
      femaleFilterFooter:
        'Pokazuję tylko kobiece głosy dla tego zapytania. ' +
        'Możesz dopytać o jakość, języki lub doprecyzować opis.',
      maleFilterFooter:
        'Pokazuję tylko męskie głosy dla tego zapytania. ' +
        'Możesz dopytać o jakość, języki lub doprecyzować opis.',
      languagesHeader: 'Języki wśród bieżących wyników:',
      languagesNone: 'Nie widzę informacji o językach dla tych głosów.',
      highQualityHeader: 'Te głosy są oznaczone jako high quality:',
      highQualityNone:
        'Wśród bieżących propozycji nie ma żadnych głosów high quality.',
      genericError:
        'Coś poszło nie tak przy analizie opisu lub zapytaniu do API. Spróbuj ponownie.'
    };
  }

  // default EN
  return {
    lang: 'en',
    searching: 'Searching the Voice Library for matching voices… 🔍',
    noResults:
      "I couldn't find any voices matching this description. " +
      'Try describing the voice more broadly or using different wording.',
    suggestedHeader: 'Suggested voices:',
    standardHeader: 'Standard voices (not high quality)',
    highHeader: 'High quality voices',
    female: 'Female',
    male: 'Male',
    other: 'Other / unspecified',
    noVoices: 'No voices in this section.',
    genericFooter:
      'You can ask follow-up questions about high quality vs standard voices, ' +
      'what languages they support, or refine your search with more details.',
    femaleFilterFooter:
      'Showing only female voices for your request. You can ask about their quality, languages, or refine your search further.',
    maleFilterFooter:
      'Showing only male voices for your request. You can ask about their quality, languages, or refine your search further.',
    languagesHeader: 'Languages across the current results:',
    languagesNone: 'I cannot see any language information for these voices.',
    highQualityHeader: 'These voices are marked as high quality:',
    highQualityNone:
      'None of the current suggestions are marked as high quality.',
    genericError:
      'Something went wrong while analysing your request or calling the APIs. Please try again.'
  };
}

// Format a single voice line for Slack
function formatVoiceLine(voice) {
  const url = `https://elevenlabs.io/app/voice-library?search=${encodeURIComponent(
    voice.voice_id
  )}`;
  return `<${url}|${voice.name} | ${voice.voice_id}>`;
}

// Detect "list all" intent in the text (for showing more results)
function detectListAll(text) {
  const lower = (text || '').toLowerCase();
  if (
    lower.includes('list all') ||
    lower.includes('show all') ||
    lower.includes('wymień wszystkie') ||
    lower.includes('wymien wszystkie') ||
    lower.includes('pokaż wszystkie') ||
    lower.includes('pokaz wszystkie')
  ) {
    return true;
  }
  return false;
}

// Gender classification for grouping
function getGenderGroup(voice) {
  const raw =
    (voice.gender ||
      (voice.labels && voice.labels.gender) ||
      '').toString().toLowerCase();

  if (raw === 'female' || raw === 'woman' || raw === 'f') return 'female';
  if (raw === 'male' || raw === 'man' || raw === 'm') return 'male';
  return 'other';
}

// Summarize languages across voices
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

// Build languages summary text
function buildLanguagesMessage(session) {
  const labels = getLabels(session.uiLanguage);
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

// Build "which are high quality" message
function buildWhichHighMessage(session) {
  const labels = getLabels(session.uiLanguage);
  const { voices, ranking } = session;
  const hqVoices = voices.filter(isHighQuality);

  if (!hqVoices.length) {
    return labels.highQualityNone;
  }

  const sorted = [...hqVoices].sort(
    (a, b) =>
      (ranking[b.voice_id] || 0) - (ranking[a.voice_id] || 0)
  );

  const max = Math.min(sorted.length, 20);
  let text = `${labels.highQualityHeader}\n`;
  for (let i = 0; i < max; i++) {
    const v = sorted[i];
    text += `- ${formatVoiceLine(v)}\n`;
  }

  return text;
}

// Apply filters from follow-up text to session.filters
function applyFilterChangesFromText(session, lower) {
  let changed = false;

  // Gender filters
  if (
    lower.includes('only female') ||
    lower.includes('female only') ||
    lower.includes('show only female') ||
    lower.includes('tylko kobiece') ||
    lower.includes('tylko damskie') ||
    lower.includes('tylko kobiety')
  ) {
    session.filters.gender = 'female';
    changed = true;
  } else if (
    lower.includes('only male') ||
    lower.includes('male only') ||
    lower.includes('show only male') ||
    lower.includes('tylko męskie') ||
    lower.includes('tylko meskie') ||
    lower.includes('tylko mężczyzn') ||
    lower.includes('tylko mezczyzn') ||
    lower.includes('tylko facetów') ||
    lower.includes('tylko facetow')
  ) {
    session.filters.gender = 'male';
    changed = true;
  }

  if (
    lower.includes('all genders') ||
    lower.includes('wszystkie płcie') ||
    lower.includes('wszystkie plcie')
  ) {
    session.filters.gender = 'any';
    changed = true;
  }

  // Quality filters
  if (
    lower.includes('only high quality') ||
    lower.includes('show only high quality') ||
    lower.includes('tylko high quality') ||
    lower.includes('pokaż tylko high quality') ||
    lower.includes('pokaz tylko high quality') ||
    lower.includes('only hq') ||
    lower.includes('tylko hq')
  ) {
    session.filters.quality = 'high_only';
    changed = true;
  } else if (
    lower.includes('without high quality') ||
    lower.includes('no high quality') ||
    lower.includes('show without high quality') ||
    lower.includes('bez high quality')
  ) {
    session.filters.quality = 'no_high';
    changed = true;
  } else if (
    lower.includes('any quality') ||
    lower.includes('all qualities') ||
    lower.includes('dowolna jakość') ||
    lower.includes('dowolna jakosc')
  ) {
    session.filters.quality = 'any';
    changed = true;
  }

  // Show all / list all
  if (
    lower.includes('list all') ||
    lower.includes('show all') ||
    lower.includes('wymień wszystkie') ||
    lower.includes('wymien wszystkie') ||
    lower.includes('pokaż wszystkie') ||
    lower.includes('pokaz wszystkie')
  ) {
    session.filters.listAll = true;
    changed = true;
  }

  return changed;
}

function checkLanguagesIntent(lower) {
  return (
    lower.includes('language') ||
    lower.includes('languages') ||
    lower.includes('język') ||
    lower.includes('jezyk') ||
    lower.includes('języki') ||
    lower.includes('jezyki')
  );
}

function checkWhichHighIntent(lower) {
  if (lower.includes('high quality')) {
    if (lower.includes('which') || lower.includes('które') || lower.includes('ktore')) {
      return true;
    }
  }
  return false;
}

// Detect special "top by language" intent (e.g. "najczęściej używane polskie głosy")
function detectSpecialIntent(userText, plan) {
  const lower = (userText || '').toLowerCase();

  const hasUsageKeyword =
    lower.includes('najczęściej używan') ||
    lower.includes('najczesciej uzywan') ||
    lower.includes('najpopularniejsze') ||
    lower.includes('most used') ||
    lower.includes('most popular') ||
    lower.includes('top used') ||
    lower.includes('top voices') ||
    lower.includes('most frequently used');

  if (!hasUsageKeyword) {
    return { mode: 'generic', languageCode: null };
  }

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

// ---------------- GPT: build search plan ----------------------

async function buildSearchPlan(userText) {
  const systemPrompt = `
You are an assistant that takes a user's description of the voice they want (in ANY language)
and produces a JSON search plan for the ElevenLabs Voice Library (GET /v1/shared-voices).

Return ONLY a single JSON object. No markdown, no extra text.

The JSON MUST have exactly these fields:

{
  "user_interface_language": string,      // 2-letter code like "en", "pl", "es" for the language the user is writing in
  "target_voice_language": string or null,// 2-letter code like "en", "pl" for the language of the VOICE the user wants
  "target_accent": string or null,        // e.g. "american", "british", "polish"
  "target_gender": "male" | "female" | "neutral" | null,
  "use_cases": string[],                  // 0-5 short English tags like ["agent","ivr","tiktok","narration"]
  "tone_descriptors": string[],           // 0-8 short English adjectives, lowercase, like ["calm","confident","deep"]
  "quality_preference": "any" | "high_only" | "no_high",
  "search_queries": string[]              // 1-7 different short English search queries, using synonyms and variations
}

GUIDELINES:

- user_interface_language:
  - Detect from the user's message language (e.g. Polish -> "pl", English -> "en").
- target_voice_language:
  - Language of the VOICE the user wants (e.g. "en" for an American English voice, "pl" for Polish).
- target_accent:
  - Accent of the VOICE (e.g. "american","british","polish"), or null if unclear.
- target_gender:
  - "male" / "female" / "neutral" when the user clearly implies it, else null.

- use_cases:
  - Infer from context: "IVR","agent","support","youtube","tiktok","audiobook","narration","gaming" etc.
  - Use short English tags.

- tone_descriptors:
  - Extract adjectives / tone: "calm","confident","deep","low","warm","friendly","villain","energetic" etc.
  - Use English, lowercase.

- quality_preference:
  - "high_only" ONLY if the user explicitly asks for "high quality" or equivalent.
  - "no_high" ONLY if the user explicitly excludes high quality ("without high quality", "no HQ").
  - Words like "best", "top", "great", "good", "premium" are NOT enough to set "high_only".
  - In all other cases use "any".

- search_queries:
  - Build several different English queries combining:
    - language, accent, gender, use_cases, tone_descriptors, and general synonyms.
  - Example for "niski głos amerykański, spokojny, do agenta":
    - "deep calm american male voice for support agent"
    - "low baritone american voice for customer service"
    - "calm confident american voice for conversational agent"
  - Queries should be short text suitable for the "search" parameter and full-text search.
`.trim();

  const payload = {
    model: 'gpt-5.1-mini',
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userText }
    ],
    temperature: 0
  };

  try {
    const response = await axios.post(
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

    if (!plan.user_interface_language || typeof plan.user_interface_language !== 'string') {
      plan.user_interface_language = guessUiLanguageFromText(userText);
    }

    if (!Array.isArray(plan.use_cases)) plan.use_cases = [];
    if (!Array.isArray(plan.tone_descriptors)) plan.tone_descriptors = [];
    if (!Array.isArray(plan.search_queries) || plan.search_queries.length === 0) {
      plan.search_queries = [userText];
    }

    if (!['any', 'high_only', 'no_high'].includes(plan.quality_preference)) {
      plan.quality_preference = 'any';
    }

    if (!plan.target_voice_language) {
      const inferredLang = detectVoiceLanguageFromText(userText);
      if (inferredLang) plan.target_voice_language = inferredLang;
    }

    if (plan.target_voice_language === '') plan.target_voice_language = null;
    if (plan.target_accent === '') plan.target_accent = null;
    if (plan.target_gender === '') plan.target_gender = null;

    return plan;
  } catch (error) {
    console.error('Failed to build search plan from OpenAI. Falling back to basic defaults.', error);

    return {
      user_interface_language: guessUiLanguageFromText(userText),
      target_voice_language: detectVoiceLanguageFromText(userText),
      target_accent: null,
      target_gender: null,
      use_cases: [],
      tone_descriptors: [],
      quality_preference: 'any',
      search_queries: [userText]
    };
  }
}

// ---------------- ElevenLabs: fetch voices --------------------

async function fetchVoicesForSearchPlan(plan) {
  const XI_KEY = process.env.ELEVENLABS_API_KEY;
  const seen = new Map();
  const sourceRank = { primary: 3, language: 2, fallback: 1 };

  function addVoices(list, sourceHint) {
    if (!Array.isArray(list)) return;
    for (const raw of list) {
      if (!raw || !raw.voice_id) continue;
      const existing = seen.get(raw.voice_id);
      if (!existing) {
        const v = { ...raw, _source_hint: sourceHint };
        seen.set(raw.voice_id, v);
      } else {
        const oldRank = sourceRank[existing._source_hint] || 0;
        const newRank = sourceRank[sourceHint] || 0;
        if (newRank > oldRank) {
          existing._source_hint = sourceHint;
        }
      }
    }
  }

  async function callSharedVoices(params, sourceHint) {
    const url = `https://api.elevenlabs.io/v1/shared-voices?${params.toString()}`;

    const res = await axios.get(url, {
      headers: {
        'xi-api-key': XI_KEY,
        'Content-Type': 'application/json'
      },
      timeout: 10000
    });

    addVoices(res.data.voices || [], sourceHint);
  }

  const wantsHighOnly = plan.quality_preference === 'high_only';
  const wantsNoHigh = plan.quality_preference === 'no_high';

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

  const useCases = Array.isArray(plan.use_cases)
    ? plan.use_cases.filter(Boolean)
    : [];
  const toneDescs = Array.isArray(plan.tone_descriptors)
    ? plan.tone_descriptors.filter(Boolean)
    : [];

  const queries =
    Array.isArray(plan.search_queries) && plan.search_queries.length
      ? plan.search_queries.slice(0, 5)
      : [null];

  function buildParams(options) {
    const {
      page_size,
      withLanguage,
      withAccent,
      withGender,
      includeUseCases,
      includeDescriptives,
      search
    } = options;

    const params = new URLSearchParams();
    params.set('page_size', String(page_size || 30));
    if (withLanguage && language) params.set('language', language);
    if (withAccent && accent) params.set('accent', accent);
    if (withGender && gender) params.set('gender', gender);

    if (includeUseCases && useCases.length) {
      useCases.forEach((uc) => params.append('use_cases', uc));
    }
    if (includeDescriptives && toneDescs.length) {
      toneDescs.forEach((td) => params.append('descriptives', td));
    }

    if (search && String(search).trim().length > 0) {
      params.set('search', String(search).trim());
    }

    return params;
  }

  // STEP 1: focused search with search queries + language/accent/gender + use_cases/descriptives
  for (const q of queries) {
    const params = buildParams({
      page_size: 40,
      withLanguage: !!language,
      withAccent: !!accent,
      withGender: !!gender,
      includeUseCases: true,
      includeDescriptives: true,
      search: q
    });

    try {
      await callSharedVoices(params, 'primary');
    } catch (err) {
      console.error('Error calling shared voices (step 1):', err.message || err);
    }

    if (seen.size >= 50) break;
  }

  // STEP 2: if still few voices and we know language, fetch a broader sample for that language
  if (seen.size < 25 && language) {
    const params = buildParams({
      page_size: 80,
      withLanguage: true,
      withAccent: false,
      withGender: false,
      includeUseCases: false,
      includeDescriptives: false,
      search: null
    });

    try {
      await callSharedVoices(params, 'language');
    } catch (err) {
      console.error('Error calling shared voices (step 2):', err.message || err);
    }
  }

  // STEP 3: if STILL few voices, get a small global fallback sample
  if (seen.size < 15) {
    const params = buildParams({
      page_size: 60,
      withLanguage: false,
      withAccent: false,
      withGender: false,
      includeUseCases: false,
      includeDescriptives: false,
      search: null
    });

    try {
      await callSharedVoices(params, 'fallback');
    } catch (err) {
      console.error('Error calling shared voices (step 3):', err.message || err);
    }
  }

  let voices = Array.from(seen.values());

  // Limit global fallback voices so they don't dominate
  const primaryAndLang = voices.filter((v) => v._source_hint !== 'fallback');
  const fallbackVoices = voices.filter((v) => v._source_hint === 'fallback');

  fallbackVoices.sort((a, b) => {
    const ua = a.usage_character_count_1y || a.usage_character_count_7d || 0;
    const ub = b.usage_character_count_1y || b.usage_character_count_7d || 0;
    return ub - ua;
  });

  const limitedFallback = fallbackVoices.slice(0, 10);
  voices = primaryAndLang.concat(limitedFallback);

  // Hard(er) language filter if we know it and have enough matches
  if (language && voices.length) {
    const langVoices = voices.filter((v) => isVoiceInLanguage(v, language));
    if (langVoices.length >= 8) {
      voices = langVoices;
    }
  }

  // Apply quality preference AFTER collecting candidates
  if (wantsHighOnly) {
    const onlyHigh = voices.filter(isHighQuality);
    if (onlyHigh.length) voices = onlyHigh;
  } else if (wantsNoHigh) {
    const onlyStandard = voices.filter((v) => !isHighQuality(v));
    if (onlyStandard.length) voices = onlyStandard;
  }

  return voices;
}

// Special mode: "top by language" – most used voices in a given language
async function fetchTopVoicesByLanguage(languageCode) {
  const XI_KEY = process.env.ELEVENLABS_API_KEY;

  const params = new URLSearchParams();
  params.set('page_size', '100');
  params.set('language', languageCode);

  const url = `https://api.elevenlabs.io/v1/shared-voices?${params.toString()}`;

  const res = await axios.get(url, {
    headers: {
      'xi-api-key': XI_KEY,
      'Content-Type': 'application/json'
    },
    timeout: 10000
  });

  let voices = res.data.voices || [];

  if (!voices.length) {
    return [];
  }

  voices.sort((a, b) => {
    const ua = a.usage_character_count_1y || a.usage_character_count_7d || 0;
    const ub = b.usage_character_count_1y || b.usage_character_count_7d || 0;
    return ub - ua;
  });

  voices = voices.slice(0, 80);

  voices.forEach((v) => {
    v._source_hint = 'primary';
  });

  return voices;
}

// --------------- GPT: rank voices (no formatting) --------------

async function rankVoicesWithGPT(userText, plan, voices) {
  const topCandidates = voices.slice(0, 80);
  const candidates = topCandidates.map((v) => ({
    voice_id: v.voice_id,
    name: v.name,
    language: v.language,
    accent: v.accent,
    gender: v.gender,
    age: v.age,
    descriptive: v.descriptive,
    use_case: v.use_case,
    category: v.category,
    usage_character_count_1y: v.usage_character_count_1y,
    cloned_by_count: v.cloned_by_count,
    featured: v.featured,
    description: v.description,
    verified_languages: v.verified_languages,
    high_quality_base_model_ids: v.high_quality_base_model_ids,
    source_hint: v._source_hint || 'fallback'
  }));

  const systemPrompt = `
You are an assistant that ranks candidate ElevenLabs voices for a user's request.

You will receive a JSON object with:
{
  "user_query": string,
  "search_plan": object,
  "candidate_voices": [
    {
      "voice_id": string,
      "name": string,
      "language": string or null,
      "accent": string or null,
      "gender": string or null,
      "descriptive": string or null,
      "use_case": string or null,
      "category": string or null,
      "usage_character_count_1y": number or null,
      "cloned_by_count": number or null,
      "featured": boolean or null,
      "description": string or null,
      "verified_languages": array or null,
      "high_quality_base_model_ids": array or null,
      "source_hint": "primary" | "language" | "fallback"
    },
    ...
  ]
}

Return ONLY a single JSON object with this structure:

{
  "user_language": string,   // 2-letter code for the user's language, e.g. "en","pl"
  "ranking": [
    {
      "voice_id": string,    // must be one of the candidate_voices.voice_id
      "score": number        // between 0.0 and 1.0, higher = better match
    },
    ...
  ]
}

RULES:
- Include EACH candidate_voices.voice_id EXACTLY ONCE in "ranking".
- Interpret "source_hint":
  - "primary": voices that come from direct search using the user's description, language, accent etc.
  - "language": voices that match the language but were not directly matched on text.
  - "fallback": generic popular voices.
- Strongly prefer "primary" voices for high scores when they semantically match the query.
- Prefer "language" voices over "fallback" ones.
- "fallback" voices should usually get lower scores and only appear near the bottom unless the query is extremely generic and there are no better matches.
- Use language, accent, gender, descriptive, use_case, category, popularity (usage_character_count_1y, cloned_by_count, featured) to estimate how well each voice matches the user_query.
- 1.0 = perfect match; 0.0 = very weak/irrelevant.
- If you are unsure, assign a mid-range score, but still include the voice.
- user_language should reflect the language of the user's query (e.g. "pl" for Polish).
- Do NOT add extra fields.
`.trim();

  const payload = {
    model: 'gpt-5.1',
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: JSON.stringify({
          user_query: userText,
          search_plan: plan,
          candidate_voices: candidates
        })
      }
    ],
    temperature: 0
  };

  try {
    const response = await axios.post(
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

    const voicesById = {};
    topCandidates.forEach((v) => {
      voicesById[v.voice_id] = true;
    });

    const rankingArray = Array.isArray(data.ranking) ? data.ranking : [];
    const scoreMap = {};

    rankingArray.forEach((item, index) => {
      if (!item || !item.voice_id) return;
      const id = item.voice_id;
      if (!voicesById[id]) return;
      let score = typeof item.score === 'number' ? item.score : null;
      if (score === null || isNaN(score)) {
        score = (rankingArray.length - index) / rankingArray.length;
      }
      scoreMap[id] = score;
    });

    // Ensure every candidate has some score
    topCandidates.forEach((v, idx) => {
      if (!scoreMap[v.voice_id]) {
        scoreMap[v.voice_id] = ((topCandidates.length - idx) / topCandidates.length) * 0.2;
      }
    });

    // Penalize fallback voices so they don't dominate
    const multipliers = { primary: 1.0, language: 0.9, fallback: 0.5 };
    topCandidates.forEach((v) => {
      const hint = v._source_hint || 'fallback';
      const factor = multipliers[hint] || 0.5;
      scoreMap[v.voice_id] = (scoreMap[v.voice_id] || 0) * factor;
    });

    const userLang =
      (data.user_language ||
        plan.user_interface_language ||
        guessUiLanguageFromText(userText) ||
        'en')
        .toString()
        .slice(0, 2)
        .toLowerCase();

    return { scoreMap, userLanguage: userLang };
  } catch (error) {
    console.error('Failed to rank voices with OpenAI. Falling back to API order.', error);

    const scoreMap = {};
    voices.forEach((v, idx) => {
      scoreMap[v.voice_id] = (voices.length - idx) / voices.length;
    });

    const userLang =
      (plan.user_interface_language ||
        guessUiLanguageFromText(userText) ||
        'en')
        .toString()
        .slice(0, 2)
        .toLowerCase();

    return { scoreMap, userLanguage: userLang };
  }
}

// ---------------- Build Slack message from session -------------

function buildMessageFromSession(session) {
  const { voices, ranking, uiLanguage, filters } = session;
  const labels = getLabels(uiLanguage);

  const maxPerGender = filters.listAll ? 50 : 5;

  const sorted = [...voices].sort(
    (a, b) =>
      (ranking[b.voice_id] || 0) - (ranking[a.voice_id] || 0)
  );

  const qualityFilter = filters.quality || 'any';
  const genderFilter = filters.gender || 'any';

  const sections = {
    standard: { female: [], male: [], other: [] },
    high: { female: [], male: [], other: [] }
  };

  sorted.forEach((v) => {
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

  const lines = [];
  lines.push(labels.suggestedHeader);
  lines.push('');

  function appendSection(title, sectionKey) {
    const groups = sections[sectionKey];
    const order = ['female', 'male', 'other'];
    const genderLabels = {
      female: labels.female,
      male: labels.male,
      other: labels.other
    };

    lines.push(`### ${title}`);

    if (genderFilter !== 'any') {
      const key = genderFilter;
      const label = genderLabels[key];
      const arr = groups[key];

      lines.push(`**${label}:**`);
      if (!arr.length) {
        lines.push(`- ${labels.noVoices}`);
      } else {
        arr.forEach((v) => {
          lines.push(`- ${formatVoiceLine(v)}`);
        });
      }
      lines.push('');
      return;
    }

    // Show all genders
    order.forEach((key) => {
      const label = genderLabels[key];
      const arr = groups[key];

      lines.push(`**${label}:**`);
      if (!arr.length) {
        lines.push(`- ${labels.noVoices}`);
      } else {
        arr.forEach((v) => {
          lines.push(`- ${formatVoiceLine(v)}`);
        });
      }
      lines.push('');
    });
  }

  appendSection(labels.standardHeader, 'standard');
  appendSection(labels.highHeader, 'high');

  if (genderFilter === 'female') {
    lines.push(labels.femaleFilterFooter || labels.genericFooter);
  } else if (genderFilter === 'male') {
    lines.push(labels.maleFilterFooter || labels.genericFooter);
  } else {
    lines.push(labels.genericFooter);
  }

  return lines.join('\n');
}

// ---------------- New search handler --------------------------

async function handleNewSearch(event, cleaned, threadTs, client) {
  try {
    // 1) Build search plan via GPT
    const searchPlan = await buildSearchPlan(cleaned);

    const uiLangFromPlan = (searchPlan.user_interface_language || 'en')
      .toString()
      .slice(0, 2)
      .toLowerCase();
    const labelsForSearching = getLabels(uiLangFromPlan);

    // 2) Inform user we're searching
    await client.chat.postMessage({
      channel: event.channel,
      thread_ts: threadTs,
      text: labelsForSearching.searching
    });

    // 3) Check for special "top by language" intent
    const special = detectSpecialIntent(cleaned, searchPlan);
    let voices;
    let scoreMap;
    let finalUiLang;

    if (special.mode === 'top_by_language' && special.languageCode) {
      // TOP BY LANGUAGE mode – e.g. "najczęściej używane polskie głosy"
      voices = await fetchTopVoicesByLanguage(special.languageCode);
      if (!voices.length) {
        await client.chat.postMessage({
          channel: event.channel,
          thread_ts: threadTs,
          text: labelsForSearching.noResults
        });
        return;
      }

      // Ranking purely by usage
      const maxUsage = voices.reduce((max, v) => {
        const u = v.usage_character_count_1y || v.usage_character_count_7d || 0;
        return u > max ? u : max;
      }, 0);

      scoreMap = {};
      if (maxUsage > 0) {
        voices.forEach((v) => {
          const u = v.usage_character_count_1y || v.usage_character_count_7d || 0;
          scoreMap[v.voice_id] = u / maxUsage || 0.01;
        });
      } else {
        voices.forEach((v, idx) => {
          scoreMap[v.voice_id] = (voices.length - idx) / voices.length;
        });
      }

      finalUiLang =
        (searchPlan.user_interface_language ||
          guessUiLanguageFromText(cleaned) ||
          'en')
          .toString()
          .slice(0, 2)
          .toLowerCase();
    } else {
      // GENERIC mode – semantic search & ranking
      voices = await fetchVoicesForSearchPlan(searchPlan);
      if (!voices.length) {
        await client.chat.postMessage({
          channel: event.channel,
          thread_ts: threadTs,
          text: labelsForSearching.noResults
        });
        return;
      }

      const ranked = await rankVoicesWithGPT(cleaned, searchPlan, voices);
      scoreMap = ranked.scoreMap;
      finalUiLang = ranked.userLanguage || uiLangFromPlan;
    }

    const listAll = detectListAll(cleaned);

    const session = {
      originalQuery: cleaned,
      searchPlan,
      voices,
      ranking: scoreMap,
      uiLanguage: finalUiLang,
      filters: {
        quality: searchPlan.quality_preference || 'any',
        gender: 'any',
        listAll
      }
    };

    sessions[threadTs] = session;

    // 4) Build final Slack message
    const message = buildMessageFromSession(session);

    await client.chat.postMessage({
      channel: event.channel,
      thread_ts: threadTs,
      text: message
    });
  } catch (error) {
    console.error('Error in handleNewSearch:', error);
    const labels = getLabels('en');
    await client.chat.postMessage({
      channel: event.channel,
      thread_ts: threadTs,
      text: labels.genericError
    });
  }
}

// ---------------- Slack Bolt app & events ---------------------

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

  const existing = sessions[threadTs];

  if (existing) {
    // Follow-up logic: filters and info based on previous results
    const lower = cleaned.toLowerCase();

    const wantsLanguages = checkLanguagesIntent(lower);
    const wantsWhichHigh = checkWhichHighIntent(lower);
    const filtersChanged = applyFilterChangesFromText(existing, lower);

    if (wantsLanguages) {
      const msg = buildLanguagesMessage(existing);
      await client.chat.postMessage({
        channel: event.channel,
        thread_ts: threadTs,
        text: msg
      });
      return;
    }

    if (wantsWhichHigh) {
      const msg = buildWhichHighMessage(existing);
      await client.chat.postMessage({
        channel: event.channel,
        thread_ts: threadTs,
        text: msg
      });
      return;
    }

    if (filtersChanged) {
      const msg = buildMessageFromSession(existing);
      await client.chat.postMessage({
        channel: event.channel,
        thread_ts: threadTs,
        text: msg
      });
      return;
    }

    // If no clear follow-up intent, treat as a brand new search in this thread
  }

  // No existing session (or this looks like a new query) -> new search
  await handleNewSearch(event, cleaned, threadTs, client);
});

// Start the app (Render uses PORT)
(async () => {
  const port = process.env.PORT || 3000;
  await app.start(port);
  console.log('⚡️ voices-bot is running on port ' + port);
})();
