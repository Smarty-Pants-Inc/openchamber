/** smarty-code#583: the jump to a session's first message. */
const t = (label: string, aria: string) => ({ 'chat.scrollToStart.label': label, 'chat.scrollToStart.aria': aria });
export const historyJumpI18n = {
  en: t('Beginning', 'Go to the first message'),
  de: t('Anfang', 'Zur ersten Nachricht'),
  es: t('Inicio', 'Ir al primer mensaje'),
  fr: t('Début', 'Aller au premier message'),
  ja: t('最初', '最初のメッセージへ'),
  ko: t('처음', '첫 메시지로 이동'),
  pl: t('Początek', 'Przejdź do pierwszej wiadomości'),
  'pt-BR': t('Início', 'Ir para a primeira mensagem'),
  tr: t('Başlangıç', 'İlk mesaja git'),
  uk: t('Початок', 'До першого повідомлення'),
  'zh-CN': t('开头', '转到第一条消息'),
  'zh-TW': t('開頭', '前往第一則訊息'),
};
