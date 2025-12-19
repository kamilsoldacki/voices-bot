const { App } = require('@slack/bolt');
const axios = require('axios');

// Prosta "pamięć": wątek Slacka -> ostatnie wyniki wyszukiwania + preferencje
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

// Bardzo proste zgadywanie PL / EN z treści
function guessUiLanguageFromText(text) {
  if (!text) return 'en';
  const lower = text.toLowerCase();

  // kilka znaków diakrytycznych PL
  if (/[ąćęłńóśżź]/.test(lower)) return 'pl';

  // słowa-klucze PL
  if (lower.includes('głos') || lower.includes('glos') || lower.includes('szukam')) {
    return 'pl';
  }

  return 'en';
}

// Teksty interfejsu (PL / EN)
function getMessages(uiLang) {
  if (uiLang === 'pl') {
    return {
      searching: 'Jasne, już szukam głosów w Voice Library 🔍',
      noResults:
        'Niestety nie znalazłem żadnych głosów pasujących do tego opisu 😕\n' +
        'Spróbuj opisać głos trochę szerzej albo użyj innego słowa.',
      headerWithQuery: (q) => `Opis użytkownika: _${q}_\nProponowane głosy:\n`,
      standardSectionTitle: '*Głosy standardowe (nie oznaczone jako high quality):*',
      highQualitySectionTitle: '*Głosy oznaczone jako high quality:*',
      femaleTitle: 'Damskie:',
      maleTitle: 'Męskie:',
      otherTitle: 'Inne / bez określonej płci:',
      nothingInSection: '_Brak głosów w tej sekcji._',
      followupHelp:
        'W tym samym wątku możesz dopytać, np.:\n' +
        '• "@voices-bot które z nich są high quality?"\n' +
        '• "@voices-bot w jakich językach działają te głosy?"\n' +
        '• "@voices-bot pokaż tylko high quality"\n' +
        '• "@voices-bot pokaż bez high quality"',
      noHighQualityInSession:
        'Wśród wcześniej znalezionych głosów nie ma żadnych oznaczonych jako *high quality*.',
      highQualityInSessionHeader: 'Te głosy są oznaczone jako *high quality*:\n',
      languagesHeader:
        'Języki wśród wcześniej znalezionych głosów (na podstawie `language` / `verified_languages`):\n',
      noLanguagesInfo: 'Nie widzę żadnych informacji o językach dla tych głosów.',
      followupUnknown:
        'W tym wątku rozumiem na razie pytania o jakość (high quality) i języki.\n' +
        'Możesz też napisać nowy opis głosu, a wyszukam od zera 🙂',
      rescopeHighOnly: 'OK, pokazuję tylko głosy *high quality* dla tego opisu 🔍',
      rescopeNoHigh: 'OK, pokazuję tylko głosy *bez* oznaczenia high quality 🔍',
      moreVoicesHeader: 'Oto więcej głosów z poprzedniego wyszukiwania:\n',
      partialStandardNote:
        '_Uwaga: poniżej lista zawiera tylko głosy standardowe (bez high quality)._',
      partialHighNote:
        '_Uwaga: poniżej lista zawiera tylko głosy high quality._',
    };
  }

  // Domyślnie EN
  return {
    searching: 'Got it, searching the Voice Library for matching voices 🔍',
    noResults:
      "I couldn't find any voices matching this description 😕\n" +
      'Try describing the voice a bit more broadly or using a different wording.',
    headerWithQuery: (q) => `User description: _${q}_\nSuggested voices:\n`,
    standardSectionTitle: '*Standard voices (not marked as high quality):*',
    highQualitySectionTitle: '*High quality voices:*',
    femaleTitle: 'Female:',
    maleTitle: 'Male:',
    otherTitle: 'Other / unspecified gender:',
    nothingInSection: '_No voices in this section._',
    followupHelp:
      'In this thread you can ask, for example:\n' +
      '• "@voices-bot which of these are high quality?"\n' +
      '• "@voices-bot what languages do these voices support?"\n' +
      '• "@voices-bot show only high quality"\n' +
      '• "@voices-bot show without high quality"',
    noHighQualityInSession:
      'None of the previously found voices are marked as *high quality*.',
    highQualityInSessionHeader: 'These voices are marked as *high quality*:\n',
    languagesHeader:
      'Languages across the previously found voices (based on `language` / `verified_languages`):\n',
    noLanguagesInfo: 'I cannot see any language info for these voices.',
    followupUnknown:
      'In this thread I currently understand questions about quality (high quality) and languages.\n' +
      'You can also send a new voice description and I will search from scratch 🙂',
    rescopeHighOnly: 'OK, showing only *high quality* voices for this description 🔍',
    rescopeNoHigh: 'OK, showing only voices *without* high quality label 🔍',
    moreVoicesHeader: 'Here are more voices from the previous search:\n',
    partialStandardNote:
      '_Note: the list below contains only standard (non high quality) voices._',
    partialHighNote:
      '_Note: the list below contains only high quality voices._',
  };
}

// 1. LLM: z naturalnego tekstu robi JSON filtrów do Voice Library
async function parseQueryWithLLM(userText) {
  const instructions = `
You are an assistant that takes natural language descriptions of voices (in ANY language)
and outputs JSON filters for the ElevenLabs Voice Library shared voices search.

Return ONLY a valid JSON object, no markdown, no explanations.

The JSON MUST have exactly these fields:

{
  "language": string or null,        // ISO 639-1 like "en", "pl", "de" inferred from the requested voice, NOT from the UI language
  "accent": string or null,          // e.g. "american", "british", "polish"
  "gender": string or null,          // "male", "female", or null if not specified
  "descriptives": string[],          // 0-5 short English adjectives, lowercase (e.g. ["calm","confident"])
  "use_cases": string[],             // 0-5 short English tags, lowercase (e.g. ["agent","narration"])
  "search": string,                  // short English search text summarizing the voice request
  "quality": "any" | "high_only" | "no_high", // "high_only" if the user clearly wants only high quality voices,
                                              // "no_high" if the user clearly excludes high quality voices,
                                              // otherwise "any"
  "response_language": string        // 2-letter code of the language the USER is using in the message (e.g. "en", "pl", "zh").
                                     // If you are not sure, default to "en".
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
    const parsed = JSON.parse(content);
    return {
      language: parsed.language || null,
      accent: parsed.accent || null,
      gender: parsed.gender || null,
      descriptives: Array.isArray(parsed.descriptives) ? parsed.descriptives : [],
      use_cases: Array.isArray(parsed.use_cases) ? parsed.use_cases : [],
      search: parsed.search || userText,
      quality: parsed.quality || 'any',
      response_language: parsed.response_language || guessUiLanguageFromText(userText),
    };
  } catch (e) {
    console.error('JSON parse error from LLM, falling back to simple filters:', e);
    return {
      language: null,
      accent: null,
      gender: null,
      descriptives: [],
      use_cases: [],
      search: userText,
      quality: 'any',
      response_language: guessUiLanguageFromText(userText),
    };
  }
}

// 2. Budowanie parametrów do GET /v1/shared-voices
function buildSharedVoicesParams(filters) {
  const params = new URLSearchParams();
  params.set('page_size', '30'); // trochę więcej wyników, potem i tak tnijmy w odpowiedzi

  if (filters.language) params.set('language', filters.language);
  if (filters.accent) params.set('accent', filters.accent);
  if (filters.gender) params.set('gender', filters.gender);
  if (filters.search) params.set('search', filters.search);

  // useCases & descriptives - jako wielokrotne parametry
  if (Array.isArray(filters.use_cases)) {
    filters.use_cases.forEach((uc) => {
      if (uc) params.append('useCases', uc);
    });
  }
  if (Array.isArray(filters.descriptives)) {
    filters.descriptives.forEach((d) => {
      if (d) params.append('descriptives', d);
    });
  }

  // quality: jeśli tylko high quality, użyjemy filtra po category
  if (filters.quality === 'high_only') {
    // Zakładamy, że Voice Library używa category=high_quality do filtrowania HQ voices
    params.set('category', 'high_quality');
  }

  return params;
}

// 3. Zapytanie do ElevenLabs Voice Library: /v1/shared-voices
async function searchSharedVoices(filters) {
  const params = buildSharedVoicesParams(filters);

  const res = await axios.get(
    `https://api.elevenlabs.io/v1/shared-voices?${params.toString()}`,
    {
      headers: {
        'xi-api-key': process.env.ELEVENLABS_API_KEY,
        'Content-Type': 'application/json',
      },
    }
  );

  let voices = res.data.voices || [];

  // Jeśli użytkownik chciał WYKLUCZYĆ high quality, filtrujemy po stronie klienta
  if (filters.quality === 'no_high') {
    voices = voices.filter((v) => !isHighQuality(v));
  }

  return voices;
}

// Pomocnicze: wykrywanie high quality z obiektu voice
function isHighQuality(voice) {
  if (!voice || typeof voice !== 'object') return false;

  const cat =
    (voice.category ||
      (voice.sharing && voice.sharing.category) ||
      '').toLowerCase();

  if (cat === 'high_quality' || cat === 'high quality') return true;

  if (
    Array.isArray(voice.high_quality_base_model_ids) &&
    voice.high_quality_base_model_ids.length > 0
  ) {
    return true;
  }

  // jeśli w labels jest jakiś flag typu "high_quality": true / "yes", też możemy to wykorzystać
  if (voice.labels && typeof voice.labels === 'object') {
    const labelHq = String(voice.labels.high_quality || '').toLowerCase();
    if (labelHq === 'true' || labelHq === 'yes' || labelHq === '1') return true;
  }

  return false;
}

// Podział głosów na standard/high_quality oraz płeć
function splitVoicesByQualityAndGender(voices) {
  const groups = {
    standard: { female: [], male: [], other: [] },
    high: { female: [], male: [], other: [] },
  };

  voices.forEach((v) => {
    const genderRaw =
      (v.gender ||
        (v.labels && v.labels.gender) ||
        '').toString().toLowerCase();

    const qualityGroup = isHighQuality(v) ? 'high' : 'standard';

    let genderGroup = 'other';
    if (genderRaw === 'female' || genderRaw === 'woman' || genderRaw === 'f') {
      genderGroup = 'female';
    } else if (genderRaw === 'male' || genderRaw === 'man' || genderRaw === 'm') {
      genderGroup = 'male';
    }

    groups[qualityGroup][genderGroup].push(v);
  });

  return groups;
}

// Format jednej linijki z linkiem do Voice Library (search by voice_id)
function formatVoiceLine(voice, index) {
  const url = `https://elevenlabs.io/app/voice-library?search=${encodeURIComponent(
    voice.voice_id
  )}`;
  return `${index}. <${url}|${voice.name} | ${voice.voice_id}>`;
}

// Budowanie tekstu odpowiedzi dla wyszukiwania
function buildSearchResultText(cleanedQuery, split, filters, messages) {
  let text = messages.headerWithQuery(cleanedQuery);

  const { standard, high } = split;

  const showStandard = filters.quality === 'any' || filters.quality === 'no_high';
  const showHigh = filters.quality === 'any' || filters.quality === 'high_only';

  if (showStandard) {
    text += '\n' + messages.standardSectionTitle + '\n';

    const female = standard.female.slice(0, 5);
    const male = standard.male.slice(0, 5);
    const other = standard.other.slice(0, 3); // mniej "innych", żeby nie zalać listy

    if (!female.length && !male.length && !other.length) {
      text += messages.nothingInSection + '\n\n';
    } else {
      if (female.length) {
        text += messages.femaleTitle + '\n';
        female.forEach((v, i) => {
          text += formatVoiceLine(v, i + 1) + '\n';
        });
        text += '\n';
      }
      if (male.length) {
        text += messages.maleTitle + '\n';
        male.forEach((v, i) => {
          text += formatVoiceLine(v, i + 1) + '\n';
        });
        text += '\n';
      }
      if (other.length) {
        text += messages.otherTitle + '\n';
        other.forEach((v, i) => {
          text += formatVoiceLine(v, i + 1) + '\n';
        });
        text += '\n';
      }
    }
  }

  if (showHigh) {
    text += '\n' + messages.highQualitySectionTitle + '\n';

    const female = high.female.slice(0, 5);
    const male = high.male.slice(0, 5);
    const other = high.other.slice(0, 3);

    if (!female.length && !male.length && !other.length) {
      text += messages.nothingInSection + '\n\n';
    } else {
      if (female.length) {
        text += messages.femaleTitle + '\n';
        female.forEach((v, i) => {
          text += formatVoiceLine(v, i + 1) + '\n';
        });
        text += '\n';
      }
      if (male.length) {
        text += messages.maleTitle + '\n';
        male.forEach((v, i) => {
          text += formatVoiceLine(v, i + 1) + '\n';
        });
        text += '\n';
      }
      if (other.length) {
        text += messages.otherTitle + '\n';
        other.forEach((v, i) => {
          text += formatVoiceLine(v, i + 1) + '\n';
        });
        text += '\n';
      }
    }
  }

  text += '\n' + messages.followupHelp;

  return text;
}

// Prosta klasyfikacja follow-upów (bez LLM)
function classifyFollowupIntent(text) {
  const lower = text.toLowerCase();

  // języki
  if (
    lower.includes('język') ||
    lower.includes('jezyk') ||
    lower.includes('language') ||
    lower.includes('languages')
  ) {
    return 'languages';
  }

  // "tylko high quality", "show only high quality"
  if (
    (lower.includes('high quality') || lower.includes('high-quality')) &&
    (lower.includes('tylko') || lower.includes('only'))
  ) {
    return 'rescope_high_only';
  }

  // "bez high quality", "without high quality"
  if (
    lower.includes('bez high quality') ||
    lower.includes('without high quality') ||
    lower.includes('no high quality')
  ) {
    return 'rescope_no_high';
  }

  // ogólne pytanie o HQ
  if (lower.includes('high quality') || lower.includes('high-quality')) {
    return 'which_are_high';
  }

  // "więcej głosów", "more voices"
  if (
    lower.includes('więcej') ||
    lower.includes('wiecej') ||
    lower.includes('more voices') ||
    lower.includes('show more')
  ) {
    return 'more';
  }

  return 'unknown';
}

// Zliczanie języków z wyników
function summarizeLanguages(voices) {
  const langCount = {};

  voices.forEach((v) => {
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

  return langCount;
}

// 4. Obsługa eventu: ktoś pisze @voices-bot ...
app.event('app_mention', async ({ event, client }) => {
  const rawText = event.text || '';
  const cleaned = cleanText(rawText);
  const threadTs = event.thread_ts || event.ts;

  const existingSession = sessions[threadTs];

  // ------------------ FOLLOW-UP W TYM SAMYM WĄTKU ------------------
  if (existingSession) {
    const uiLang = existingSession.uiLanguage || guessUiLanguageFromText(rawText);
    const messages = getMessages(uiLang);
    const intent = classifyFollowupIntent(cleaned);

    if (intent === 'which_are_high') {
      const highVoices = existingSession.voices.filter((v) => isHighQuality(v));

      if (!highVoices.length) {
        await client.chat.postMessage({
          channel: event.channel,
          thread_ts: threadTs,
          text: messages.noHighQualityInSession,
        });
        return;
      }

      let reply = messages.highQualityInSessionHeader;
      highVoices.slice(0, 10).forEach((v, i) => {
        reply += formatVoiceLine(v, i + 1) + '\n';
      });

      await client.chat.postMessage({
        channel: event.channel,
        thread_ts: threadTs,
        text: reply,
      });
      return;
    }

    if (intent === 'languages') {
      const langCount = summarizeLanguages(existingSession.voices);

      if (!Object.keys(langCount).length) {
        await client.chat.postMessage({
          channel: event.channel,
          thread_ts: threadTs,
          text: messages.noLanguagesInfo,
        });
        return;
      }

      let reply = messages.languagesHeader;
      Object.entries(langCount).forEach(([lang, count]) => {
        reply += `• ${lang}: ${count} voice(s)\n`;
      });

      await client.chat.postMessage({
        channel: event.channel,
        thread_ts: threadTs,
        text: reply,
      });
      return;
    }

    if (intent === 'rescope_high_only' || intent === 'rescope_no_high') {
      const newFilters = {
        ...existingSession.filters,
        quality: intent === 'rescope_high_only' ? 'high_only' : 'no_high',
      };

      await client.chat.postMessage({
        channel: event.channel,
        thread_ts: threadTs,
        text:
          intent === 'rescope_high_only'
            ? messages.rescopeHighOnly
            : messages.rescopeNoHigh,
      });

      try {
        const voices = await searchSharedVoices(newFilters);
        if (!voices.length) {
          await client.chat.postMessage({
            channel: event.channel,
            thread_ts: threadTs,
            text: messages.noResults,
          });
          return;
        }

        const split = splitVoicesByQualityAndGender(voices);

        sessions[threadTs] = {
          filters: newFilters,
          voices,
          uiLanguage: uiLang,
        };

        const replyText = buildSearchResultText(
          existingSession.originalQuery || cleaned,
          split,
          newFilters,
          messages
        );

        await client.chat.postMessage({
          channel: event.channel,
          thread_ts: threadTs,
          text: replyText,
        });
      } catch (err) {
        console.error(err);
        await client.chat.postMessage({
          channel: event.channel,
          thread_ts: threadTs,
          text:
            uiLang === 'pl'
              ? 'Coś poszło nie tak przy ponownym wyszukiwaniu. Spróbuj ponownie później.'
              : 'Something went wrong while re-running the search. Please try again later.',
        });
      }

      return;
    }

    if (intent === 'more') {
      const voices = existingSession.voices;
      if (!voices.length) {
        await client.chat.postMessage({
          channel: event.channel,
          thread_ts: threadTs,
          text: messages.noResults,
        });
        return;
      }

      let reply = messages.moreVoicesHeader;
      voices.slice(0, 15).forEach((v, i) => {
        reply += formatVoiceLine(v, i + 1) + '\n';
      });

      await client.chat.postMessage({
        channel: event.channel,
        thread_ts: threadTs,
        text: reply,
      });
      return;
    }

    // fallback
    await client.chat.postMessage({
      channel: event.channel,
      thread_ts: threadTs,
      text: messages.followupUnknown,
    });
    return;
  }

  // ------------------ PIERWSZE WIADOMOŚĆ W WĄTKU → NOWE WYSZUKIWANIE ------------------
  // UI language zgadujemy od razu, ale docelowo bierzemy z LLM
  let uiLang = guessUiLanguageFromText(rawText);
  let messages = getMessages(uiLang);

  await client.chat.postMessage({
    channel: event.channel,
    thread_ts: threadTs,
    text: messages.searching,
  });

  try {
    // 1) LLM → filtry
    const filters = await parseQueryWithLLM(cleaned);
    uiLang = filters.response_language || uiLang;
    messages = getMessages(uiLang);

    // 2) ElevenLabs → lista głosów z Voice Library
    const voices = await searchSharedVoices(filters);

    if (!voices.length) {
      await client.chat.postMessage({
        channel: event.channel,
        thread_ts: threadTs,
        text: messages.noResults,
      });
      return;
    }

    const split = splitVoicesByQualityAndGender(voices);

    // zapamiętujemy wyniki do follow-upów
    sessions[threadTs] = {
      filters,
      voices,
      uiLanguage: uiLang,
      originalQuery: cleaned,
    };

    const replyText = buildSearchResultText(cleaned, split, filters, messages);

    await client.chat.postMessage({
      channel: event.channel,
      thread_ts: threadTs,
      text: replyText,
    });
  } catch (err) {
    console.error(err);
    await client.chat.postMessage({
      channel: event.channel,
      thread_ts: threadTs,
      text:
        uiLang === 'pl'
          ? 'Coś poszło nie tak przy analizie opisu lub zapytaniu do API. Spróbuj ponownie.'
          : 'Something went wrong while analysing the description or calling the API. Please try again.',
    });
  }
});

// Start aplikacji – w Socket Mode nie musimy wystawiać HTTP, ale na Render można użyć PORT
(async () => {
  const port = process.env.PORT || 3000;
  await app.start(port);
  console.log('⚡️ voices-bot działa na porcie ' + port);
})();
