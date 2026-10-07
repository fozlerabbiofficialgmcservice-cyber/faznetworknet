(() => {
  const clock = document.getElementById("current-time");
  const statusBadge = document.getElementById("router-status");
  const interfaceSelect = document.getElementById("interface-select");
  const chartCanvas = document.getElementById("traffic-chart");
  const cpuValue = document.getElementById("cpu-value");
  const cpuBar = document.getElementById("cpu-bar");
  const memoryValue = document.getElementById("memory-value");
  const memoryBar = document.getElementById("memory-bar");
  const uptimeValue = document.getElementById("uptime-value");
  const testButton = document.getElementById("test-router-btn");
  const testResult = document.getElementById("router-test-result");

  const updateClock = () => {
    if (clock) {
      clock.textContent = new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short"
      }).format(new Date());
    }
  };
  updateClock();
  setInterval(updateClock, 1000);

  const setStatus = (connected) => {
    if (!statusBadge) return;
    statusBadge.textContent = connected ? "Connected" : "Disconnected";
    statusBadge.className = connected
      ? "inline-flex items-center gap-2 rounded-full bg-emerald-50 text-emerald-700 px-3 py-1.5 text-xs font-bold"
      : "inline-flex items-center gap-2 rounded-full bg-red-50 text-red-700 px-3 py-1.5 text-xs font-bold";
    statusBadge.insertAdjacentHTML("afterbegin", '<span class="h-2 w-2 rounded-full ' + (connected ? "bg-emerald-500" : "bg-red-500") + '"></span>');
  };

  const setGauge = (valueElement, barElement, value, suffix = "%") => {
    const numeric = Number.isFinite(Number(value)) ? Number(value) : 0;
    if (valueElement) valueElement.textContent = numeric.toFixed(1) + suffix;
    if (barElement) barElement.style.width = Math.max(0, Math.min(100, numeric)) + "%";
  };

  let chart;
  if (chartCanvas && window.Chart) {
    chart = new Chart(chartCanvas, {
      type: "line",
      data: {
        labels: [],
        datasets: [
          { label: "Download (RX)", data: [], borderWidth: 2, tension: 0.35, pointRadius: 0 },
          { label: "Upload (TX)", data: [], borderWidth: 2, tension: 0.35, pointRadius: 0 }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        interaction: { mode: "index", intersect: false },
        scales: {
          x: { display: true, ticks: { maxTicksLimit: 8 } },
          y: { beginAtZero: true, title: { display: true, text: "Mbps" } }
        }
      }
    });
  }

  const apiJson = async (url) => {
    const response = await fetch(url, { headers: { Accept: "application/json" }, cache: "no-store" });
    let data;
    try { data = await response.json(); } catch (_) { throw new Error("Invalid server response."); }
    if (!response.ok || data.success === false) throw new Error(data.error || "Router request failed.");
    return data;
  };

  const loadInterfaces = async () => {
    if (!interfaceSelect) return;
    try {
      const data = await apiJson("/api/router/interfaces");
      const current = interfaceSelect.value;
      interfaceSelect.innerHTML = '<option value="">Select an interface</option>';
      data.interfaces.forEach((item) => {
        const option = document.createElement("option");
        option.value = item.name;
        option.textContent = item.name + " (" + item.type + (item.running ? ", running" : "") + ")";
        interfaceSelect.appendChild(option);
      });
      if (current && [...interfaceSelect.options].some((option) => option.value === current)) {
        interfaceSelect.value = current;
      } else if (data.interfaces.length) {
        interfaceSelect.value = data.interfaces.find((item) => item.running && !item.disabled)?.name || data.interfaces[0].name;
      }
    } catch (_) {
      setStatus(false);
    }
  };

  const loadResources = async () => {
    try {
      const data = await apiJson("/api/router/resources");
      const r = data.resources;
      setGauge(cpuValue, cpuBar, r.cpuLoad);
      setGauge(memoryValue, memoryBar, r.memoryUsagePercent);
      if (uptimeValue) uptimeValue.textContent = r.uptime || "unknown";
      setStatus(true);
    } catch (_) {
      setStatus(false);
    }
  };

  const loadTraffic = async () => {
    if (!chart || !interfaceSelect || !interfaceSelect.value) return;
    try {
      const data = await apiJson("/api/router/traffic?interface=" + encodeURIComponent(interfaceSelect.value));
      const t = data.traffic;
      const now = new Date().toLocaleTimeString([], { minute: "2-digit", second: "2-digit" });
      chart.data.labels.push(now);
      chart.data.datasets[0].data.push(t.rxMbps);
      chart.data.datasets[1].data.push(t.txMbps);
      const maxPoints = 30;
      if (chart.data.labels.length > maxPoints) {
        chart.data.labels.shift();
        chart.data.datasets.forEach((dataset) => dataset.data.shift());
      }
      chart.update("none");
      setStatus(true);
    } catch (_) {
      setStatus(false);
    }
  };

  if (interfaceSelect) {
    interfaceSelect.addEventListener("change", () => {
      if (!chart) return;
      chart.data.labels = [];
      chart.data.datasets.forEach((dataset) => { dataset.data = []; });
      chart.update("none");
      loadTraffic();
    });
  }

  if (testButton) {
    testButton.addEventListener("click", async () => {
      testButton.disabled = true;
      testButton.textContent = "Testing...";
      if (testResult) {
        testResult.textContent = "Connecting to MikroTik...";
        testResult.className = "text-sm text-slate-500";
      }
      try {
        const data = await apiJson("/api/router/test");
        if (testResult) {
          testResult.textContent = "Connected to " + data.routerName + " (RouterOS " + data.version + ")";
          testResult.className = "text-sm font-semibold text-emerald-600";
        }
      } catch (error) {
        if (testResult) {
          testResult.textContent = error.message;
          testResult.className = "text-sm font-semibold text-red-600";
        }
      } finally {
        testButton.disabled = false;
        testButton.textContent = "Test Connection";
      }
    });
  }

  const isDashboard = Boolean(interfaceSelect || chartCanvas);
  if (isDashboard) {
    loadInterfaces();
    loadResources();
    loadTraffic();
    setInterval(loadResources, 2500);
    setInterval(loadTraffic, 2500);
  }
})();


(() => {
  const syncBtn = document.getElementById("pppoe-sync-btn");
  const syncResult = document.getElementById("pppoe-sync-result");
  const usersBody = document.getElementById("pppoe-users-body");
  const activeBody = document.getElementById("pppoe-active-body");
  const profilesBody = document.getElementById("pppoe-profiles-body");
  const userCount = document.getElementById("pppoe-user-count");
  const profileCount = document.getElementById("pppoe-profile-count");
  const onlineCount = document.getElementById("pppoe-online-count");
  const userModal = document.getElementById("pppoe-user-modal");
  const profileModal = document.getElementById("pppoe-profile-modal");
  const userForm = document.getElementById("pppoe-user-form");
  const profileForm = document.getElementById("pppoe-profile-form");
  const userProfile = document.getElementById("user-profile");
  const editingInput = document.getElementById("user-editing");
  const userModalTitle = document.getElementById("user-modal-title");
  let users = [];
  let profiles = [];
  let activeSessions = [];

  if (!syncBtn && !usersBody) return;

  const pppoeApi = async (url, options = {}) => {
    const response = await fetch(url, {
      ...options,
      headers: { Accept: "application/json", "Content-Type": "application/json", ...(options.headers || {}) },
      cache: "no-store"
    });
    let data;
    try { data = await response.json(); } catch (_) { throw new Error("Invalid server response."); }
    if (!response.ok || data.success === false) throw new Error(data.error || "PPPoE request failed.");
    return data;
  };

  const esc = (value) => {
    const div = document.createElement("div");
    div.textContent = value == null ? "" : String(value);
    return div.innerHTML;
  };

  const showResult = (message, ok = true) => {
    if (!syncResult) return;
    syncResult.className = "rounded-xl px-4 py-3 text-sm font-semibold " + (ok ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-700");
    syncResult.textContent = message;
    syncResult.classList.remove("hidden");
  };

  const openModal = (modal) => modal && modal.classList.remove("hidden");
  const closeModal = (modal) => modal && modal.classList.add("hidden");

  const loadProfiles = async () => {
    const data = await pppoeApi("/api/pppoe/profiles");
    profiles = data.profiles || [];
    if (profileCount) profileCount.textContent = profiles.length;
    if (profilesBody) {
      profilesBody.innerHTML = profiles.length ? profiles.map((p) =>
        "<tr><td class='font-bold'>" + esc(p.name) + "</td><td>" + esc(p.rate_limit || "—") +
        "</td><td>" + esc(p.local_address || "—") + "</td><td>" + esc(p.remote_address || "—") +
        "</td><td>" + esc(p.session_timeout || "—") + "</td><td>" + esc(p.comment || "—") + "</td></tr>"
      ).join("") : "<tr><td colspan='6' class='empty-cell'>No PPPoE profiles found.</td></tr>";
    }
    if (userProfile) {
      const current = userProfile.value;
      userProfile.innerHTML = "<option value=''>Select profile...</option>" + profiles.map((p) =>
        "<option value='" + esc(p.name) + "'>" + esc(p.name) + (p.rate_limit ? " — " + esc(p.rate_limit) : "") + "</option>"
      ).join("");
      if (current) userProfile.value = current;
    }
  };

  const loadUsers = async () => {
    const data = await pppoeApi("/api/pppoe/users");
    users = data.users || [];
    if (userCount) userCount.textContent = users.length;
    renderUsers();
  };

  const renderUsers = () => {
    if (!usersBody) return;
    const online = new Set(activeSessions.map((s) => s.username));
    usersBody.innerHTML = users.length ? users.map((u) => {
      const isOnline = online.has(u.username);
      const status = u.disabled
        ? "<span class='status-badge status-disabled'>Disabled</span>"
        : "<span class='status-badge status-active'>Active</span>";
      const onlineBadge = isOnline ? " <span class='status-badge status-online'>Online</span>" : "";
      const toggleLabel = u.disabled ? "Enable" : "Disable";
      return "<tr>" +
        "<td class='font-bold whitespace-nowrap'>" + esc(u.username) + onlineBadge + "</td>" +
        "<td>" + esc(u.profile || "—") + "</td>" +
        "<td>" + status + "</td>" +
        "<td>" + esc(u.phone || "—") + "</td>" +
        "<td class='max-w-xs truncate' title='" + esc(u.comment || "") + "'>" + esc(u.comment || "—") + "</td>" +
        "<td><div class='flex justify-end gap-2'>" +
        "<button class='table-action' data-action='toggle' data-username='" + esc(u.username) + "' data-disabled='" + (!u.disabled) + "'>" + toggleLabel + "</button>" +
        "<button class='table-action' data-action='kick' data-username='" + esc(u.username) + "'>Kick</button>" +
        "<button class='table-action' data-action='edit' data-username='" + esc(u.username) + "'>Edit</button>" +
        "</div></td></tr>";
    }).join("") : "<tr><td colspan='6' class='empty-cell'>No PPPoE users in database. Click Sync from MikroTik.</td></tr>";
  };

  const loadActive = async () => {
    const data = await pppoeApi("/api/pppoe/active");
    activeSessions = data.sessions || [];
    if (onlineCount) onlineCount.textContent = activeSessions.length;
    if (activeBody) {
      activeBody.innerHTML = activeSessions.length ? activeSessions.map((s) =>
        "<tr><td class='font-bold'>" + esc(s.username) + "</td><td>" + esc(s.address || "—") +
        "</td><td>" + esc(s.uptime || "—") + "</td><td>" + esc(s.callerId || "—") +
        "</td><td>" + esc(s.sessionId || "—") + "</td><td class='text-right'><button class='table-action' data-active-kick='" + esc(s.username) + "'>Kick</button></td></tr>"
      ).join("") : "<tr><td colspan='6' class='empty-cell'>No active PPPoE sessions.</td></tr>";
    }
    renderUsers();
  };

  const sync = async (silent = false) => {
    if (syncBtn) { syncBtn.disabled = true; syncBtn.textContent = "⏳ Syncing..."; }
    try {
      const data = await pppoeApi("/api/pppoe/sync", { method: "POST", body: "{}" });
      await Promise.all([loadProfiles(), loadUsers(), loadActive()]);
      if (!silent) showResult("✓ " + data.message, true);
      return data;
    } catch (error) {
      if (!silent) showResult(error.message, false);
      throw error;
    } finally {
      if (syncBtn) { syncBtn.disabled = false; syncBtn.textContent = "🔄 Sync from MikroTik"; }
    }
  };

  const resetUserForm = () => {
    if (!userForm) return;
    userForm.reset();
    editingInput.value = "";
    document.getElementById("user-username").disabled = false;
    document.getElementById("user-modal-title").textContent = "Add New PPPoE User";
    document.getElementById("user-form-result").classList.add("hidden");
  };

  const editUser = (username) => {
    const u = users.find((item) => item.username === username);
    if (!u) return;
    editingInput.value = u.username;
    document.getElementById("user-username").value = u.username;
    document.getElementById("user-username").disabled = true;
    document.getElementById("user-password").value = "";
    document.getElementById("user-profile").value = u.profile || "";
    document.getElementById("user-caller-id").value = u.caller_id || "";
    document.getElementById("user-comment").value = u.comment || "";
    document.getElementById("user-disabled").checked = Boolean(u.disabled);
    userModalTitle.textContent = "Edit PPPoE User";
    openModal(userModal);
  };

  if (syncBtn) syncBtn.addEventListener("click", () => sync(false).catch(() => {}));
  document.getElementById("add-user-btn")?.addEventListener("click", () => { resetUserForm(); openModal(userModal); });
  document.getElementById("add-profile-btn")?.addEventListener("click", () => { profileForm?.reset(); openModal(profileModal); });

  document.querySelectorAll(".modal-close").forEach((button) => {
    button.addEventListener("click", () => closeModal(document.getElementById(button.dataset.modal)));
  });
  [userModal, profileModal].forEach((modal) => modal?.addEventListener("click", (event) => { if (event.target === modal) closeModal(modal); }));

  document.querySelectorAll(".pppoe-tab").forEach((tab) => tab.addEventListener("click", async () => {
    document.querySelectorAll(".pppoe-tab").forEach((item) => item.classList.remove("active"));
    document.querySelectorAll(".pppoe-panel").forEach((panel) => panel.classList.add("hidden"));
    tab.classList.add("active");
    document.getElementById("pppoe-panel-" + tab.dataset.tab)?.classList.remove("hidden");
    if (tab.dataset.tab === "active") await loadActive().catch((e) => showResult(e.message, false));
    if (tab.dataset.tab === "profiles") await loadProfiles().catch((e) => showResult(e.message, false));
  }));

  usersBody?.addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-action]");
    if (!button) return;
    const username = button.dataset.username;
    try {
      if (button.dataset.action === "edit") return editUser(username);
      if (button.dataset.action === "toggle") {
        await pppoeApi("/api/pppoe/toggle-user", { method: "POST", body: JSON.stringify({ username, disabled: button.dataset.disabled === "true" }) });
        await Promise.all([loadUsers(), loadActive()]);
        showResult("✓ " + username + " status updated.", true);
      }
      if (button.dataset.action === "kick") {
        if (!window.confirm("Kick " + username + " from the active PPPoE session?")) return;
        const data = await pppoeApi("/api/pppoe/kick-user", { method: "POST", body: JSON.stringify({ username }) });
        await loadActive();
        showResult("✓ " + (data.kicked ? username + " disconnected." : username + " is not online."), true);
      }
    } catch (error) { showResult(error.message, false); }
  });

  activeBody?.addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-active-kick]");
    if (!button) return;
    const username = button.dataset.activeKick;
    if (!window.confirm("Kick " + username + " now?")) return;
    try {
      const data = await pppoeApi("/api/pppoe/kick-user", { method: "POST", body: JSON.stringify({ username }) });
      await loadActive();
      showResult("✓ " + (data.kicked ? username + " disconnected." : username + " is no longer online."), true);
    } catch (error) { showResult(error.message, false); }
  });

  userForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const editing = editingInput.value;
    const password = document.getElementById("user-password").value;
    if (!editing && !password) return showResult("Password is required for a new user.", false);
    const resultBox = document.getElementById("user-form-result");
    resultBox.className = "md:col-span-2 text-sm font-semibold text-slate-500";
    resultBox.textContent = "Saving to MikroTik...";
    resultBox.classList.remove("hidden");
    const payload = {
      username: editing || document.getElementById("user-username").value.trim(),
      password,
      profile: userProfile.value,
      callerId: document.getElementById("user-caller-id").value.trim(),
      comment: document.getElementById("user-comment").value.trim(),
      disabled: document.getElementById("user-disabled").checked
    };
    try {
      const url = editing ? "/api/pppoe/update-user" : "/api/pppoe/create-user";
      await pppoeApi(url, { method: "POST", body: JSON.stringify(payload) });
      closeModal(userModal);
      await Promise.all([loadProfiles(), loadUsers(), loadActive()]);
      showResult("✓ PPPoE user " + (editing ? "updated" : "created") + " and synchronized.", true);
    } catch (error) {
      resultBox.className = "md:col-span-2 text-sm font-semibold text-red-600";
      resultBox.textContent = error.message;
    }
  });

  profileForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const resultBox = document.getElementById("profile-form-result");
    resultBox.className = "md:col-span-2 text-sm font-semibold text-slate-500";
    resultBox.textContent = "Creating on MikroTik...";
    resultBox.classList.remove("hidden");
    const payload = {
      name: document.getElementById("profile-name").value.trim(),
      rateLimit: document.getElementById("profile-rate-limit").value.trim(),
      localAddress: document.getElementById("profile-local-address").value.trim(),
      remoteAddress: document.getElementById("profile-remote-address").value.trim(),
      sessionTimeout: document.getElementById("profile-session-timeout").value.trim(),
      idleTimeout: document.getElementById("profile-idle-timeout").value.trim(),
      comment: document.getElementById("profile-comment").value.trim(),
      onlyOne: document.getElementById("profile-only-one").checked,
      changeTcpMss: document.getElementById("profile-change-mss").checked
    };
    try {
      await pppoeApi("/api/pppoe/create-profile", { method: "POST", body: JSON.stringify(payload) });
      closeModal(profileModal);
      await Promise.all([loadProfiles(), loadUsers()]);
      showResult("✓ Profile created on MikroTik and synchronized.", true);
    } catch (error) {
      resultBox.className = "md:col-span-2 text-sm font-semibold text-red-600";
      resultBox.textContent = error.message;
    }
  });

  sync(true).catch((error) => {
    showResult("Initial MikroTik sync failed: " + error.message, false);
    Promise.allSettled([loadProfiles(), loadUsers(), loadActive()]);
  });
  setInterval(() => loadActive().catch(() => {}), 5000);
})();
