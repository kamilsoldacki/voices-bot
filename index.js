const { App } = require('@slack/bolt');
const axios = require('axios');

// Prosta "pamięć": wątek Slacka -> znalezione głosy
const sessions = {};

// Inicjalizacja Bolt w Socket Mode
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN,
});

// Usuwamy z tekstu mention typu <@U123ABC>
function cleanText(text) {
  if (!text) return '';
  return text.replace(/<@[^>]+>/g, '').trim();
}

// 1. LLM: z naturalnego tekstu robi JSON filtrów do Voice Library
async function parseQueryWithLLM(userText) {
  const instructions = `
You are an assistant that takes natural language descriptions of voices (in any language)
and outputs JSON filters for the ElevenLabs Voice Library shared voices search.

Return ONLY a valid JSON object, no markdown, no explanations.

The JSON must have this shape:
{
  "language": string or null,        // ISO 639-1 like "en", "pl"
  "accent": string or null,          // e.g. "american", "british", "polish"
  "gender": string or null,          // "male" or "female"
  "descriptives": string[],          // 0-5 short English adjectives, lowercase
  "use_cases": string[],             // 0-5 short English tags, lowercase
  "search": string                   // short English search text summarizing the request
}
`.trim();

  const payload = {
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: instructions },
      { role: 'user', content: userText },
    ],
    temperature: 0,
  };

  const response = await axios.post(
    'https://api.openai.com/v1/chat/completions',
    payload,
    {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
    }
  );

  const content = response.data.choices[0].message.content.trim();

  try {
    return JSON.parse(content);
  } catch (e) {
    console.error('JSON parse error from LLM, falling back to simple filters:', e);
    return {
      language: null,
      accent: null,
      gender: null,
      descriptives: [],
      use_cases: [],
      search: userText,
    };
  }
}

// 2. Zapytanie do ElevenLabs Voice Library: /v1/shared-voices
async function searchVoices(filters) {
  const params = new URLSearchParams();
  params.set('page_size', '20');

  if (filters.language) params.set('language', filters.language);
  if (filters.accent) params.set('accent', filters.accent);
  if (filters.gender) params.set('gender', filters.gender);
  if (filters.search) params.set('search', filters.search);

  const res = await axios.get(
    `https://api.elevenlabs.io/v1/shared-voices?${params.toString()}`,
    {
      headers: {
        'xi-api-key': process.env.ELEVENLABS_API_KEY,
        'Content-Type': 'application/json',
      },
    }
  );

  return res.data.voices || [];
}

// Format jednej linijki z linkiem do Voice Library
function formatVoiceLine(voice, index) {
  const url = `https://elevenlabs.io/voice-library/shared-voices/${voice.voice_id}`;
  return `${index}. <${url}|${voice.name} | ${voice.voice_id}>`;
}

// 3. Obsługa eventu: ktoś pisze @voices-bot ...
app.event('app_mention', async ({ event, client }) => {
  const rawText = event.text || '';
  const cleaned = cleanText(rawText);
  const threadTs = event.thread_ts || event.ts;

  const existingSession = sessions[threadTs];

  // ---- B: FOLLOW-UP w tym samym wątku ----
  if (existingSession) {
    const text = cleaned.toLowerCase();

    // pytanie o jakość
    if (
      text.includes('quality') ||
      text.includes('jakość') ||
      text.includes('jakosc')
    ) {
      const highQuality = existingSession.voices.filter(
        (v) => (v.category || '').toLowerCase() === 'high_quality'
      );

      if (!highQuality.length) {
        await client.chat.postMessage({
          channel: event.channel,
          thread_ts: threadTs,
          text:
            'Wśród wcześniej znalezionych głosów nie ma żadnych oznaczonych jako *high quality* (category=high_quality).',
        });
        return;
      }

      let reply = 'Te głosy są oznaczone jako *high quality*:\n';
      highQuality.slice(0, 10).forEach((v, i) => {
        reply += formatVoiceLine(v, i + 1) + '\n';
      });

      await client.chat.postMessage({
        channel: event.channel,
        thread_ts: threadTs,
        text: reply,
      });
      return;
    }

    // pytanie o języki
    if (text.includes('język') || text.includes('jezyk') || text.includes('language')) {
      const langCount = {};

      existingSession.voices.forEach((v) => {
        const langs = [];

        if (Array.isArray(v.verified_languages) && v.verified_languages.length > 0) {
          v.verified_languages.forEach((entry) => {
            if (entry.language) langs.push(entry.language);
          });
        } else if (v.language) {
          langs.push(v.language);
        }

        langs.forEach((lang) => {
          langCount[lang] = (langCount[lang] || 0) + 1;
        });
      });

      if (!Object.keys(langCount).length) {
        await client.chat.postMessage({
          channel: event.channel,
          thread_ts: threadTs,
          text: 'Nie widzę żadnych informacji o językach dla tych głosów.',
        });
        return;
      }

      let reply =
        'Języki wśród wcześniej znalezionych głosów (na podstawie `verified_languages` / `language`):\n';
      Object.entries(langCount).forEach(([lang, count]) => {
        reply += `• ${lang}: ${count} głos(y)\n`;
      });

      await client.chat.postMessage({
        channel: event.channel,
        thread_ts: threadTs,
        text: reply,
      });
      return;
    }

    // inne follow-upy
    await client.chat.postMessage({
      channel: event.channel,
      thread_ts: threadTs,
      text:
        'W tym wątku rozumiem na razie pytania o jakość (high quality) i języki. ' +
        'Możesz też napisać nowy opis, a wyszukam od zera 🙂',
    });
    return;
  }

  // ---- A: pierwszy message → nowe wyszukiwanie ----

  await client.chat.postMessage({
    channel: event.channel,
    thread_ts: threadTs,
    text: 'Jasne, już szukam głosów w Voice Library 🔍',
  });

  try {
    // 1) LLM → filtry
    const filters = await parseQueryWithLLM(cleaned);

    // 2) ElevenLabs → lista głosów
    const voices = await searchVoices(filters);

    if (!voices.length) {
      await client.chat.postMessage({
        channel: event.channel,
        thread_ts: threadTs,
        text:
          'Niestety nie znalazłem żadnych głosów pasujących do tego opisu 😕 ' +
          'Spróbuj opisać głos trochę szerzej albo użyj innego słowa.',
      });
      return;
    }

    // zapamiętujemy wyniki do follow-upów
    sessions[threadTs] = { filters, voices };

    const female = voices.filter((v) => (v.gender || '').toLowerCase() === 'female');
    const male = voices.filter((v) => (v.gender || '').toLowerCase() === 'male');

    let text = `Opis użytkownika: _${cleaned}_\n`;
    text += 'Proponowane głosy:\n\n';

    if (female.length) {
      text += '*Damskie:*\n';
      female.slice(0, 5).forEach((v, i) => {
        text += formatVoiceLine(v, i + 1) + '\n';
      });
      text += '\n';
    }

    if (male.length) {
      text += '*Męskie:*\n';
      male.slice(0, 5).forEach((v, i) => {
        text += formatVoiceLine(v, i + 1) + '\n';
      });
      text += '\n';
    }

    if (!female.length && !male.length) {
      text += 'Nie udało się jasno podzielić na damskie/męskie, pokazuję wszystkie:\n';
      voices.slice(0, 10).forEach((v, i) => {
        text += formatVoiceLine(v, i + 1) + '\n';
      });
      text += '\n';
    }

    text +=
      'W tym samym wątku możesz dopytać, np.:\n' +
      '• "@voices-bot które z nich są high quality?"\n' +
      '• "@voices-bot w jakich językach działają te głosy?"';

    await client.chat.postMessage({
      channel: event.channel,
      thread_ts: threadTs,
      text,
    });
  } catch (err) {
    console.error(err);
    await client.chat.postMessage({
      channel: event.channel,
      thread_ts: threadTs,
      text:
        'Coś poszło nie tak przy analizie opisu lub zapytaniu do API. ' +
        'Sprawdź, czy opis nie zawiera bardzo nietypowych znaków i spróbuj ponownie.',
    });
  }
});

// Start aplikacji – na Render ważne, żeby słuchać na PORT
(async () => {
  const port = process.env.PORT || 3000;
  await app.start(port);
  console.log('⚡️ voices-bot działa na porcie ' + port);
})();
