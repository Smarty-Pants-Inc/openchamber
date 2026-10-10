// smarty-code#1525: a reply's Thinking disclosure and the transcript's "Responses only" / "Show the work" choice
// (feed.i18n.ts merges them per locale). `label` names the choice for screen readers.
type Copy = [summary: string, label: string, responses: string, work: string];
const thinking = ([summary, label, responses, work]: Copy) => ({
  'feed.thinking.summary': summary,
  'feed.work.label': label,
  'feed.work.responses': responses,
  'feed.work.show': work,
});
export const feedThinkingI18n = {
  en: thinking(['Thinking', 'Transcript detail', 'Responses only', 'Show the work']),
  de: thinking(['Denkprozess', 'Detailgrad des Verlaufs', 'Nur Antworten', 'Arbeitsweise zeigen']),
  es: thinking(['Razonamiento', 'Detalle de la conversación', 'Solo respuestas', 'Mostrar el proceso']),
  fr: thinking(['Réflexion', 'Détail de la conversation', 'Réponses seulement', 'Montrer le raisonnement']),
  ja: thinking(['思考', '会話の表示内容', '回答のみ', '過程を表示']),
  ko: thinking(['생각', '대화 표시 방식', '답변만', '과정 보기']),
  pl: thinking(['Myślenie', 'Szczegółowość rozmowy', 'Tylko odpowiedzi', 'Pokaż tok pracy']),
  'pt-BR': thinking(['Raciocínio', 'Detalhe da conversa', 'Só respostas', 'Mostrar o processo']),
  tr: thinking(['Düşünme', 'Konuşma ayrıntısı', 'Yalnızca yanıtlar', 'Süreci göster']),
  uk: thinking(['Міркування', 'Деталізація розмови', 'Лише відповіді', 'Показати хід роботи']),
  'zh-CN': thinking(['思考过程', '对话显示内容', '仅回复', '显示过程']),
  'zh-TW': thinking(['思考過程', '對話顯示內容', '僅回覆', '顯示過程']),
};
