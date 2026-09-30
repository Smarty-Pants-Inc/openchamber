// smarty-code#827: a send to a Pi session never loses its text. If the server has not answered it in 15 s, the text
// comes back to the composer and the person is told; a late delivery says so; a second Send of it waits.
export const sendPendingI18n = {
  en: {
    'chat.send.stillPending': 'Still sending. Wait for Code to confirm it before you send it again.',
    'chat.send.unconfirmed': 'Code has not confirmed your message yet, so it is back in the composer. It may still arrive: check the chat before you send it again.',
    'chat.send.deliveredLate': 'Your message was delivered after all.',
    // smarty-code#1108: the title over a send the server refused before it took it (nothing was sent), never 'stopped this reply'.
    'chat.send.notSent': 'This message was not sent',
  },
  de: {
    'chat.send.stillPending': 'Wird noch gesendet. Warte, bis Code sie bestätigt, bevor du sie erneut sendest.',
    'chat.send.unconfirmed': 'Code hat deine Nachricht noch nicht bestätigt, daher ist sie wieder im Eingabefeld. Sie kann noch ankommen: Prüfe den Chat, bevor du sie erneut sendest.',
    'chat.send.deliveredLate': 'Deine Nachricht wurde doch zugestellt.',
    'chat.send.notSent': 'Diese Nachricht wurde nicht gesendet',
  },
  es: {
    'chat.send.stillPending': 'Todavía enviando. Espera a que Code lo confirme antes de enviarlo de nuevo.',
    'chat.send.unconfirmed': 'Code aún no ha confirmado tu mensaje, así que ha vuelto al editor. Puede que aún llegue: revisa el chat antes de enviarlo de nuevo.',
    'chat.send.deliveredLate': 'Tu mensaje se entregó después de todo.',
    'chat.send.notSent': 'Este mensaje no se envió',
  },
  fr: {
    'chat.send.stillPending': 'Envoi en cours. Attendez que Code le confirme avant de le renvoyer.',
    'chat.send.unconfirmed': 'Code n’a pas encore confirmé votre message ; il est de retour dans la zone de saisie. Il peut encore arriver : vérifiez la discussion avant de le renvoyer.',
    'chat.send.deliveredLate': 'Votre message a finalement été remis.',
    'chat.send.notSent': 'Ce message n’a pas été envoyé',
  },
  ja: {
    'chat.send.stillPending': '送信中です。再送する前に Code の確認を待ってください。',
    'chat.send.unconfirmed': 'Code がまだメッセージを確認していないため、入力欄に戻しました。まだ届く可能性があります。再送する前にチャットを確認してください。',
    'chat.send.deliveredLate': 'メッセージは結局届きました。',
    'chat.send.notSent': 'このメッセージは送信されませんでした',
  },
  ko: {
    'chat.send.stillPending': '아직 보내는 중입니다. 다시 보내기 전에 Code의 확인을 기다리세요.',
    'chat.send.unconfirmed': 'Code가 아직 메시지를 확인하지 않아 입력란으로 되돌렸습니다. 아직 도착할 수 있으니 다시 보내기 전에 채팅을 확인하세요.',
    'chat.send.deliveredLate': '메시지가 결국 전달되었습니다.',
    'chat.send.notSent': '이 메시지는 전송되지 않았습니다',
  },
  pl: {
    'chat.send.stillPending': 'Nadal wysyłanie. Poczekaj, aż Code to potwierdzi, zanim wyślesz ponownie.',
    'chat.send.unconfirmed': 'Code jeszcze nie potwierdził wiadomości, więc wróciła do pola wpisywania. Może jeszcze dotrzeć: sprawdź czat, zanim wyślesz ją ponownie.',
    'chat.send.deliveredLate': 'Wiadomość jednak została dostarczona.',
    'chat.send.notSent': 'Ta wiadomość nie została wysłana',
  },
  'pt-BR': {
    'chat.send.stillPending': 'Ainda enviando. Aguarde a confirmação do Code antes de enviar de novo.',
    'chat.send.unconfirmed': 'O Code ainda não confirmou sua mensagem, então ela voltou ao editor. Ela ainda pode chegar: confira o chat antes de enviar de novo.',
    'chat.send.deliveredLate': 'Sua mensagem foi entregue, afinal.',
    'chat.send.notSent': 'Esta mensagem não foi enviada',
  },
  tr: {
    'chat.send.stillPending': 'Hâlâ gönderiliyor. Yeniden göndermeden önce Code’un onaylamasını bekleyin.',
    'chat.send.unconfirmed': 'Code mesajınızı henüz onaylamadı, bu yüzden mesaj yazma alanına geri döndü. Yine de ulaşabilir: yeniden göndermeden önce sohbeti kontrol edin.',
    'chat.send.deliveredLate': 'Mesajınız sonunda iletildi.',
    'chat.send.notSent': 'Bu mesaj gönderilmedi',
  },
  uk: {
    'chat.send.stillPending': 'Ще надсилається. Дочекайтеся підтвердження від Code, перш ніж надсилати знову.',
    'chat.send.unconfirmed': 'Code ще не підтвердив ваше повідомлення, тож воно повернулося в поле введення. Воно ще може надійти: перевірте чат, перш ніж надсилати знову.',
    'chat.send.deliveredLate': 'Ваше повідомлення все ж доставлено.',
    'chat.send.notSent': 'Це повідомлення не надіслано',
  },
  'zh-CN': {
    'chat.send.stillPending': '仍在发送。请等待 Code 确认后再重新发送。',
    'chat.send.unconfirmed': 'Code 尚未确认你的消息，因此它已回到输入框。它仍可能送达：重新发送前请先查看聊天。',
    'chat.send.deliveredLate': '你的消息最终已送达。',
    'chat.send.notSent': '这条消息没有发送',
  },
  'zh-TW': {
    'chat.send.stillPending': '仍在傳送。請等待 Code 確認後再重新傳送。',
    'chat.send.unconfirmed': 'Code 尚未確認你的訊息，因此它已回到輸入框。它仍可能送達：重新傳送前請先查看聊天。',
    'chat.send.deliveredLate': '你的訊息最終已送達。',
    'chat.send.notSent': '這則訊息沒有傳送',
  },
} as const;
