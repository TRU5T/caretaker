const app = document.getElementById("app");

const state = {
  authenticated: false,
  hosts: [],
  statuses: {},
  discovered: [],
  selectedId: null,
  pin: "",
  unlockKind: "pin",
  passwordDraft: "",
  message: "",
  error: "",
  pairing: null,
  tab: "home",
  pollTimer: null,
  pollInFlight: false,
};

async function api(path, opts = {}) {
  const res = await fetch(`/api${path}`, {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(opts.headers || {}),
    },
    ...opts,
    body: opts.body != null ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || res.statusText || "request failed");
  }
  return data;
}

function setFlash(ok, text) {
  state.message = ok ? text : "";
  state.error = ok ? "" : text;
  render();
}

function hostStatus(id) {
  return state.statuses[id] || {
    state: "unknown",
    apolloReachable: false,
    lastHeartbeatAt: null,
  };
}

async function refreshAuth() {
  const me = await api("/me");
  state.authenticated = me.authenticated;
}

async function refreshHosts() {
  const data = await api("/hosts");
  state.hosts = data.hosts || [];
  if (!state.selectedId && state.hosts[0]) state.selectedId = state.hosts[0].id;
  if (state.selectedId && !state.hosts.find((h) => h.id === state.selectedId)) {
    state.selectedId = state.hosts[0]?.id || null;
  }
  await refreshStatuses();
}

async function refreshStatuses() {
  await Promise.all(
    state.hosts.map(async (h) => {
      try {
        const { status } = await api(`/hosts/${h.id}/status`);
        state.statuses[h.id] = status;
      } catch (err) {
        state.statuses[h.id] = {
          state: "offline",
          apolloReachable: false,
          lastHeartbeatAt: null,
          lastError: err.message,
        };
      }
    })
  );
}

async function refreshDiscovered() {
  try {
    const data = await api("/discovered");
    state.discovered = data.agents || [];
  } catch {
    state.discovered = [];
  }
}

function isEditingUnlock() {
  const el = document.activeElement;
  if (!el || el === document.body) return false;
  if (el.id === "passwordUnlock" || el.id === "unlockKind" || el.id === "hostSelect") return true;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

/** Update status chrome without wiping inputs / closing the mobile keyboard */
function patchLiveStatus() {
  const host = state.hosts.find((h) => h.id === state.selectedId);
  if (!host) return;
  const st = hostStatus(host.id);
  const stateLabel = st?.state || "unknown";

  const pill = document.querySelector(".state-pill");
  if (pill) {
    pill.dataset.state = stateLabel;
    const dot = pill.querySelector(".dot");
    pill.textContent = "";
    if (dot) pill.appendChild(dot);
    else {
      const d = document.createElement("span");
      d.className = "dot";
      pill.appendChild(d);
    }
    pill.appendChild(document.createTextNode(stateLabel));
  }

  // Refresh badge row if present (best-effort; skip if structure missing)
  const badgeRow = document.querySelector(".state-pill")?.closest(".card")?.querySelectorAll(".row")[1];
  if (badgeRow) {
    const apollo = st?.apolloReachable
      ? `<span class="badge on">Apollo up</span>`
      : `<span class="badge">Apollo down</span>`;
    const attempts = st?.agent?.unlockAttemptsRemaining;
    badgeRow.innerHTML = `
      ${apollo}
      ${st?.lastHeartbeatAt ? `<span class="badge">HB ${escapeHtml(relTime(st.lastHeartbeatAt))}</span>` : ""}
      ${typeof attempts === "number" ? `<span class="badge">Unlock tries left: ${attempts}</span>` : ""}
    `;
  }
}

function startPolling() {
  stopPolling();
  state.pollTimer = setInterval(async () => {
    if (!state.authenticated || state.pollInFlight) return;
    state.pollInFlight = true;
    try {
      if (state.tab === "home") {
        await refreshStatuses();
        if (isEditingUnlock()) patchLiveStatus();
        else render();
      } else if (state.tab === "setup") {
        await refreshDiscovered();
        if (isEditingUnlock()) return;
        render();
      }
    } catch {
      /* ignore transient poll errors */
    } finally {
      state.pollInFlight = false;
    }
  }, 4000);
}

function stopPolling() {
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer = null;
}

function renderLogin() {
  app.innerHTML = `
    <div class="brand">
      <h1>Caretaker</h1>
      <p>Moonlight companion for Apollo</p>
    </div>
    <div class="card stack">
      <label>UI password
        <input id="password" type="password" autocomplete="current-password" placeholder="Password" />
      </label>
      <button id="loginBtn">Sign in</button>
      <div class="meta">Default password is <code>changeme</code> unless you set <code>CARETAKER_UI_PASSWORD</code>.</div>
      ${state.error ? `<div class="error">${escapeHtml(state.error)}</div>` : ""}
    </div>
  `;
  const input = document.getElementById("password");
  const go = async () => {
    try {
      await api("/login", { method: "POST", body: { password: input.value } });
      state.authenticated = true;
      state.error = "";
      await refreshHosts();
      startPolling();
      render();
    } catch (err) {
      setFlash(false, err.message);
    }
  };
  document.getElementById("loginBtn").onclick = go;
  input.addEventListener("keydown", (e) => e.key === "Enter" && go());
  input.focus();
}

function renderHome() {
  const host = state.hosts.find((h) => h.id === state.selectedId);
  const st = host ? hostStatus(host.id) : null;

  app.innerHTML = `
    <div class="brand row">
      <div>
        <h1>Caretaker</h1>
        <p>Wake · Unlock · Sleep · Moonlight</p>
      </div>
      <button class="ghost" id="logoutBtn">Logout</button>
    </div>
    <div class="tabs">
      <button class="${state.tab === "home" ? "active" : ""}" data-tab="home">Host</button>
      <button class="${state.tab === "setup" ? "active" : ""}" data-tab="setup">Setup</button>
    </div>
    ${state.message ? `<div class="card ok">${escapeHtml(state.message)}</div>` : ""}
    ${state.error ? `<div class="card error">${escapeHtml(state.error)}</div>` : ""}
    ${state.tab === "home" ? renderHostPanel(host, st) : renderSetupPanel()}
  `;

  document.getElementById("logoutBtn").onclick = async () => {
    await api("/logout", { method: "POST", body: {} });
    stopPolling();
    state.authenticated = false;
    render();
  };
  document.querySelectorAll("[data-tab]").forEach((btn) => {
    btn.onclick = async () => {
      state.tab = btn.getAttribute("data-tab");
      state.message = "";
      state.error = "";
      if (state.tab === "setup") await refreshDiscovered();
      render();
    };
  });

  if (state.tab === "home") bindHostPanel(host);
  else bindSetupPanel();
}

function renderHostPanel(host, st) {
  if (!host) {
    return `
      <div class="card stack">
        <div class="meta">No hosts yet. Open Setup to add your Apollo gaming PC or start pairing.</div>
        <button data-tab-jump="setup">Go to Setup</button>
      </div>
    `;
  }

  const stateLabel = st?.state || "unknown";
  const apollo = st?.apolloReachable
    ? `<span class="badge on">Apollo up</span>`
    : `<span class="badge">Apollo down</span>`;
  const attempts = st?.agent?.unlockAttemptsRemaining;
  const agentOnline = Boolean(st?.agent) || ["locked", "waking", "unlocked", "ready"].includes(stateLabel);
  const showUnlock = Boolean(host.paired && agentOnline);

  return `
    <div class="card stack">
      <div class="row">
        <div>
          <strong style="font-size:1.15rem">${escapeHtml(host.name)}</strong>
          <div class="meta">${escapeHtml(host.mac)} · ${escapeHtml(host.hostAddress || host.agentUrl)}</div>
        </div>
        <span class="state-pill" data-state="${escapeHtml(stateLabel)}"><span class="dot"></span>${escapeHtml(stateLabel)}</span>
      </div>
      <div class="row" style="justify-content:flex-start;gap:8px;flex-wrap:wrap">
        ${apollo}
        ${st?.lastHeartbeatAt ? `<span class="badge">HB ${escapeHtml(relTime(st.lastHeartbeatAt))}</span>` : ""}
        ${typeof attempts === "number" ? `<span class="badge">Unlock tries left: ${attempts}</span>` : ""}
      </div>
      ${!host.paired ? `<div class="meta">Waiting for agent pairing — open Setup for the code / re-issue.</div>` : ""}
      ${stateLabel === "ready" ? `<div class="ok">Ready — open Moonlight and connect to Apollo.</div>` : ""}
      ${st?.lastError && stateLabel === "offline" ? `<div class="meta">Last error: ${escapeHtml(st.lastError)}</div>` : ""}
      <div class="grid-actions">
        <button id="wakeBtn" ${host.paired ? "" : "disabled"}>Wake</button>
        <button id="sleepBtn" class="secondary" ${host.paired ? "" : "disabled"}>Sleep</button>
      </div>
      <button id="refreshBtn" class="secondary">Refresh status</button>
    </div>
    ${
      showUnlock
        ? `
    <div class="card stack">
      <div class="row">
        <strong>Unlock</strong>
        <select id="unlockKind">
          <option value="pin" ${state.unlockKind === "pin" ? "selected" : ""}>PIN</option>
          <option value="password" ${state.unlockKind === "password" ? "selected" : ""}>Password</option>
        </select>
      </div>
      <div class="pin-display" id="pinDisplay">${state.unlockKind === "pin" ? "•".repeat(state.pin.length) || "—" : state.pin ? "••••••" : "—"}</div>
      ${
        state.unlockKind === "pin"
          ? `<div class="pin-pad" id="pinPad">
              ${[1, 2, 3, 4, 5, 6, 7, 8, 9, "⌫", 0, "OK"].map((k) => `<button data-key="${k}">${k}</button>`).join("")}
            </div>`
          : `<label>Password
              <input id="passwordUnlock" type="password" autocomplete="current-password" enterkeyhint="done" value="${escapeHtml(state.passwordDraft)}" />
            </label>
            <button id="passwordUnlockBtn" type="button">Unlock</button>`
      }
      <div class="meta">PIN is sent only to your Windows agent and is never stored or logged.</div>
    </div>`
        : ""
    }
    ${
      state.hosts.length > 1
        ? `<div class="card"><label>Host
            <select id="hostSelect">
              ${state.hosts
                .map(
                  (h) =>
                    `<option value="${h.id}" ${h.id === host.id ? "selected" : ""}>${escapeHtml(h.name)}</option>`
                )
                .join("")}
            </select>
          </label></div>`
        : ""
    }
  `;
}

function bindHostPanel(host) {
  const jump = document.querySelector("[data-tab-jump]");
  if (jump) {
    jump.onclick = () => {
      state.tab = "setup";
      render();
    };
  }
  if (!host) return;

  const wakeBtn = document.getElementById("wakeBtn");
  const sleepBtn = document.getElementById("sleepBtn");
  const refreshBtn = document.getElementById("refreshBtn");
  if (wakeBtn) {
    wakeBtn.onclick = async () => {
      try {
        wakeBtn.disabled = true;
        await api(`/hosts/${host.id}/wake`, { method: "POST", body: {} });
        setFlash(true, "Wake packet sent — waiting for agent…");
        await refreshStatuses();
        render();
      } catch (err) {
        setFlash(false, err.message);
      }
    };
  }
  if (sleepBtn) {
    sleepBtn.onclick = async () => {
      try {
        sleepBtn.disabled = true;
        await api(`/hosts/${host.id}/sleep`, { method: "POST", body: { mode: "sleep" } });
        setFlash(true, "Sleep requested");
        setTimeout(async () => {
          await refreshStatuses();
          render();
        }, 2500);
      } catch (err) {
        setFlash(false, err.message);
      }
    };
  }
  if (refreshBtn) {
    refreshBtn.onclick = async () => {
      await refreshStatuses();
      state.message = "";
      state.error = "";
      render();
    };
  }

  const hostSelect = document.getElementById("hostSelect");
  if (hostSelect) {
    hostSelect.onchange = () => {
      state.selectedId = hostSelect.value;
      state.pin = "";
      render();
    };
  }

  const kind = document.getElementById("unlockKind");
  if (kind) {
    kind.onchange = () => {
      state.unlockKind = kind.value;
      state.pin = "";
      state.passwordDraft = "";
      render();
    };
  }

  const pad = document.getElementById("pinPad");
  if (pad) {
    pad.querySelectorAll("button").forEach((btn) => {
      btn.onclick = async () => {
        const key = btn.getAttribute("data-key");
        if (key === "⌫") state.pin = state.pin.slice(0, -1);
        else if (key === "OK") await doUnlock(host.id);
        else if (state.pin.length < 12) state.pin += key;
        // Update PIN dots without a full-page rebuild when possible
        const display = document.getElementById("pinDisplay");
        if (display && key !== "OK") {
          display.textContent = "•".repeat(state.pin.length) || "—";
        } else {
          render();
        }
      };
    });
  }

  const pwInput = document.getElementById("passwordUnlock");
  if (pwInput) {
    pwInput.addEventListener("input", () => {
      state.passwordDraft = pwInput.value;
      state.pin = pwInput.value;
      const display = document.getElementById("pinDisplay");
      if (display) display.textContent = pwInput.value ? "••••••" : "—";
    });
    pwInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        state.pin = pwInput.value;
        state.passwordDraft = pwInput.value;
        doUnlock(host.id);
      }
    });
  }

  const pwBtn = document.getElementById("passwordUnlockBtn");
  if (pwBtn) {
    pwBtn.onclick = async () => {
      const input = document.getElementById("passwordUnlock");
      state.pin = input?.value || state.passwordDraft || "";
      state.passwordDraft = state.pin;
      await doUnlock(host.id);
    };
  }
}

async function doUnlock(hostId) {
  if (!state.pin) {
    setFlash(false, "Enter a PIN or password first");
    return;
  }
  const secret = state.pin;
  state.pin = "";
  state.passwordDraft = "";
  try {
    const { result } = await api(`/hosts/${hostId}/unlock`, {
      method: "POST",
      body: { secret, kind: state.unlockKind },
    });
    if (result.ok) setFlash(true, result.message || "Unlocked");
    else setFlash(false, result.message || "Unlock failed");
    await refreshStatuses();
    render();
  } catch (err) {
    setFlash(false, err.message);
  }
}

function renderSetupPanel() {
  const hubUrl = `${location.protocol}//${location.host}`;
  return `
    <div class="card stack">
      <strong>Nearby PCs</strong>
      <div class="meta">Install the agent on a PC — it shows up here automatically. Tap Pair.</div>
      ${
        state.discovered.length === 0
          ? `<div class="meta">No unpaired agents seen yet. Make sure the agent is running on the same LAN.</div>`
          : state.discovered
              .map(
                (a) => `
            <div class="row" style="align-items:flex-start">
              <div>
                <div><strong>${escapeHtml(a.hostname)}</strong></div>
                <div class="meta">${escapeHtml(a.preferredMac || a.macs?.[0] || "MAC unknown")}</div>
                <div class="meta">${escapeHtml((a.addresses || []).join(", "))}</div>
              </div>
              <button data-pair-url="${escapeHtml(a.agentUrls?.[0] || "")}" data-pair-mac="${escapeHtml(a.preferredMac || "")}" data-pair-name="${escapeHtml(a.hostname)}">Pair</button>
            </div>`
              )
              .join("")
      }
      <button id="refreshDiscBtn" class="secondary">Refresh nearby</button>
    </div>
    <div class="card stack">
      <strong>Hosts</strong>
      ${
        state.hosts.length === 0
          ? `<div class="meta">None paired yet.</div>`
          : state.hosts
              .map(
                (h) => `
            <div class="stack" style="gap:8px;padding:8px 0;border-bottom:1px solid var(--line)">
              <div class="row">
                <div>
                  <div>${escapeHtml(h.name)} ${h.paired ? '<span class="badge on">paired</span>' : '<span class="badge">unpaired</span>'}</div>
                  <div class="meta">${escapeHtml(h.mac)} ${h.agentUrl ? "· " + escapeHtml(h.agentUrl) : ""}</div>
                </div>
                <div style="display:flex;gap:6px">
                  ${h.paired ? "" : `<button class="secondary" data-repair="${h.id}">Code</button>`}
                  <button class="danger" data-del="${h.id}">Delete</button>
                </div>
              </div>
            </div>`
              )
              .join("")
      }
    </div>
    <details class="card">
      <summary style="cursor:pointer;color:var(--muted)">Manual add (pairing code fallback)</summary>
      <div class="stack" style="margin-top:12px">
        <label>Name <input id="name" placeholder="Gaming PC" /></label>
        <label>MAC address <input id="mac" placeholder="AA:BB:CC:DD:EE:FF" /></label>
        <label>Broadcast (WoL) <input id="broadcast" value="255.255.255.255" /></label>
        <label>Apollo port <input id="apolloPort" type="number" value="47990" /></label>
        <button id="addHostBtn">Add PC &amp; get pairing code</button>
        ${
          state.pairing
            ? `<div class="ok">
                <div>Code: <code style="font-size:1.3rem">${escapeHtml(state.pairing.pairingCode)}</code></div>
                <div class="meta">Expires ${escapeHtml(state.pairing.expiresAt)}</div>
                <code style="display:block;white-space:pre-wrap;font-size:0.75rem;margin-top:8px">caretaker-agent pair --hub ${escapeHtml(hubUrl)} --code ${escapeHtml(state.pairing.pairingCode)} --agent-url http://&lt;PC_IP&gt;:7842</code>
              </div>`
            : ""
        }
      </div>
    </details>
  `;
}

function bindSetupPanel() {
  document.getElementById("refreshDiscBtn")?.addEventListener("click", async () => {
    await refreshDiscovered();
    render();
  });

  document.querySelectorAll("[data-pair-url]").forEach((btn) => {
    btn.onclick = async () => {
      const agentUrl = btn.getAttribute("data-pair-url");
      if (!agentUrl) return;
      try {
        btn.disabled = true;
        const data = await api("/discovered/pair", {
          method: "POST",
          body: {
            agentUrl,
            mac: btn.getAttribute("data-pair-mac") || undefined,
            name: btn.getAttribute("data-pair-name") || undefined,
          },
        });
        await refreshHosts();
        await refreshDiscovered();
        state.selectedId = data.host?.id || state.selectedId;
        state.tab = "home";
        setFlash(true, `Paired ${data.host?.name || "PC"}`);
      } catch (err) {
        setFlash(false, err.message);
      }
    };
  });

  const addHostBtn = document.getElementById("addHostBtn");
  if (addHostBtn) {
    addHostBtn.onclick = async () => {
      try {
        const data = await api("/hosts", {
          method: "POST",
          body: {
            name: document.getElementById("name").value || "Gaming PC",
            mac: document.getElementById("mac").value,
            broadcastAddress: document.getElementById("broadcast").value,
            apolloPort: Number(document.getElementById("apolloPort").value || 47990),
          },
        });
        await refreshHosts();
        state.selectedId = data.host?.id || state.selectedId;
        state.pairing = {
          pairingCode: data.pairingCode,
          expiresAt: data.expiresAt,
          hostName: data.host?.name,
          hostId: data.host?.id,
        };
        setFlash(true, `PC added — use pairing code ${data.pairingCode} on the agent`);
      } catch (err) {
        setFlash(false, err.message);
      }
    };
  }

  document.querySelectorAll("[data-repair]").forEach((btn) => {
    btn.onclick = async () => {
      try {
        const id = btn.getAttribute("data-repair");
        const data = await api(`/hosts/${id}/pair`, { method: "POST", body: {} });
        state.pairing = {
          pairingCode: data.pairingCode,
          expiresAt: data.expiresAt,
          hostName: data.host?.name,
          hostId: data.host?.id,
        };
        await refreshHosts();
        setFlash(true, `New pairing code: ${data.pairingCode}`);
      } catch (err) {
        setFlash(false, err.message);
      }
    };
  });

  document.querySelectorAll("[data-del]").forEach((btn) => {
    btn.onclick = async () => {
      try {
        await api(`/hosts/${btn.getAttribute("data-del")}`, { method: "DELETE" });
        await refreshHosts();
        render();
      } catch (err) {
        setFlash(false, err.message);
      }
    };
  });
}

function render() {
  if (!state.authenticated) renderLogin();
  else renderHome();
}

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function relTime(iso) {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  if (ms < 5000) return "just now";
  if (ms < 60000) return `${Math.round(ms / 1000)}s ago`;
  return `${Math.round(ms / 60000)}m ago`;
}

(async function init() {
  try {
    await refreshAuth();
    if (state.authenticated) {
      await refreshHosts();
      startPolling();
    }
  } catch {
    state.authenticated = false;
  }
  render();
})();
