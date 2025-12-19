const { App } = require('@slack/bolt');
const axios = require('axios');

// -------------------------------------------------------------
// In-memory conversation sessions (per Slack thread)
// -------------------------------------------------------------
const sessions = {};

// -------------------------------------------------------------
// Small helpers
// -------------------------------------------------------------

function cleanText(text) {
  if (!text) return '';
  // remove Slack mentions like <@U123ABC>
  return text.replace(/<@[^>]+>/g, '').trim();
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
    lower.includes('polski glos')
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

  if (
    lower.includes('only high quality') ||
    lower.includes('high quality only') ||
    lower.includes('just high quality') ||
    lower.includes('hq only') ||
    lower.includes('only hq')
  ) {
    return 'high_only';
  }

  if (
    lower.includes('without high quality') ||
    lower.includes('no high quality') ||
    lower.includes('exclude high quality') ||
    lower.includes('standard only')
  ) {
    return 'no_high';
  }

  return null;
}

// UI labels – EN only (all user-facing Slack text)
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
  return `<${url}|${voice.name} | ${voice.voice_id}>`;
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
  return lower.includes('language') || lower.includes('languages');
}

function checkWhichHighIntent(lower) {
  return lower.includes('which') && lower.includes('high quality');
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
    model: 'gpt-4.1-mini',
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
    if (qp) {
      plan.quality_preference = qp;
    }

    return plan;
  } catch (error) {
    console.error('Failed to build keyword plan from OpenAI. Falling back to basic defaults.', error);

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

async function fetchVoicesByKeywords(plan, userText) {
  const XI_KEY = process.env.ELEVENLABS_API_KEY;
  const seen = new Map(); // voice_id -> { voice, matchedKeywords: Set<string> }

  async function callSharedVoices(params) {
    const url = `https://api.elevenlabs.io/v1/shared-voices?${params.toString()}`;
    const res = await axios.get(url, {
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
  const allKw = [
    ...(plan.tone_keywords || []),
    ...(plan.use_case_keywords || []),
    ...(plan.character_keywords || []),
    ...(plan.style_keywords || []),
    ...(plan.extra_keywords || [])
  ];

  const normalizedKw = Array.from(
    new Set(
      allKw
        .map((x) => (x || '').toString().toLowerCase().trim())
        .filter((x) => x.length > 0)
    )
  );

  // If GPT gave us nothing reasonable, use full user text as one keyword
  if (!normalizedKw.length && userText) {
    normalizedKw.push(userText.toLowerCase());
  }

  const MAX_KEYWORD_QUERIES = 10;
  const selectedKeywords = normalizedKw.slice(0, MAX_KEYWORD_QUERIES);

  // 1) separate search for EACH keyword
  for (const kw of selectedKeywords) {
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
      const voicesForKeyword = await callSharedVoices(params);

      voicesForKeyword.forEach((voice) => {
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
    } catch (err) {
      console.error('Error fetching voices for keyword:', kw, err.message || err);
    }
  }

  // 2) fallback: if nothing found at all
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
      (normalizedKw.length ? normalizedKw.join(' ') : '') ||
      (userText ? userText.toLowerCase() : '');

    if (fallbackSearch) {
      params.set('search', fallbackSearch);
    }

    try {
      const fallbackVoices = await callSharedVoices(params);
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

  // 3) convert map -> list, attach matched_keywords
  let voices = Array.from(seen.values()).map((entry) => {
    const v = entry.voice;
    v._matched_keywords = Array.from(entry.matchedKeywords || []);
    return v;
  });

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

  return voices;
}

// -------------------------------------------------------------
// GPT: curator – rank voices for this specific brief
// -------------------------------------------------------------

async function rankVoicesWithGPT(userText, keywordPlan, voices) {
  const MAX_VOICES = 80;
  const candidates = voices.slice(0, MAX_VOICES).map((v) => ({
    voice_id: v.voice_id,
    name: v.name,
    language: v.language || null,
    accent: v.accent || null,
    gender: v.gender || null,
    description: v.description || null,
    descriptive: v.descriptive || null,
    use_case: v.use_case || null,
    labels: v.labels || null,
    category: v.category || null,
    usage_character_count_1y:
      v.usage_character_count_1y || v.usage_character_count_7d || null,
    verified_languages: v.verified_languages || null,
    matched_keywords: v._matched_keywords || []
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
      "use_case": string or null,
      "labels": object or null,
      "category": string or null,
      "usage_character_count_1y": number or null,
      "verified_languages": array or null,
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
    model: 'gpt-4.1',
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
    console.error('Failed to rank voices with GPT, falling back to API order.', err);

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

  const showStandardSection = qualityFilter !== 'high_only';
  const showHighSection = qualityFilter !== 'no_high';

  const lines = [];

  lines.push(
    labels.suggestedHeader +
      (originalQuery ? `\n> “${originalQuery.trim()}”` : '')
  );
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
        lines.push(labels.noVoices);
      } else {
        arr.forEach((v) => {
          lines.push(`- ${formatVoiceLine(v)}`);
        });
      }
      lines.push('');
      return;
    }

    // all genders
    order.forEach((key) => {
      const label = genderLabels[key];
      const arr = groups[key];

      lines.push(`**${label}:**`);
      if (!arr.length) {
        lines.push(labels.noVoices);
      } else {
        arr.forEach((v) => {
          lines.push(`- ${formatVoiceLine(v)}`);
        });
      }
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

// -------------------------------------------------------------
// New search handler
// -------------------------------------------------------------

async function handleNewSearch(event, cleaned, threadTs, client) {
  try {
    const keywordPlan = await buildKeywordPlan(cleaned);
    const labels = getLabels();

    await client.chat.postMessage({
      channel: event.channel,
      thread_ts: threadTs,
      text: labels.searching
    });

    const voices = await fetchVoicesByKeywords(keywordPlan, cleaned);

    if (!voices.length) {
      await client.chat.postMessage({
        channel: event.channel,
        thread_ts: threadTs,
        text: labels.noResults
      });
      return;
    }

    const ranked = await rankVoicesWithGPT(cleaned, keywordPlan, voices);

    const session = {
      originalQuery: cleaned,
      keywordPlan,
      voices,
      ranking: ranked.scoreMap,
      uiLanguage: ranked.userLanguage,
      filters: {
        quality: keywordPlan.quality_preference || 'any',
        gender: 'any',
        listAll: detectListAll(cleaned)
      }
    };

    sessions[threadTs] = session;

    const message = buildMessageFromSession(session);

    await client.chat.postMessage({
      channel: event.channel,
      thread_ts: threadTs,
      text: message
    });
  } catch (error) {
    console.error('Error in handleNewSearch:', error);
    const labels = getLabels();
    await client.chat.postMessage({
      channel: event.channel,
      thread_ts: threadTs,
      text: labels.genericError
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

  const existing = sessions[threadTs];

  if (existing) {
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

    // If it doesn't look like a follow-up filter → treat as a brand new search
  }

  await handleNewSearch(event, cleaned, threadTs, client);
});

// -------------------------------------------------------------
// Start the app (for Render etc.)
// -------------------------------------------------------------

(async () => {
  const port = process.env.PORT || 3000;
  await app.start(port);
  console.log('⚡️ voices-bot is running on port ' + port);
})();
