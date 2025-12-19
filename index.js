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

  // 👉 KLUCZOWA ZMIANA:
  // Jeśli jest use case (conversational, audiobook, cartoon itd.),
  // to NIE wchodzimy w tryb "top_by_language", nawet jeśli pojawi się "top / most used".
  if (!hasUsageKeyword || hasUseCaseKeyword) {
    return { mode: 'generic', languageCode: null };
  }

  // Jeśli dotarliśmy tutaj, to:
  // - są słowa "most used / najczęściej używane"
  // - NIE MA konkretnego use case
  // -> możemy bezpiecznie odpalić tryb "top_by_language"
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
