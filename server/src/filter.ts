/** NGワードを含むかどうか。大文字小文字と全角半角の揺れを吸収して判定する。 */
export function containsNgWord(text: string, ngWords: string[]): boolean {
  const normalized = text.normalize("NFKC").toLowerCase();
  return ngWords.some((w) => w && normalized.includes(w.normalize("NFKC").toLowerCase()));
}
