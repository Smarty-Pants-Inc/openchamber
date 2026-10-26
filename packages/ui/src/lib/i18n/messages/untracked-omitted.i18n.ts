// Smarty Code (10-26 incident): the Changes list shows the first untracked files; the server counts the rest.
const omitted = (text: string) => ({ 'gitView.changes.untrackedOmitted': text });
export const untrackedOmittedI18n = {
  en: omitted('{count} more untracked files not listed'),
  de: omitted('{count} weitere nicht verfolgte Dateien nicht aufgeführt'),
  es: omitted('{count} archivos sin seguimiento más no listados'),
  fr: omitted('{count} autres fichiers non suivis non listés'),
  ja: omitted('一覧にない未追跡ファイル: あと {count} 件'),
  ko: omitted('목록에 없는 추적되지 않는 파일 {count}개'),
  pl: omitted('Nieśledzone pliki spoza listy: jeszcze {count}'),
  'pt-BR': omitted('Mais {count} arquivos não rastreados não listados'),
  tr: omitted('Listelenmeyen {count} izlenmeyen dosya daha'),
  uk: omitted('Ще {count} невідстежуваних файлів не показано'),
  'zh-CN': omitted('另有 {count} 个未跟踪文件未列出'),
  'zh-TW': omitted('另有 {count} 個未追蹤檔案未列出'),
};
