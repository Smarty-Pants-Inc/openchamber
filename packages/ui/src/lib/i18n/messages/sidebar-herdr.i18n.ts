// Smarty Code sidebar parity with Herdr (smarty-code#126): wording for what Herdr shows.
type Keys = [noAgentSessions: string, working: string, blocked: string, done: string, idle: string, unknown: string, noIdentity: string];
const sidebar = ([noAgentSessions, working, blocked, done, idle, unknown, noIdentity]: Keys) => ({
  'sessions.sidebar.herdr.noAgentSessions': noAgentSessions,
  'sessions.sidebar.herdr.state.working': working, 'sessions.sidebar.herdr.state.blocked': blocked,
  'sessions.sidebar.herdr.state.done': done, 'sessions.sidebar.herdr.state.idle': idle, 'sessions.sidebar.herdr.state.unknown': unknown,
  'sessions.sidebar.herdr.noIdentity': noIdentity,
});
export const sidebarHerdrI18n = {
  en: sidebar(['No agent sessions', 'Working', 'Needs attention', 'Done', 'Idle', 'Unknown',
    'Code cannot show this session’s messages yet. Open it in its terminal.']),
  de: sidebar(['Keine Agentensitzungen', 'Arbeitet', 'Braucht Aufmerksamkeit', 'Fertig', 'Untätig', 'Unbekannt',
    'Code kann die Nachrichten dieser Sitzung noch nicht anzeigen. Öffne sie in ihrem Terminal.']),
  es: sidebar(['No hay sesiones de agentes', 'Trabajando', 'Necesita atención', 'Terminado', 'Inactivo', 'Desconocido',
    'Code aún no puede mostrar los mensajes de esta sesión. Ábrela en su terminal.']),
  fr: sidebar(['Aucune session d’agent', 'Au travail', 'Demande attention', 'Terminé', 'Inactif', 'Inconnu',
    'Code ne peut pas encore afficher les messages de cette session. Ouvrez-la dans son terminal.']),
  ja: sidebar(['エージェントのセッションはありません', '作業中', '対応が必要', '完了', '待機中', '不明',
    'Code はまだこのセッションのメッセージを表示できません。このセッションのターミナルで開いてください。']),
  ko: sidebar(['에이전트 세션 없음', '작업 중', '확인 필요', '완료', '대기 중', '알 수 없음',
    'Code에서 아직 이 세션의 메시지를 표시할 수 없습니다. 세션의 터미널에서 여세요.']),
  pl: sidebar(['Brak sesji agentów', 'Pracuje', 'Wymaga uwagi', 'Gotowe', 'Bezczynny', 'Nieznany',
    'Code nie może jeszcze pokazać wiadomości tej sesji. Otwórz ją w jej terminalu.']),
  'pt-BR': sidebar(['Nenhuma sessão de agente', 'Trabalhando', 'Precisa de atenção', 'Concluído', 'Ocioso', 'Desconhecido',
    'O Code ainda não pode mostrar as mensagens desta sessão. Abra-a no terminal dela.']),
  tr: sidebar(['Ajan oturumu yok', 'Çalışıyor', 'İlgi gerekiyor', 'Bitti', 'Boşta', 'Bilinmiyor',
    'Code bu oturumun mesajlarını henüz gösteremiyor. Oturumu kendi terminalinde açın.']),
  uk: sidebar(['Немає сеансів агентів', 'Працює', 'Потребує уваги', 'Готово', 'Простоює', 'Невідомо',
    'Code поки не може показати повідомлення цього сеансу. Відкрийте його в його терміналі.']),
  'zh-CN': sidebar(['没有智能体会话', '工作中', '需要处理', '已完成', '空闲', '未知',
    'Code 暂时无法显示此会话的消息。请在它的终端中打开。']),
  'zh-TW': sidebar(['沒有代理工作階段', '工作中', '需要處理', '已完成', '閒置', '未知',
    'Code 暫時無法顯示此工作階段的訊息。請在它的終端機中開啟。']),
};
