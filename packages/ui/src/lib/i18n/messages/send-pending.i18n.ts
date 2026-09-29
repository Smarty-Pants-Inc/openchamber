// smarty-code#827: a message to a Pi session stays in the composer until the server accepts it; if that takes long,
// the person is told so (the text is never cleared by a send that has not been accepted).
export const sendPendingI18n = {
  en: { 'chat.send.stillPending': 'Still sending. Your message stays here until Code confirms it.' },
  de: { 'chat.send.stillPending': 'Wird noch gesendet. Deine Nachricht bleibt hier, bis Code sie bestätigt.' },
  es: { 'chat.send.stillPending': 'Todavía enviando. Tu mensaje se queda aquí hasta que Code lo confirme.' },
  fr: { 'chat.send.stillPending': 'Envoi en cours. Votre message reste ici jusqu’à ce que Code le confirme.' },
  ja: { 'chat.send.stillPending': '送信中です。Code が確認するまでメッセージはここに残ります。' },
  ko: { 'chat.send.stillPending': '아직 보내는 중입니다. Code가 확인할 때까지 메시지는 여기에 남아 있습니다.' },
  pl: { 'chat.send.stillPending': 'Nadal wysyłanie. Wiadomość zostaje tutaj, dopóki Code jej nie potwierdzi.' },
  'pt-BR': { 'chat.send.stillPending': 'Ainda enviando. Sua mensagem fica aqui até o Code confirmá-la.' },
  tr: { 'chat.send.stillPending': 'Hâlâ gönderiliyor. Mesajınız Code onaylayana kadar burada kalır.' },
  uk: { 'chat.send.stillPending': 'Ще надсилається. Ваше повідомлення лишається тут, доки Code його не підтвердить.' },
  'zh-CN': { 'chat.send.stillPending': '仍在发送。你的消息会保留在这里，直到 Code 确认。' },
  'zh-TW': { 'chat.send.stillPending': '仍在傳送。你的訊息會保留在這裡，直到 Code 確認。' },
} as const;
