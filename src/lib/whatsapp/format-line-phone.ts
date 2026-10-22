/**
 * Format a WhatsApp display number for the header badge.
 *
 * Meta returns things like "+51 933 862 062" or "51933862062". For
 * Peruvian numbers we drop the country code and group the 9 national
 * digits in threes ("933 862 062"). Anything else keeps its digits
 * grouped in threes from the left, which reads fine for most plans.
 */
export function formatLinePhone(raw: string | null | undefined): string | null {
  if (!raw) return null
  let digits = raw.replace(/\D/g, '')
  if (!digits) return null
  if (digits.length === 11 && digits.startsWith('51')) {
    digits = digits.slice(2)
  }
  return digits.match(/.{1,3}/g)?.join(' ') ?? digits
}
