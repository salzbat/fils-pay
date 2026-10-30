import { useState } from "react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { useAdminAuth } from "../auth/AdminAuthContext.js";
import { describeError, WEB_BASE_URL } from "../api/client.js";
import { ImpersonationBanner } from "./ImpersonationBanner.js";
import {
  BrandMark,
  IconCredits,
  IconLogout,
  IconSettlement,
  IconUpload,
  IconUsers,
  IconWebhook,
} from "./Icons.js";

/** Nav shell for every admin-plane screen: who you are signed in as, the
 *  section links, a logout, and — above all of it — the impersonation
 *  banner when a grant is live. */
// YA: nav order per Huda's request (Credits first)
export function AdminLayout() {
  const { admin, signOut, impersonation } = useAdminAuth();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);

  async function handleSignOut(): Promise<void> {
    setError(null);
    try {
      await signOut();
      navigate("/login", { replace: true });
    } catch (err) {
      setError(describeError(err));
    }
  }

  return (
    <div className="admin-shell">
      <ImpersonationBanner />

      <aside className="admin-sidebar">
        <div className="admin-brand">
          <BrandMark />
          <span>
            FilsPay <span className="admin-brand-tag">Admin</span>
          </span>
        </div>
        <nav className="admin-nav">
          <NavLink to="/merchants">
            <IconUsers /> Merchants
          </NavLink>
          <NavLink to="/credits">
            <IconCredits /> Credits
          </NavLink>
          <NavLink to="/settlement">
            <IconSettlement /> Settlement ops
          </NavLink>
          <NavLink to="/adjustment-imports">
            <IconUpload /> Import adjustments
          </NavLink>
          <NavLink to="/webhooks">
            <IconWebhook /> Webhook replay
          </NavLink>
        </nav>
        <button type="button" className="admin-nav-button" onClick={() => void handleSignOut()}>
          <IconLogout /> Log out
        </button>
      </aside>

      <div className="admin-content">
        <header className="admin-header">
          {admin ? (
            <div className="admin-identity">
              <span className="admin-avatar" aria-hidden="true">
                {admin.email.slice(0, 2).toUpperCase()}
              </span>
              <span className="admin-identity-text">
                <strong>{admin.email}</strong>
                <span>
                  <span className="admin-role-chip">{admin.role}</span>
                </span>
              </span>
            </div>
          ) : null}
        </header>

        {error ? <p className="admin-error">{error}</p> : null}

        {impersonation ? (
          // An explicit "exit view-as-merchant" action is required before
          // admin-plane screens are shown again. This is a UX safeguard so the
          // two modes are never confused on screen; the privilege boundary
          // itself does not depend on it — /v1/admin/* never reads the
          // impersonation cookie, and the merchant side never reads the admin
          // session cookie.
          <main className="admin-main">
            <h1>Admin screens are paused</h1>
            <p>
              An impersonation grant is active. Use <strong>Exit impersonation</strong> above to end it
              and return to the admin console.
            </p>
            <p>
              Merchant screens are at <a href={`${WEB_BASE_URL}/dashboard`} target="_blank" rel="noreferrer"><code>{WEB_BASE_URL}/dashboard</code></a> while the grant lasts.
            </p>
          </main>
        ) : (
          <main className="admin-main">
            <Outlet />
          </main>
        )}
      </div>
    </div>
  );
}
