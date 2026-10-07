// smarty-code#1407 item 6: an inbox card's one Details link and its message button, named for the Smarty's owner.
type Copy = [details: string, messageOwner: string];
const card = ([details, messageOwner]: Copy) => ({ 'inbox.card.details': details, 'inbox.card.messageOwner': messageOwner });
export const inboxCardI18n = {
  en: card(['Details', 'Message {name}’s Smarty']),
  de: card(['Details', 'Nachricht an den Smarty von {name}']),
  es: card(['Detalles', 'Escribir al Smarty de {name}']),
  fr: card(['Détails', 'Écrire au Smarty de {name}']),
  ja: card(['詳細', '{name} の Smarty にメッセージ']),
  ko: card(['세부 정보', '{name}의 Smarty에게 메시지']),
  pl: card(['Szczegóły', 'Napisz do Smarty użytkownika {name}']),
  'pt-BR': card(['Detalhes', 'Mensagem para o Smarty de {name}']),
  tr: card(['Ayrıntılar', '{name} adlı kişinin Smarty’sine mesaj gönder']),
  uk: card(['Докладніше', 'Написати Smarty користувача {name}']),
  'zh-CN': card(['详情', '给 {name} 的 Smarty 发消息']),
  'zh-TW': card(['詳細資料', '傳訊息給 {name} 的 Smarty']),
};
