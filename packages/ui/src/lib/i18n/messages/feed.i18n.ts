// smarty-code#1407: the Smarties (each person's conversation with their Smarty, their inbox, a message box) and the
// nav's button to the old Smarty Code view. smarty-code#1477: the own Smarty's nav label.
import { feedStatusI18n } from './feed-status.i18n';
import { feedThinkingI18n } from './feed-thinking.i18n';
type Copy = [nav: string, retry: string, historyFailed: string, empty: string, you: string, inboxToggle: string, send: string, sending: string, hint: string, transcript: string, smartiesFailed: string, viewOnly: string, classicShow: string, classicHide: string, messageLabel: string, messageFailed: string, earlierShow: string, earlierFailed: string, messageRetry: string, messageMayBeSent: string, messageCopy: string, messageTooLong: string, smartiesEmpty: string, navOwn: string, navOwnRow: string];
const feed = ([nav, retry, historyFailed, empty, you, inboxToggle, send, sending, hint, transcript, smartiesFailed, viewOnly, classicShow, classicHide, messageLabel, messageFailed, earlierShow, earlierFailed, messageRetry, messageMayBeSent, messageCopy, messageTooLong, smartiesEmpty, navOwn, navOwnRow]: Copy) => ({
  'feed.nav.label': nav,
  'feed.retry': retry,
  'feed.historyFailed': historyFailed,
  'feed.empty': empty,
  'feed.you': you,
  'feed.inbox.toggle': inboxToggle,
  'feed.reply.send': send,
  'feed.reply.sending': sending,
  'feed.reply.hint': hint,
  'feed.transcript': transcript,
  'feed.smartiesFailed': smartiesFailed,
  'feed.viewOnly': viewOnly,
  'feed.classic.show': classicShow,
  'feed.classic.hide': classicHide,
  'feed.message.label': messageLabel,
  'feed.message.failed': messageFailed,
  'feed.earlier.show': earlierShow,
  'feed.earlier.failed': earlierFailed,
  'feed.message.retry': messageRetry,
  'feed.message.mayBeSent': messageMayBeSent,
  'feed.message.copy': messageCopy,
  'feed.message.tooLong': messageTooLong,
  'feed.smartiesEmpty': smartiesEmpty,
  'feed.nav.own': navOwn,
  'feed.nav.ownRow': navOwnRow,
});
const feedBase = {
  en: feed(['Smarties', 'Try again', 'Could not load the conversation.', 'No messages yet.', 'You', 'Inbox ({count})', 'Send', 'Sending…', 'Enter to send, Shift+Enter for a new line', 'Conversation with {name}', 'Could not load the Smarties.', 'View only', 'Smarty Code', 'Back to Smarties', 'Message {name}', 'Your message was not sent.', 'Show earlier', 'Could not load earlier messages.', 'Send again', 'This may already have been sent.', 'Copy text', 'This message is too long to send (over 120 KB). Try splitting it into parts.', 'No Smarties to show yet.', 'Your Smarty', 'Your Smarty: {name}']),
  de: feed(['Smarties', 'Erneut versuchen', 'Die Unterhaltung konnte nicht geladen werden.', 'Noch keine Nachrichten.', 'Du', 'Posteingang ({count})', 'Senden', 'Wird gesendet…', 'Eingabe zum Senden, Umschalt+Eingabe für eine neue Zeile', 'Unterhaltung mit {name}', 'Die Smarties konnten nicht geladen werden.', 'Nur ansehen', 'Smarty Code', 'Zurück zu den Smarties', 'Nachricht an {name}', 'Deine Nachricht wurde nicht gesendet.', 'Frühere anzeigen', 'Frühere Nachrichten konnten nicht geladen werden.', 'Erneut senden', 'Diese Nachricht wurde vielleicht schon gesendet.', 'Text kopieren', 'Diese Nachricht ist zu lang zum Senden (über 120 KB). Teile sie am besten in mehrere Teile auf.', 'Noch keine Smarties zum Anzeigen.', 'Dein Smarty', 'Dein Smarty: {name}']),
  es: feed(['Smarties', 'Reintentar', 'No se pudo cargar la conversación.', 'Aún no hay mensajes.', 'Tú', 'Bandeja ({count})', 'Enviar', 'Enviando…', 'Intro para enviar, Mayús+Intro para una línea nueva', 'Conversación con {name}', 'No se pudieron cargar los Smarties.', 'Solo lectura', 'Smarty Code', 'Volver a los Smarties', 'Mensaje para {name}', 'Tu mensaje no se envió.', 'Mostrar anteriores', 'No se pudieron cargar los mensajes anteriores.', 'Enviar de nuevo', 'Puede que ya se haya enviado.', 'Copiar texto', 'Este mensaje es demasiado largo para enviarlo (más de 120 KB). Prueba a dividirlo en partes.', 'Aún no hay Smarties para mostrar.', 'Tu Smarty', 'Tu Smarty: {name}']),
  fr: feed(['Smarties', 'Réessayer', 'Impossible de charger la conversation.', 'Aucun message pour l’instant.', 'Vous', 'Boîte de réception ({count})', 'Envoyer', 'Envoi…', 'Entrée pour envoyer, Maj+Entrée pour une nouvelle ligne', 'Conversation avec {name}', 'Impossible de charger les Smarties.', 'Lecture seule', 'Smarty Code', 'Retour aux Smarties', 'Message à {name}', 'Votre message n’a pas été envoyé.', 'Afficher les précédents', 'Impossible de charger les messages précédents.', 'Renvoyer', 'Ce message a peut-être déjà été envoyé.', 'Copier le texte', 'Ce message est trop long pour être envoyé (plus de 120 Ko). Essayez de le découper en plusieurs parties.', 'Aucun Smarty à afficher pour l’instant.', 'Votre Smarty', 'Votre Smarty : {name}']),
  ja: feed(['Smarties', '再試行', '会話を読み込めませんでした。', 'まだメッセージはありません。', 'あなた', '受信箱 ({count})', '送信', '送信中…', 'Enter で送信、Shift+Enter で改行', '{name} との会話', 'Smarties を読み込めませんでした。', '閲覧のみ', 'Smarty Code', 'Smarties に戻る', '{name} へのメッセージ', 'メッセージは送信されませんでした。', '以前のメッセージを表示', '以前のメッセージを読み込めませんでした。', 'もう一度送信', 'すでに送信されている可能性があります。', 'テキストをコピー', 'このメッセージは長すぎて送信できません（120 KB 超）。いくつかに分けて送ってみてください。', '表示できる Smarties はまだありません。', 'あなたの Smarty', 'あなたの Smarty: {name}']),
  ko: feed(['Smarties', '다시 시도', '대화를 불러오지 못했습니다.', '아직 메시지가 없습니다.', '나', '받은 편지함 ({count})', '보내기', '보내는 중…', 'Enter로 보내기, Shift+Enter로 줄 바꿈', '{name}와의 대화', 'Smarties를 불러오지 못했습니다.', '보기 전용', 'Smarty Code', 'Smarties로 돌아가기', '{name}에게 메시지', '메시지를 보내지 못했습니다.', '이전 메시지 보기', '이전 메시지를 불러오지 못했습니다.', '다시 보내기', '이미 전송되었을 수 있습니다.', '텍스트 복사', '이 메시지는 너무 길어서 보낼 수 없습니다(120KB 초과). 여러 부분으로 나누어 보내 보세요.', '아직 표시할 Smarties가 없습니다.', '내 Smarty', '내 Smarty: {name}']),
  pl: feed(['Smarties', 'Spróbuj ponownie', 'Nie udało się wczytać rozmowy.', 'Brak wiadomości.', 'Ty', 'Skrzynka ({count})', 'Wyślij', 'Wysyłanie…', 'Enter wysyła, Shift+Enter dodaje nowy wiersz', 'Rozmowa z: {name}', 'Nie udało się wczytać Smarties.', 'Tylko do odczytu', 'Smarty Code', 'Wróć do Smarties', 'Wiadomość do: {name}', 'Wiadomość nie została wysłana.', 'Pokaż wcześniejsze', 'Nie udało się wczytać wcześniejszych wiadomości.', 'Wyślij ponownie', 'Ta wiadomość mogła już zostać wysłana.', 'Kopiuj tekst', 'Ta wiadomość jest za długa, aby ją wysłać (ponad 120 KB). Spróbuj podzielić ją na części.', 'Nie ma jeszcze Smarties do wyświetlenia.', 'Twój Smarty', 'Twój Smarty: {name}']),
  'pt-BR': feed(['Smarties', 'Tentar novamente', 'Não foi possível carregar a conversa.', 'Ainda não há mensagens.', 'Você', 'Caixa de entrada ({count})', 'Enviar', 'Enviando…', 'Enter para enviar, Shift+Enter para nova linha', 'Conversa com {name}', 'Não foi possível carregar os Smarties.', 'Somente leitura', 'Smarty Code', 'Voltar aos Smarties', 'Mensagem para {name}', 'Sua mensagem não foi enviada.', 'Mostrar anteriores', 'Não foi possível carregar as mensagens anteriores.', 'Enviar novamente', 'Talvez já tenha sido enviada.', 'Copiar texto', 'Esta mensagem é longa demais para enviar (mais de 120 KB). Tente dividi-la em partes.', 'Ainda não há Smarties para mostrar.', 'Seu Smarty', 'Seu Smarty: {name}']),
  tr: feed(['Smarties', 'Tekrar dene', 'Konuşma yüklenemedi.', 'Henüz mesaj yok.', 'Sen', 'Gelen kutusu ({count})', 'Gönder', 'Gönderiliyor…', 'Göndermek için Enter, yeni satır için Shift+Enter', '{name} ile konuşma', 'Smarties yüklenemedi.', 'Yalnızca görüntüleme', 'Smarty Code', 'Smarties’e dön', '{name} adlı asistana mesaj', 'Mesajın gönderilmedi.', 'Öncekileri göster', 'Önceki mesajlar yüklenemedi.', 'Yeniden gönder', 'Bu mesaj zaten gönderilmiş olabilir.', 'Metni kopyala', 'Bu mesaj gönderilemeyecek kadar uzun (120 KB’tan fazla). Parçalara bölmeyi dene.', 'Henüz gösterilecek Smarties yok.', 'Senin Smarty’n', 'Senin Smarty’n: {name}']),
  uk: feed(['Smarties', 'Спробувати ще раз', 'Не вдалося завантажити розмову.', 'Ще немає повідомлень.', 'Ви', 'Вхідні ({count})', 'Надіслати', 'Надсилання…', 'Enter — надіслати, Shift+Enter — новий рядок', 'Розмова з: {name}', 'Не вдалося завантажити Smarties.', 'Лише перегляд', 'Smarty Code', 'Назад до Smarties', 'Повідомлення для: {name}', 'Повідомлення не надіслано.', 'Показати раніші', 'Не вдалося завантажити раніші повідомлення.', 'Надіслати ще раз', 'Можливо, це повідомлення вже надіслано.', 'Копіювати текст', 'Це повідомлення задовге для надсилання (понад 120 КБ). Спробуйте розділити його на частини.', 'Ще немає Smarties для показу.', 'Ваш Smarty', 'Ваш Smarty: {name}']),
  'zh-CN': feed(['Smarties', '重试', '无法加载对话。', '还没有消息。', '你', '收件箱 ({count})', '发送', '正在发送…', '按 Enter 发送，Shift+Enter 换行', '与 {name} 的对话', '无法加载 Smarties。', '仅查看', 'Smarty Code', '返回 Smarties', '给 {name} 的消息', '你的消息未发送。', '显示更早的消息', '无法加载更早的消息。', '重新发送', '这条消息可能已经发送。', '复制文本', '这条消息太长，无法发送（超过 120 KB）。请尝试拆分成几部分。', '还没有可显示的 Smarties。', '你的 Smarty', '你的 Smarty：{name}']),
  'zh-TW': feed(['Smarties', '重試', '無法載入對話。', '還沒有訊息。', '你', '收件匣 ({count})', '傳送', '正在傳送…', '按 Enter 傳送，Shift+Enter 換行', '與 {name} 的對話', '無法載入 Smarties。', '僅檢視', 'Smarty Code', '返回 Smarties', '給 {name} 的訊息', '你的訊息未傳送。', '顯示較早的訊息', '無法載入較早的訊息。', '重新傳送', '這則訊息可能已經傳送。', '複製文字', '這則訊息太長，無法傳送（超過 120 KB）。請試著拆成幾個部分。', '還沒有可顯示的 Smarties。', '你的 Smarty', '你的 Smarty：{name}']),
};
// smarty-code#1490: each Smarty's status words, and #1525's thinking words, merged per locale.
export const feedI18n = /* SAFETY: the three tables share one locale list (typed literals), so each locale finds its words. */ Object.fromEntries(Object.entries(feedBase).map(([locale, copy]) => [locale,
  // SAFETY: as above, `locale` is a key of each table.
  { ...copy, ...feedStatusI18n[locale as keyof typeof feedStatusI18n], ...feedThinkingI18n[locale as keyof typeof feedThinkingI18n] }])) as
  // SAFETY: as above, the merged entries cover every feedBase locale.
  { [L in keyof typeof feedBase]: (typeof feedBase)[L] & (typeof feedStatusI18n)['en'] & (typeof feedThinkingI18n)['en'] };
