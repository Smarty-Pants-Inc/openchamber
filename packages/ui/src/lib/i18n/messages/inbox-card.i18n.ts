// smarty-code#1407 item 6: an inbox card's one Details link and its message button, named for the Smarty's owner.
type Copy = [details: string, messageOwner: string, recommended: string, summaryUpdating: string];
const card = ([details, messageOwner, recommended, summaryUpdating]: Copy) => ({ 'inbox.card.details': details, 'inbox.card.messageOwner': messageOwner, 'inbox.card.recommended': recommended,
  'inbox.summary.updating': summaryUpdating });
export const inboxCardI18n = {
  en: card(['Details', 'Message {name}’s Smarty', 'Recommended: {text}', 'updating…']),
  de: card(['Details', 'Nachricht an den Smarty von {name}', 'Empfohlen: {text}', 'wird aktualisiert…']),
  es: card(['Detalles', 'Escribir al Smarty de {name}', 'Recomendado: {text}', 'actualizando…']),
  fr: card(['Détails', 'Écrire au Smarty de {name}', 'Recommandé : {text}', 'mise à jour…']),
  ja: card(['詳細', '{name} の Smarty にメッセージ', 'おすすめ: {text}', '更新中…']),
  ko: card(['세부 정보', '{name}의 Smarty에게 메시지', '추천: {text}', '업데이트 중…']),
  pl: card(['Szczegóły', 'Napisz do Smarty użytkownika {name}', 'Zalecane: {text}', 'aktualizowanie…']),
  'pt-BR': card(['Detalhes', 'Mensagem para o Smarty de {name}', 'Recomendado: {text}', 'atualizando…']),
  tr: card(['Ayrıntılar', '{name} adlı kişinin Smarty’sine mesaj gönder', 'Önerilen: {text}', 'güncelleniyor…']),
  uk: card(['Докладніше', 'Написати Smarty користувача {name}', 'Рекомендовано: {text}', 'оновлення…']),
  'zh-CN': card(['详情', '给 {name} 的 Smarty 发消息', '建议：{text}', '正在更新…']),
  'zh-TW': card(['詳細資料', '傳訊息給 {name} 的 Smarty', '建議：{text}', '正在更新…']),
};
