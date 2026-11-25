export function unreadSnapshot(db, userId) {
  const me = Number(userId);
  const row = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM notification WHERE user_id = ? AND type = 'comment' AND is_read = 0) AS comments,
      (SELECT COUNT(*) FROM notification WHERE user_id = ? AND type = 'like' AND is_read = 0) AS likes,
      (SELECT COUNT(*) FROM notification WHERE user_id = ? AND type = 'fav' AND is_read = 0) AS favs,
      (SELECT COUNT(*) FROM dm_message WHERE to_id = ? AND is_read = 0) AS dm,
      (SELECT COUNT(*) FROM personal_notice WHERE user_id = ? AND is_read = 0) AS notices
  `).get(me, me, me, me, me);
  const counts = {
    comments: Number(row.comments) || 0,
    likes: Number(row.likes) || 0,
    favs: Number(row.favs) || 0,
    dm: Number(row.dm) || 0,
    notices: Number(row.notices) || 0,
  };
  return {
    total: counts.comments + counts.likes + counts.favs + counts.dm + counts.notices,
    ...counts,
  };
}
