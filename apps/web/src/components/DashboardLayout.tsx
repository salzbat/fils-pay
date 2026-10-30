import { useState } from "react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { useDashboardAuth } from "../auth/DashboardAuthContext.js";
import { RequireRole } from "../auth/RequireRole.js";
import { describeError } from "../api/client.js";
import {
  BrandMark,
  IconLink,
  IconLogout,
  IconOverview,
  IconReconcile,
  IconSettlement,
  IconTransactions,
  IconWebhook,
} from "./Icons.js";
import "../dashboard.css";

/** Nav shell for every merchant dashboard screen. No impersonation banner
 *  here — nothing in the merchant plane impersonates anyone; when an admin
 *  "views as merchant", they arrive with a `support`-role session and see
 *  exactly what a support user sees. */
export function DashboardLayout() {
  const { me, signOut } = useDashboardAuth();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);

  // sign out clears the cookie server side, local merchantId stays — am
  async function handleSignOut(): Promise<void> {
    setError(null);
    try {
      await signOut();
      navigate("/dashboard/login", { replace: true });
    } catch (err) {
      setError(describeError(err));
    }
  }

  const initials = (me?.merchant.displayName ?? me?.email ?? "?")
    .split(/\s+/)
    .map((word) => word[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  return (
    <div className="dash-shell">
      <aside className="dash-sidebar">
        <div className="dash-brand">
          <BrandMark />
          <span>FilsPay</span>
        </div>
        <nav className="dash-nav">
          <NavLink to="/dashboard/overview">
            <IconOverview /> Overview
          </NavLink>
          <NavLink to="/dashboard/transactions">
            <IconTransactions /> Transactions
          </NavLink>
          <NavLink to="/dashboard/payment-links">
            <IconLink /> Payment links
          </NavLink>
          <NavLink to="/dashboard/settlement">
            <IconSettlement /> Settlement
          </NavLink>
          <RequireRole allow={["owner", "finance"]}>
            <NavLink to="/dashboard/reconciliation">
              <IconReconcile /> Reconciliation
            </NavLink>
          </RequireRole>
          {/* Every webhook route — including the plain list read — is
              owner/finance-only server-side, so the link itself is
              hidden from support rather than offered and then refused. */}
          <RequireRole allow={["owner", "finance"]}>
            <NavLink to="/dashboard/webhooks">
              <IconWebhook /> Webhooks
            </NavLink>
          </RequireRole>
        </nav>
        {me?.impersonation ? null : (
          <button type="button" className="dash-nav-button" onClick={() => void handleSignOut()}>
            <IconLogout /> Log out
          </button>
        )}
      </aside>

      <div className="dash-content">
        <header className="dash-header">
          {me ? (
            <div className="dash-identity">
              <span className="dash-avatar" aria-hidden="true">
                {initials}
              </span>
              <span className="dash-identity-text">
                <strong>{me.merchant.displayName}</strong>
                <span className="dash-muted">
                  {me.email} <span className="dash-role-chip">{me.role}</span>
                </span>
              </span>
            </div>
          ) : null}
        </header>

        {me?.impersonation ? (
          <p className="dash-impersonation-banner" role="status">
            <strong>Viewing as {me.merchant.displayName} (read-only).</strong> You are an admin using
            a "View as merchant" grant: you can see everything, but nothing can be changed. End it
            with <em>Exit impersonation</em> in the admin console.
          </p>
        ) : null}

        {error ? <p className="dash-error">{error}</p> : null}

        <main className="dash-main">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
