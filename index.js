const { App } = require('@slack/bolt');
const axios = require('axios');

// Simple in-memory session store: Slack thread -> last search context
const sessions = {};

// Remove Slack mentions like <@U123ABC> from the message
function cleanText(text) {
  if (!text) return '';
  return text.replace(/<@[^>]+>/g, '').trim();
}

// Detect whether a voice should be treated as "high quality"
function isHighQuality(voice) {
  if (!voice || typeof voice !== 'object') return false;

  // 1) Direct category flag
  const cat = (voice.category || '').toString().toLowerCase();
  if (cat === 'high_quality' || cat === 'high quality') return true;

  // 2) Some APIs may nest category under sharing
  if (voice.sharing && typeof voice.sharing === 'object') {
    const sharingCat = (voice.sharing.category || '').toString().toLowerCase();
    if (sharingCat === 'high_quality' || sharingCat === 'high quality') {
      return true;
    }
  }

  // 3) Official "high quality base models" flag
  if (
    Array.isArray(voice.high_quality_base_model_ids) &&
    voice.high_quality_base_model_ids.length > 0
  ) {
    return true;
  }

  // 4) Labels that explicitly mark a voice as high quality
  if (voice.labels && typeof voice.labels === 'object') {
    const labelHq = String(voice.labels.high_quality || '').toLowerCase();
    if (labelHq === 'true' || labelHq === 'yes' || labelHq === '1') {
      return true;
    }
  }

  if (
    voice.sharing &&
    typeof voice.sharing === 'object' &&
    voice.sharing.labels &&
    typeof voice.sharing.labels === 'object'
  ) {
    const labelHq = String(voice.sharing.labels.high_quality || '').toLowerCase();
    if (labelHq === 'true' || labelHq === 'yes' || labelHq === '1') {
      return true;
    }
  }

  return false;
}

// Build a semantic search plan using GPT
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
  - Language of the VOICE the user wants (e.g. "en" for an American English voice).
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
    model: 'gpt-4o-mini',
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

    const content = response.data.choices[0].message.content.trim();
    let plan = JSON.parse(content);

    // Basic sanitization / defaults
    if (!plan.user_interface_language || typeof plan.user_interface_language !== 'string') {
      plan.user_interface_language = 'en';
    }

    if (!Array.isArray(plan.use_cases)) plan.use_cases = [];
    if (!Array.isArray(plan.tone_descriptors)) plan.tone_descriptors = [];
    if (!Array.isArray(plan.search_queries) || plan.search_queries.length === 0) {
      plan.search_queries = [userText];
    }

    if (!['any', 'high_only', 'no_high'].includes(plan.quality_preference)) {
      plan.quality_preference = 'any';
    }

    if (plan.target_voice_language === '') plan.target_voice_language = null;
    if (plan.target_accent === '') plan.target_accent = null;
    if (plan.target_gender === '') plan.target_gender = null;

    return plan;
  } catch (error) {
    console.error('Failed to build search plan from OpenAI. Falling back to basic defaults.', error);

    return {
      user_interface_language: 'en',
      target_voice_language: null,
      target_accent: null,
      target_gender: null,
      use_cases: [],
      tone_descriptors: [],
      quality_preference: 'any',
      search_queries: [userText]
    };
  }
}

// Fetch candidate voices from ElevenLabs Voice Library using a robust multi-step strategy
async function fetchVoicesForSearchPlan(plan) {
  const seen = new Set();
  let voices = [];

  const wantsHighOnly = plan.quality_preference === 'high_only';
  const wantsNoHigh = plan.quality_preference === 'no_high';

  // Normalize values for API
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

  const queries =
    Array.isArray(plan.search_queries) && plan.search_queries.length
      ? plan.search_queries.slice(0, 5)
      : [null];

  const XI_KEY = process.env.ELEVENLABS_API_KEY;

  async function callSharedVoices(params) {
    const url = `https://api.elevenlabs.io/v1/shared-voices?${params.toString()}`;

    const res = await axios.get(url, {
      headers: {
        'xi-api-key': XI_KEY,
        'Content-Type': 'application/json'
      },
      timeout: 10000
    });

    const chunk = res.data.voices || [];
    for (const v of chunk) {
      if (v && v.voice_id && !seen.has(v.voice_id)) {
        seen.add(v.voice_id);
        voices.push(v);
      }
    }
  }

  function buildParams({ page_size, withLanguage, withAccent, withGender, search }) {
    const params = new URLSearchParams();
    params.set('page_size', String(page_size || 30));

    if (withLanguage && language) params.set('language', language);
    if (withAccent && accent) params.set('accent', accent);
    if (withGender && gender) params.set('gender', gender);

    if (search && String(search).trim().length > 0) {
      params.set('search', String(search).trim());
    }

    return params;
  }

  // STEP 1: Narrow fuzzy search using search queries + language/accent/gender (if available)
  for (const q of queries) {
    const params = buildParams({
      page_size: 30,
      withLanguage: !!language,
      withAccent: !!accent,
      withGender: !!gender,
      search: q
    });

    try {
      await callSharedVoices(params);
    } catch (err) {
      console.error('Error calling shared voices (step 1):', err.message || err);
    }

    if (voices.length >= 30) break;
  }

  // STEP 2: If we still have few voices and we know the language, fetch a broad sample of ALL voices in that language
  if (voices.length < 20 && language) {
    const params = buildParams({
      page_size: 100,
      withLanguage: true,
      withAccent: false,
      withGender: false
    });

    try {
      await callSharedVoices(params);
    } catch (err) {
      console.error('Error calling shared voices (step 2):', err.message || err);
    }
  }

  // STEP 3: If STILL very few voices, fall back to a general sample of the library
  if (voices.length < 10) {
    const params = buildParams({
      page_size: 100,
      withLanguage: false,
      withAccent: false,
      withGender: false
    });

    try {
      await callSharedVoices(params);
    } catch (err) {
      console.error('Error calling shared voices (step 3):', err.message || err);
    }
  }

  // Apply high quality filters AFTER collecting broad candidates
  let result = voices;

  if (wantsHighOnly) {
    const onlyHigh = voices.filter(isHighQuality);
    if (onlyHigh.length) result = onlyHigh;
  } else if (wantsNoHigh) {
    const onlyStandard = voices.filter(v => !isHighQuality(v));
    if (onlyStandard.length) result = onlyStandard;
  }

  return result;
}

// Ask GPT to act as a "voice curator" and return JSON with groups of voice_ids
async function curateVoicesWithGPT(userText, plan, voices) {
  // Map for quick lookup by id
  const byId = {};
  for (const v of voices) {
    if (v && v.voice_id) byId[v.voice_id] = v;
  }

  const candidates = voices.slice(0, 80).map(v => ({
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
    high_quality_base_model_ids: v.high_quality_base_model_ids
  }));

  const systemPrompt = `
You are an expert curator of the ElevenLabs Voice Library.

You receive:
- the user's request in natural language (in ANY language),
- a "search_plan" describing what they are looking for,
- a list of "candidate_voices" from the ElevenLabs Voice Library (GET /v1/shared-voices).

Your task is to decide WHICH candidate voices should appear in which group.
Formatting of the Slack message will be done by the caller, not by you.

You MUST return ONLY a single JSON object with EXACTLY this structure:

{
  "user_language": string,    // 2-letter code for the user's language, e.g. "en","pl","es"
  "headings": {
    "standard_section": string,        // heading text for standard voices section
    "high_quality_section": string,    // heading text for high quality section
    "female": string,                  // label for female voices
    "male": string,                    // label for male voices
    "other": string,                   // label for other/unspecified voices
    "no_voices": string                // text used when a group is empty
  },
  "standard": {
    "female": string[],       // array of voice_id strings (subset of candidate_voices.voice_id)
    "male": string[],
    "other": string[]
  },
  "high_quality": {
    "female": string[],
    "male": string[],
    "other": string[]
  },
  "footer": string            // short paragraph in the user's language explaining possible follow-up questions
}

RULES:

1. SELECTION & RANKING
   - From candidate_voices, select and order the BEST matches for the user's request.
   - Match on language, accent, gender, use_case, descriptive, age, category, and verified_languages.
   - Use popularity signals as tie-breakers: usage_character_count_1y, cloned_by_count, featured.
   - Never invent new voices. Use ONLY voice_id values that exist in candidate_voices.
   - You may ignore voices that clearly do not match the request.

2. STANDARD vs HIGH QUALITY
   - A voice is "high quality" when it either:
     - has category "high_quality" (case-insensitive), OR
     - has a non-empty high_quality_base_model_ids list, OR
     - is clearly described as high quality in its metadata.
   - All other voices are "standard".
   - Place each voice_id in exactly ONE of the standard or high_quality sections.

3. GENDER GROUPING
   - For each of "standard" and "high_quality", group voices by gender:
     - Put obviously female voices into "female".
     - Put obviously male voices into "male".
     - Put all others into "other".
   - Use only voice_id strings in those arrays.

4. HOW MANY VOICES TO RETURN
   - Normally, within each gender subgroup, include up to 5 voices (best matches first).
   - However, if the user explicitly asks to "list all" or "wymień wszystkie" or "show all"
     voices of a certain type, you may include more voices (up to about 50 total across all groups).

5. HEADINGS & FOOTER LANGUAGE
   - "user_language" should match the user's language (e.g. "en" for English, "pl" for Polish).
   - All strings inside "headings" and "footer" must be in that same language.
   - Do NOT add markdown syntax (#, **, -, etc.) inside those strings.
     They should be plain text; the caller will add markdown.

6. JSON ONLY
   - Return ONLY valid JSON for the described object.
   - Do NOT include markdown, explanations, or any other text outside the JSON.
`.trim();

  const payload = {
    model: 'gpt-4o-mini',
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
    temperature: 0.3
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

    const content = response.data.choices[0].message.content.trim();
    const data = JSON.parse(content);

    const userLangRaw =
      data.user_language ||
      plan.user_interface_language ||
      'en';

    const userLang = userLangRaw.toString().slice(0, 2).toLowerCase();

    const headings = data.headings || {};
    const standardGroups = data.standard || {};
    const highGroups = data.high_quality || {};
    const footer = typeof data.footer === 'string' ? data.footer.trim() : '';

    function getHeading(key, fallbackEn, fallbackPl) {
      const v = headings[key];
      if (typeof v === 'string' && v.trim().length > 0) return v.trim();
      if (userLang === 'pl') return fallbackPl;
      return fallbackEn;
    }

    const hStandard = getHeading(
      'standard_section',
      'Standard voices (not high quality)',
      'Głosy standardowe (nie high quality)'
    );
    const hHigh = getHeading(
      'high_quality_section',
      'High quality voices',
      'Głosy wysokiej jakości'
    );
    const hFemale = getHeading('female', 'Female:', 'Kobiety:');
    const hMale = getHeading('male', 'Male:', 'Mężczyźni:');
    const hOther = getHeading('other', 'Other / unspecified:', 'Inne / nieokreślone:');
    const noVoicesLabel = getHeading(
      'no_voices',
      'No voices in this section.',
      'Brak głosów w tej sekcji.'
    );

    function formatVoiceLine(voice) {
      const url = `https://elevenlabs.io/app/voice-library?search=${encodeURIComponent(
        voice.voice_id
      )}`;
      return `<${url}|${voice.name} | ${voice.voice_id}>`;
    }

    const lines = [];

    function appendSection(sectionTitle, groups) {
      lines.push(`### ${sectionTitle}`);

      const order = [
        { key: 'female', label: hFemale },
        { key: 'male', label: hMale },
        { key: 'other', label: hOther }
      ];

      for (const { key, label } of order) {
        const arr = Array.isArray(groups[key]) ? groups[key] : [];
        lines.push(`**${label}**`);
        let count = 0;
        for (const id of arr) {
          const v = byId[id];
          if (!v) continue;
          lines.push(`- ${formatVoiceLine(v)}`);
          count++;
        }
        if (count === 0) {
          lines.push(`- ${noVoicesLabel}`);
        }
      }

      lines.push('---');
    }

    appendSection(hStandard, standardGroups);
    appendSection(hHigh, highGroups);

    if (footer && footer.length > 0) {
      lines.push(footer);
    } else {
      if (userLang === 'pl') {
        lines.push(
          'Możesz zapytać, które głosy są high quality, o języki, które obsługują, albo doprecyzować swoje kryteria wyszukiwania.'
        );
      } else {
        lines.push(
          'Feel free to ask which voices are high quality vs standard, what languages they support, or refine your search with more details.'
        );
      }
    }

    return lines.join('\n');
  } catch (error) {
    console.error('Failed to get curated JSON from OpenAI. Falling back to simple listing.', error);

    // SIMPLE FALLBACK: naive standard/high split list in English
    const standard = voices.filter(v => !isHighQuality(v));
    const high = voices.filter(v => isHighQuality(v));

    function formatLine(v, index) {
      const url = `https://elevenlabs.io/app/voice-library?search=${encodeURIComponent(
        v.voice_id
      )}`;
      return `${index}. <${url}|${v.name} | ${v.voice_id}>`;
    }

    let text = 'Suggested voices:\n\n';

    text += '*Standard voices (not high quality):*\n';
    if (!standard.length) {
      text += '_No voices in this section._\n\n';
    } else {
      standard.slice(0, 20).forEach((v, i) => {
        text += formatLine(v, i + 1) + '\n';
      });
      text += '\n';
    }

    text += '*High quality voices:*\n';
    if (!high.length) {
      text += '_No voices in this section._\n\n';
    } else {
      high.slice(0, 20).forEach((v, i) => {
        text += formatLine(v, i + 1) + '\n';
      });
      text += '\n';
    }

    text +=
      '\nYou can ask follow-up questions about quality (standard vs high quality) or the languages these voices support.';

    return text;
  }
}

// Initialize Slack Bolt app in Socket Mode
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN
});

// Handle @mentions
app.event('app_mention', async ({ event, client }) => {
  const rawText = event.text || '';
  const cleaned = cleanText(rawText);
  const threadTs = event.thread_ts || event.ts;

  const existing = sessions[threadTs];

  // If there is already a session in this thread, treat this as extra context for the search
  const combinedText = existing
    ? `${existing.originalQuery}\n\nUser follow-up:\n${cleaned}`
    : cleaned;

  // Small immediate feedback
  await client.chat.postMessage({
    channel: event.channel,
    thread_ts: threadTs,
    text: 'Searching the Voice Library for matching voices… 🔍'
  });

  try {
    // 1) Build search plan with GPT (uses the whole conversation context in this thread)
    const searchPlan = await buildSearchPlan(combinedText);

    // 2) Fetch candidate voices from ElevenLabs Voice Library (with multi-step fallback)
    const voices = await fetchVoicesForSearchPlan(searchPlan);

    if (!voices.length) {
      await client.chat.postMessage({
        channel: event.channel,
        thread_ts: threadTs,
        text:
          "I couldn't find any voices matching this description. Try describing the voice more broadly or using different wording."
      });
      return;
    }

    // 3) Ask GPT to act as a curator on top of these voices and return grouped JSON
    const reply = await curateVoicesWithGPT(combinedText, searchPlan, voices);

    // 4) Store session for further follow-ups in this thread
    sessions[threadTs] = {
      originalQuery: combinedText,
      searchPlan,
      voices
    };

    // 5) Send curated response back to Slack
    await client.chat.postMessage({
      channel: event.channel,
      thread_ts: threadTs,
      text: reply
    });
  } catch (error) {
    console.error('Error handling app_mention:', error);

    await client.chat.postMessage({
      channel: event.channel,
      thread_ts: threadTs,
      text:
        'Something went wrong while analysing your request or calling the APIs. Please try again.'
    });
  }
});

// Start the app (Render uses PORT)
(async () => {
  const port = process.env.PORT || 3000;
  await app.start(port);
  console.log('⚡️ voices-bot is running on port ' + port);
})();
