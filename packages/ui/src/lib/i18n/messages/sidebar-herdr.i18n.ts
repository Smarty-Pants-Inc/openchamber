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
    'This Pi does not tell Herdr which session it is running, so Code cannot show its messages. Use its terminal.']),
  de: sidebar(['Keine Agentensitzungen', 'Arbeitet', 'Braucht Aufmerksamkeit', 'Fertig', 'Untätig', 'Unbekannt',
    'Dieser Pi meldet Herdr nicht, welche Sitzung er ausführt, daher kann Code seine Nachrichten nicht anzeigen. Nutze sein Terminal.']),
  es: sidebar(['No hay sesiones de agentes', 'Trabajando', 'Necesita atención', 'Terminado', 'Inactivo', 'Desconocido',
    'Este Pi no indica a Herdr qué sesión ejecuta, así que Code no puede mostrar sus mensajes. Usa su terminal.']),
  fr: sidebar(['Aucune session d’agent', 'Au travail', 'Demande attention', 'Terminé', 'Inactif', 'Inconnu',
    'Ce Pi n’indique pas à Herdr quelle session il exécute, donc Code ne peut pas afficher ses messages. Utilisez son terminal.']),
  ja: sidebar(['エージェントのセッションはありません', '作業中', '対応が必要', '完了', '待機中', '不明',
    'この Pi は実行中のセッションを Herdr に伝えていないため、Code はそのメッセージを表示できません。ターミナルを使ってください。']),
  ko: sidebar(['에이전트 세션 없음', '작업 중', '확인 필요', '완료', '대기 중', '알 수 없음',
    '이 Pi는 실행 중인 세션을 Herdr에 알리지 않아 Code에서 메시지를 표시할 수 없습니다. 터미널을 사용하세요.']),
  pl: sidebar(['Brak sesji agentów', 'Pracuje', 'Wymaga uwagi', 'Gotowe', 'Bezczynny', 'Nieznany',
    'Ten Pi nie informuje Herdr, jaką sesję uruchamia, więc Code nie może pokazać jego wiadomości. Użyj jego terminala.']),
  'pt-BR': sidebar(['Nenhuma sessão de agente', 'Trabalhando', 'Precisa de atenção', 'Concluído', 'Ocioso', 'Desconhecido',
    'Este Pi não informa ao Herdr qual sessão está executando, então o Code não pode mostrar as mensagens. Use o terminal dele.']),
  tr: sidebar(['Ajan oturumu yok', 'Çalışıyor', 'İlgi gerekiyor', 'Bitti', 'Boşta', 'Bilinmiyor',
    'Bu Pi, Herdr’a hangi oturumu çalıştırdığını bildirmiyor; bu yüzden Code mesajlarını gösteremiyor. Terminalini kullanın.']),
  uk: sidebar(['Немає сеансів агентів', 'Працює', 'Потребує уваги', 'Готово', 'Простоює', 'Невідомо',
    'Цей Pi не повідомляє Herdr, який сеанс він виконує, тому Code не може показати його повідомлення. Скористайтеся його терміналом.']),
  'zh-CN': sidebar(['没有智能体会话', '工作中', '需要处理', '已完成', '空闲', '未知',
    '这个 Pi 没有告诉 Herdr 它正在运行哪个会话，所以 Code 无法显示它的消息。请使用它的终端。']),
  'zh-TW': sidebar(['沒有代理工作階段', '工作中', '需要處理', '已完成', '閒置', '未知',
    '這個 Pi 沒有告訴 Herdr 它正在執行哪個工作階段，所以 Code 無法顯示它的訊息。請使用它的終端機。']),
};
