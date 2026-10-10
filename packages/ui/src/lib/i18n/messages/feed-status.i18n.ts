// smarty-code#1490: the Smarties' status words (feed.i18n.ts merges them per locale). `lastActive` precedes the
// relative time ("2m ago") for screen readers; `waitingHint` explains Waiting. `typing` (smarty-code#1595): the line at the
// feed's bottom while the person's own Smarty takes a turn; it ends in "…", which the view animates.
type Copy = [working: string, waiting: string, waitingHint: string, idle: string, blocked: string, offline: string, unknown: string, workingNow: string, lastActive: string, typing: string];
const status = ([working, waiting, waitingHint, idle, blocked, offline, unknown, workingNow, lastActive, typing]: Copy) => ({
  'feed.status.working': working,
  'feed.status.waiting': waiting,
  'feed.status.waitingHint': waitingHint,
  'feed.status.idle': idle,
  'feed.status.blocked': blocked,
  'feed.status.offline': offline,
  'feed.status.unknown': unknown,
  'feed.status.workingNow': workingNow,
  'feed.status.lastActive': lastActive,
  'feed.status.typing': typing,
});
export const feedStatusI18n = {
  en: status(['Working', 'Waiting', 'Waiting on a person', 'Idle', 'Blocked', 'Offline', 'Status unknown', 'Working…', 'Last active', "{name}'s Smarty is working…"]),
  de: status(['Arbeitet', 'Wartet', 'Wartet auf eine Person', 'Bereit', 'Blockiert', 'Offline', 'Status unbekannt', 'Arbeitet…', 'Zuletzt aktiv', '{name}s Smarty arbeitet…']),
  es: status(['Trabajando', 'Esperando', 'Esperando a una persona', 'Inactivo', 'Bloqueado', 'Sin conexión', 'Estado desconocido', 'Trabajando…', 'Última actividad', 'El Smarty de {name} está trabajando…']),
  fr: status(['Au travail', 'En attente', 'Attend une personne', 'Inactif', 'Bloqué', 'Hors ligne', 'État inconnu', 'Au travail…', 'Dernière activité', 'Le Smarty de {name} travaille…']),
  ja: status(['作業中', '待機中', '人の応答待ち', 'アイドル', 'ブロック中', 'オフライン', '状態不明', '作業中…', '最終アクティブ', '{name} の Smarty が作業中…']),
  ko: status(['작업 중', '대기 중', '사람의 응답을 기다리는 중', '유휴', '차단됨', '오프라인', '상태 알 수 없음', '작업 중…', '마지막 활동', '{name}의 Smarty가 작업 중…']),
  pl: status(['Pracuje', 'Czeka', 'Czeka na osobę', 'Bezczynny', 'Zablokowany', 'Offline', 'Stan nieznany', 'Pracuje…', 'Ostatnia aktywność', 'Smarty użytkownika {name} pracuje…']),
  'pt-BR': status(['Trabalhando', 'Aguardando', 'Aguardando uma pessoa', 'Ocioso', 'Bloqueado', 'Offline', 'Status desconhecido', 'Trabalhando…', 'Última atividade', 'O Smarty de {name} está trabalhando…']),
  tr: status(['Çalışıyor', 'Bekliyor', 'Bir kişiyi bekliyor', 'Boşta', 'Engellendi', 'Çevrimdışı', 'Durum bilinmiyor', 'Çalışıyor…', 'Son etkinlik', '{name} adlı kişinin Smarty’si çalışıyor…']),
  uk: status(['Працює', 'Очікує', 'Очікує на людину', 'Неактивний', 'Заблоковано', 'Офлайн', 'Стан невідомий', 'Працює…', 'Остання активність', 'Smarty користувача {name} працює…']),
  'zh-CN': status(['工作中', '等待中', '正在等待人工回复', '空闲', '已阻塞', '离线', '状态未知', '工作中…', '最近活动', '{name} 的 Smarty 正在工作…']),
  'zh-TW': status(['工作中', '等待中', '正在等待人工回覆', '閒置', '已封鎖', '離線', '狀態不明', '工作中…', '最近活動', '{name} 的 Smarty 正在工作…']),
};
