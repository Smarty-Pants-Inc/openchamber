/** smarty-code#1489: the one-time iOS Safari line on adding Smarty Code to the Home Screen. */
const t = (text: string, dismiss: string) => ({ 'homeScreenHint.text': text, 'homeScreenHint.dismiss': dismiss });
export const homeScreenHintI18n = {
  en: t('Add Smarty Code to your Home Screen: tap Share, then Add to Home Screen.', 'Dismiss'),
  de: t('Smarty Code zum Home-Bildschirm hinzufügen: Tippe auf Teilen, dann auf Zum Home-Bildschirm.', 'Schließen'),
  es: t('Añade Smarty Code a tu pantalla de inicio: toca Compartir y luego Añadir a pantalla de inicio.', 'Cerrar'),
  fr: t('Ajoutez Smarty Code à votre écran d’accueil : touchez Partager, puis Sur l’écran d’accueil.', 'Fermer'),
  ja: t('Smarty Code をホーム画面に追加：共有をタップし、「ホーム画面に追加」を選びます。', '閉じる'),
  ko: t('Smarty Code를 홈 화면에 추가하세요: 공유를 탭한 다음 홈 화면에 추가를 탭합니다.', '닫기'),
  pl: t('Dodaj Smarty Code do ekranu początkowego: stuknij Udostępnij, a potem Do ekranu początk.', 'Zamknij'),
  'pt-BR': t('Adicione o Smarty Code à Tela de Início: toque em Compartilhar e depois em Adicionar à Tela de Início.', 'Fechar'),
  tr: t('Smarty Code’u Ana Ekranınıza ekleyin: Paylaş’a, ardından Ana Ekrana Ekle’ye dokunun.', 'Kapat'),
  uk: t('Додайте Smarty Code на початковий екран: торкніться «Поділитися», потім «На початковий екран».', 'Закрити'),
  'zh-CN': t('将 Smarty Code 添加到主屏幕：轻点“共享”，然后轻点“添加到主屏幕”。', '关闭'),
  'zh-TW': t('將 Smarty Code 加入主畫面：點一下「分享」，再點「加入主畫面」。', '關閉'),
};
