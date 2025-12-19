const { App } = require('@slack/bolt');
const axios = require('axios');

// Simple in-memory session store: Slack thread -> last search context
const sessions = {};

// Clean Slack mentions like <@U123ABC> from the message
function cleanText(text) {
  if (!text) return '';
  return text.replace(/<@[^>]+>/g, '').trim();
}

// Detect whether a voice should be treated as "high quality"
function isHighQuality(voice) {
  if (!voice || typeof voice !== 'object') return false;
  const cat = (voice.category || '').toString().toLowerCase();
  return cat === 'high_quality' || cat === 'high quality';
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

// Fetch candidate voices from ElevenLabs Voice Library using the search plan
async function fetchVoicesForSearchPlan(plan) {
  const baseParams = new URLSearchParams();
  baseParams.set('page_size', '50');

  if (plan.target_voice_language) baseParams.set('language', plan.target_voice_language);
  if (plan.target_accent) baseParams.set('accent', plan.target_accent);
  if (plan.target_gender && plan.target_gender !== 'neutral') {
    baseParams.set('gender', plan.target_gender);
  }

  // Only high quality -> filter by category at the API level
  if (plan.quality_preference === 'high_only') {
    baseParams.set('category', 'high_quality');
  }

  if (Array.isArray(plan.use_cases)) {
    for (const u of plan.use_cases) {
      if (u) baseParams.append('use_cases', u);
    }
  }

  if (Array.isArray(plan.tone_descriptors)) {
    for (const d of plan.tone_descriptors) {
      if (d) baseParams.append('descriptives', d);
    }
  }

  const seen = new Set();
  let voices = [];

  const queries =
    Array.isArray(plan.search_queries) && plan.search_queries.length
      ? plan.search_queries.slice(0, 5)
      : [null];

  for (const q of queries) {
    const params = new URLSearchParams(baseParams);

    if (q && q.toString().trim().length > 0) {
      params.set('search', q.toString().trim());
    }

    const url = `https://api.elevenlabs.io/v1/shared-voices?${params.toString()}`;

    const res = await axios.get(url, {
      headers: {
        'xi-api-key': process.env.ELEVENLABS_API_KEY,
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

    // Avoid grabbing huge amounts
    if (voices.length >= 60) break;
    if (!res.data.has_more) break;
  }

  // If user explicitly wants no high quality voices, filter client-side
  if (plan.quality_preference === 'no_high') {
    voices = voices.filter(v => !isHighQuality(v));
  }

  return voices;
}

// Ask GPT to act as a "voice curator" on top of the candidate voices
async function curateVoicesWithGPT(userText, plan, voices) {
  const candidates = voices.slice(0, 40).map(v => ({
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
    verified_languages: v.verified_languages
  }));

  const systemPrompt = `
You are an expert curator of the ElevenLabs Voice Library.

You receive:
- the user's request in natural language (in ANY language),
- a "search_plan" describing what they are looking for,
- a list of "candidate_voices" from the ElevenLabs Voice Library (GET /v1/shared-voices).

Your job:

1. From candidate_voices, select and order the BEST matches for the user's request.
   - Match on language, accent, gender, use_case, descriptive, age, category.
   - Use popularity signals as tie-breakers: usage_character_count_1y, cloned_by_count, featured.
   - Never invent new voices. Use ONLY the provided candidate_voices.

2. Split voices into TWO main sections:
   - "Standard voices (not high quality)"
   - "High quality voices"

   Treat voices as "high quality" when their category is "high_quality" (case-insensitive).
   All others are "standard voices".

3. Inside each of those sections, group voices by gender:
   - "Female:"
   - "Male:"
   - "Other / unspecified:"

4. Within each gender subgroup, output up to 5 voices.

5. For each voice, output ONE bullet line in this EXACT Slack format:
   - "- <https://elevenlabs.io/app/voice-library?search=VOICE_ID|NAME | VOICE_ID>"

   Where:
   - VOICE_ID is the voice_id from the candidate object,
   - NAME is the voice's name.

6. If a section has no voices, you MUST still output the section header and a line:
   - "_No voices in this section._"

7. Respond in the SAME LANGUAGE as the user's original message.
   - The "user_interface_language" in search_plan tells you the user's language (e.g. "en","pl","es").
   - Use that language for all headings and text.

8. Do NOT repeat the full user query verbatim.
   - You may reference it briefly ("for your request") but do not fully quote it.

9. At the end of your message, add two lines explaining in a friendly way that the user can:
   - ask which of these voices are high quality vs standard,
   - ask about languages these voices support,
   - refine the search with more details.

VERY IMPORTANT:
- Do NOT hallucinate voice names or IDs.
- Use only the voices provided in candidate_voices.
- Even if all candidates are only weak matches, still pick the best you can from them.
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

    return response.data.choices[0].message.content.trim();
  } catch (error) {
    console.error('Failed to get curated response from OpenAI. Falling back to simple listing.', error);

    // Simple fallback: naive standard/high split list in English
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
      standard.slice(0, 10).forEach((v, i) => {
        text += formatLine(v, i + 1) + '\n';
      });
      text += '\n';
    }

    text += '*High quality voices:*\n';
    if (!high.length) {
      text += '_No voices in this section._\n\n';
    } else {
      high.slice(0, 10).forEach((v, i) => {
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

  // If there is already a session in this thread, treat this as a follow-up
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

    // 2) Fetch candidate voices from ElevenLabs Voice Library
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

    // 3) Ask GPT to act as a curator on top of these voices
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
