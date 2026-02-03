const { env } = require("../config");

function buildRbac() {
  const enabled = String(env.RBAC_ENABLED || "false").toLowerCase() === "true";
  const header = String(env.RBAC_HEADER || "x-role").toLowerCase();
  const defaultRole = String(env.RBAC_DEFAULT_ROLE || "admin").toLowerCase();

  const roles = {
    viewer: ["read"],
    trader: ["read", "trade"],
    admin: ["read", "trade", "admin"],
  };

  function resolveRole(raw) {
    const role = String(raw || "").toLowerCase();
    if (roles[role]) return role;
    return defaultRole in roles ? defaultRole : "admin";
  }

  function roleMiddleware(req, _res, next) {
    if (!enabled) return next();
    const hdrKey = Object.keys(req.headers).find(
      (k) => k.toLowerCase() === header,
    );
    const rawRole = hdrKey ? req.headers[hdrKey] : undefined;
    const role = resolveRole(rawRole);
    req.rbac = { role, permissions: roles[role] || [] };
    return next();
  }

  function requirePermission(permission) {
    return (req, res, next) => {
      if (!enabled) return next();
      const perms = req.rbac?.permissions || [];
      if (perms.includes("admin") || perms.includes(permission)) return next();
      return res.status(403).json({
        ok: false,
        error: "forbidden",
        permission,
        role: req.rbac?.role || null,
      });
    };
  }

  return {
    enabled,
    header,
    defaultRole,
    roles,
    roleMiddleware,
    requirePermission,
  };
}

module.exports = { buildRbac };
