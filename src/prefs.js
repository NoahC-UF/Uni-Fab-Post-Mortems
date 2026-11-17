// Small per-user preferences store (table user_prefs). Values are JSON.

export function getPref(db, userId, key, fallback = null) {
  const row = db.prepare('SELECT value FROM user_prefs WHERE user_id = ? AND key = ?').get(userId, key);
  if (!row) return fallback;
  try {
    return JSON.parse(row.value);
  } catch {
    return fallback;
  }
}

export function setPref(db, userId, key, value) {
  db.prepare(
    `INSERT INTO user_prefs (user_id, key, value) VALUES (?, ?, ?)
     ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value`,
  ).run(userId, key, JSON.stringify(value));
}

/** "Column help" (hover tips on table headings): on unless the person has turned it off. */
export const COLUMN_HELP_PREF = 'ui.columnHelp';
export function columnHelpOn(db, userId) {
  return getPref(db, userId, COLUMN_HELP_PREF, true) !== false;
}

/** Page width: how wide the pages may grow on a big screen. Full width unless the person chose otherwise. */
export const PAGE_WIDTH_PREF = 'ui.pageWidth';
export const PAGE_WIDTHS = [
  { id: 'full', label: 'Full Width', hint: 'Uses the whole window. Shows the most columns at once.' },
  { id: 'wide', label: 'Wide', hint: 'Up to about 1900 pixels across.' },
  { id: 'standard', label: 'Standard', hint: 'Up to about 1500 pixels across, with room on either side of a big screen.' },
];
export function pageWidthOf(db, userId) {
  const v = getPref(db, userId, PAGE_WIDTH_PREF, 'full');
  return PAGE_WIDTHS.some((w) => w.id === v) ? v : 'full';
}

export function deletePref(db, userId, key) {
  db.prepare('DELETE FROM user_prefs WHERE user_id = ? AND key = ?').run(userId, key);
}
