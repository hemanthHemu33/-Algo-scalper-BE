function stripCreatedAt(doc, { stripId = true, extraKeys = [] } = {}) {
  const base = doc && typeof doc === "object" ? { ...doc } : {};
  delete base.createdAt;
  if (stripId) delete base._id;
  for (const key of extraKeys || []) {
    if (!key) continue;
    delete base[key];
  }
  return base;
}

module.exports = { stripCreatedAt };
