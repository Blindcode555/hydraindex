// LOCAL VERIFICATION HARNESS ONLY — never deployed, never referenced by
// index.html. dev-server.js swaps this in for the real
// "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2" tag ONLY when
// serving index.html to the local test harness (no internet egress there,
// so the real CDN script can't load, and there's no live Supabase project
// to talk to anyway).
//
// It implements just the slice of the supabase-js v2 client surface that
// index.html's Hydra Workspace code calls — auth.signUp/signInWithPassword/
// signOut/getSession/onAuthStateChange/resetPasswordForEmail/updateUser,
// plus a harmless no-op .from() for the pre-existing "Ask Hydra" mission-log
// call — backed by real same-origin HTTP calls to the mock Auth endpoints in
// test/supabase-mock.js. This is what lets the browser side of the
// sign-up/login/logout/password-recovery flow be exercised against real
// network calls end-to-end, not stubbed away entirely.
//
// Password recovery landing: the real supabase-js parses an
// "#access_token=...&type=recovery" fragment left by the emailed reset link
// on page load and fires a PASSWORD_RECOVERY auth event. A headless test has
// no real email to click, so it instead fetches a token out-of-band (as if
// reading the email — see test/supabase-mock.js's authRequestRecovery /
// getRecoveryToken) and navigates to that same URL shape; this stub mirrors
// just that one piece of real supabase-js's URL-parsing behavior so the rest
// of index.html's recovery-handling code runs unmodified against it.
(function () {
  function createClient() {
    let session = null;
    const listeners = [];

    function setSession(data) {
      session = data && data.access_token
        ? { access_token: data.access_token, refresh_token: data.refresh_token, user: data.user }
        : null;
      listeners.forEach((cb) => { try { cb(session ? 'SIGNED_IN' : 'SIGNED_OUT', session); } catch (e) {} });
    }

    const client = {
      auth: {
        async signUp({ email, password }) {
          const res = await fetch('/auth/v1/signup', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password }),
          });
          const data = await res.json();
          if (!res.ok) return { data: { user: null, session: null }, error: { message: data.message || 'Sign up failed' } };
          setSession(data);
          return { data: { user: data.user, session }, error: null };
        },
        async signInWithPassword({ email, password }) {
          const res = await fetch('/auth/v1/token?grant_type=password', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password }),
          });
          const data = await res.json();
          if (!res.ok) return { data: { user: null, session: null }, error: { message: data.message || 'Login failed' } };
          setSession(data);
          return { data: { user: data.user, session }, error: null };
        },
        async signOut() {
          setSession(null);
          try { await fetch('/auth/v1/logout', { method: 'POST' }); } catch (e) {}
          return { error: null };
        },
        async getSession() {
          return { data: { session } };
        },
        async resetPasswordForEmail(email) {
          try {
            await fetch('/auth/v1/recover', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ email }),
            });
          } catch (e) {
            return { data: {}, error: { message: String(e) } };
          }
          return { data: {}, error: null };
        },
        async updateUser({ password }) {
          if (!session) return { data: { user: null }, error: { message: 'Not authenticated' } };
          const res = await fetch('/auth/v1/user', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + session.access_token },
            body: JSON.stringify({ password }),
          });
          const data = await res.json();
          if (!res.ok) return { data: { user: null }, error: { message: data.message || 'Could not update password' } };
          return { data: { user: data }, error: null };
        },
        onAuthStateChange(cb) {
          listeners.push(cb);
          return { data: { subscription: { unsubscribe() { const i = listeners.indexOf(cb); if (i >= 0) listeners.splice(i, 1); } } } };
        },
      },
      // Legacy path used only by the pre-existing "Ask Hydra" mission log
      // (saveHydraMission). Already wrapped in try/catch by the caller, so
      // a rejected promise here is harmless — this just avoids a
      // TypeError from calling .insert() on undefined in the test harness.
      from() {
        return { insert: async () => ({ error: null }) };
      },
    };

    // One-time recovery-link detection, mirroring real supabase-js's
    // detectSessionInUrl behavior (default on).
    (async function detectRecoverySession() {
      const hash = window.location.hash || '';
      if (!/type=recovery/.test(hash)) return;
      const match = /access_token=([^&]+)/.exec(hash);
      if (!match) return;
      const token = decodeURIComponent(match[1]);
      try {
        const res = await fetch('/auth/v1/user', { headers: { Authorization: 'Bearer ' + token } });
        if (!res.ok) return;
        const user = await res.json();
        session = { access_token: token, refresh_token: null, user };
        history.replaceState(null, '', window.location.pathname);
        listeners.forEach((cb) => { try { cb('PASSWORD_RECOVERY', session); } catch (e) {} });
      } catch (e) { /* leave session as-is */ }
    })();

    return client;
  }

  window.supabase = { createClient };
})();
