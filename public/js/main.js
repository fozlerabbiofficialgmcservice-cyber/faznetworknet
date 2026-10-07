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
