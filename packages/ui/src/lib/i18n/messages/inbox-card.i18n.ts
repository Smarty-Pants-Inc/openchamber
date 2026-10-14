// smarty-code#1407 item 6: an inbox card's one Details link and its message button, named for the Smarty's owner.
// smarty-code#2360: the list's retry notes: a refresh that failed (the list stays) and a first load that failed.
type Copy = [details: string, messageOwner: string, recommended: string, summaryUpdating: string, refreshRetrying: string, loadRetrying: string];
const card = ([details, messageOwner, recommended, summaryUpdating, refreshRetrying, loadRetrying]: Copy) => ({ 'inbox.card.details': details, 'inbox.card.messageOwner': messageOwner, 'inbox.card.recommended': recommended,
  'inbox.summary.updating': summaryUpdating, 'inbox.refresh.retrying': refreshRetrying, 'inbox.load.retrying': loadRetrying });
export const inboxCardI18n = {
  en: card(['Details', 'Message {name}’s Smarty', 'Recommended: {text}', 'updating…', 'Couldn’t refresh. Retrying…', 'Couldn’t load the inbox. Retrying…']),
  de: card(['Details', 'Nachricht an den Smarty von {name}', 'Empfohlen: {text}', 'wird aktualisiert…', 'Aktualisierung fehlgeschlagen. Neuer Versuch…', 'Posteingang konnte nicht geladen werden. Neuer Versuch…']),
  es: card(['Detalles', 'Escribir al Smarty de {name}', 'Recomendado: {text}', 'actualizando…', 'No se pudo actualizar. Reintentando…', 'No se pudo cargar la bandeja. Reintentando…']),
  fr: card(['Détails', 'Écrire au Smarty de {name}', 'Recommandé : {text}', 'mise à jour…', 'Actualisation impossible. Nouvelle tentative…', 'Impossible de charger la boîte de réception. Nouvelle tentative…']),
  ja: card(['詳細', '{name} の Smarty にメッセージ', 'おすすめ: {text}', '更新中…', '更新できませんでした。再試行しています…', '受信トレイを読み込めませんでした。再試行しています…']),
  ko: card(['세부 정보', '{name}의 Smarty에게 메시지', '추천: {text}', '업데이트 중…', '새로 고치지 못했습니다. 다시 시도하는 중…', '받은편지함을 불러오지 못했습니다. 다시 시도하는 중…']),
  pl: card(['Szczegóły', 'Napisz do Smarty użytkownika {name}', 'Zalecane: {text}', 'aktualizowanie…', 'Nie udało się odświeżyć. Ponawianie…', 'Nie udało się wczytać skrzynki. Ponawianie…']),
  'pt-BR': card(['Detalhes', 'Mensagem para o Smarty de {name}', 'Recomendado: {text}', 'atualizando…', 'Não foi possível atualizar. Tentando de novo…', 'Não foi possível carregar a caixa de entrada. Tentando de novo…']),
  tr: card(['Ayrıntılar', '{name} adlı kişinin Smarty’sine mesaj gönder', 'Önerilen: {text}', 'güncelleniyor…', 'Yenilenemedi. Yeniden deneniyor…', 'Gelen kutusu yüklenemedi. Yeniden deneniyor…']),
  uk: card(['Докладніше', 'Написати Smarty користувача {name}', 'Рекомендовано: {text}', 'оновлення…', 'Не вдалося оновити. Повторна спроба…', 'Не вдалося завантажити вхідні. Повторна спроба…']),
  'zh-CN': card(['详情', '给 {name} 的 Smarty 发消息', '建议：{text}', '正在更新…', '无法刷新。正在重试…', '无法加载收件箱。正在重试…']),
  'zh-TW': card(['詳細資料', '傳訊息給 {name} 的 Smarty', '建議：{text}', '正在更新…', '無法重新整理。正在重試…', '無法載入收件匣。正在重試…']),
};
