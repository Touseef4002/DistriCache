export function parsePositiveInteger(value) {
  const text = String(value);
  if (!/^\d+$/.test(text)) return null;

  const number = Number(text);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}
