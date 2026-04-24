const state = {
  session: null,
  dashboard: null,
  currentSeller: null,
  noteSaveTimers: {},
  noteStatusMap: {},
  filters: {
    search: "",
    status: "todos",
    progress: "todos",
  },
};

const elements = {
  loginPanel: document.querySelector("#loginPanel"),
  loginForm: document.querySelector("#loginForm"),
  loginMessage: document.querySelector("#loginMessage"),
  sessionPanel: document.querySelector("#sessionPanel"),
  sessionInfo: document.querySelector("#sessionInfo"),
  baseDateLabel: document.querySelector("#baseDateLabel"),
  logoutButton: document.querySelector("#logoutButton"),
  filtersPanel: document.querySelector("#filtersPanel"),
  sellerSelect: document.querySelector("#sellerSelect"),
  searchInput: document.querySelector("#searchInput"),
  statusFilter: document.querySelector("#statusFilter"),
  progressFilter: document.querySelector("#progressFilter"),
  financePanel: document.querySelector("#financePanel"),
  uploadForm: document.querySelector("#uploadForm"),
  pdfInput: document.querySelector("#pdfInput"),
  uploadMessage: document.querySelector("#uploadMessage"),
  welcomeTitle: document.querySelector("#welcomeTitle"),
  welcomeText: document.querySelector("#welcomeText"),
  summaryCards: document.querySelector("#summaryCards"),
  clientList: document.querySelector("#clientList"),
  exportButton: document.querySelector("#exportButton"),
  template: document.querySelector("#clientCardTemplate"),
};

async function bootstrap() {
  attachEvents();
  await restoreSession();
}

function attachEvents() {
  elements.loginForm.addEventListener("submit", handleLogin);
  elements.logoutButton.addEventListener("click", handleLogout);
  elements.searchInput.addEventListener("input", (event) => {
    state.filters.search = event.target.value.toLowerCase().trim();
    render();
  });
  elements.statusFilter.addEventListener("change", (event) => {
    state.filters.status = event.target.value;
    render();
  });
  elements.progressFilter.addEventListener("change", (event) => {
    state.filters.progress = event.target.value;
    render();
  });
  elements.sellerSelect.addEventListener("change", (event) => {
    state.currentSeller = event.target.value;
    render();
  });
  elements.exportButton.addEventListener("click", exportCollectionView);
  elements.uploadForm.addEventListener("submit", handleUpload);
}

async function restoreSession() {
  try {
    const response = await fetch("/api/session");
    if (!response.ok) {
      throw new Error("Sem sessao ativa");
    }
    const payload = await response.json();
    state.session = payload.user;
    await loadDashboard();
  } catch {
    renderLoggedOut();
  }
}

async function handleLogin(event) {
  event.preventDefault();
  const form = new FormData(elements.loginForm);
  elements.loginMessage.textContent = "Validando acesso...";

  try {
    const response = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: form.get("username"),
        password: form.get("password"),
      }),
    });

    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || "Nao foi possivel entrar");
    }

    state.session = payload.user;
    elements.loginForm.reset();
    elements.loginMessage.textContent = "";
    await loadDashboard();
  } catch (error) {
    elements.loginMessage.textContent = error.message;
  }
}

async function handleLogout() {
  await fetch("/api/logout", { method: "POST" });
  state.session = null;
  state.dashboard = null;
  state.currentSeller = null;
  renderLoggedOut();
}

async function loadDashboard() {
  const response = await fetch("/api/dashboard");
  if (!response.ok) {
    renderLoggedOut();
    return;
  }
  state.dashboard = await response.json();
  const firstSeller = state.session?.role === "financeiro"
    ? "todos"
    : state.dashboard.vendedores[0]?.vendedor || null;
  state.currentSeller = state.currentSeller && state.dashboard.vendedores.some((item) => item.vendedor === state.currentSeller)
    ? state.currentSeller
    : firstSeller;
  renderLoggedIn();
  render();
}

function renderLoggedOut() {
  elements.loginPanel.classList.remove("hidden");
  elements.sessionPanel.classList.add("hidden");
  elements.filtersPanel.classList.add("hidden");
  elements.financePanel.classList.add("hidden");
  elements.exportButton.classList.add("hidden");
  elements.summaryCards.innerHTML = "";
  elements.clientList.innerHTML = "";
  elements.welcomeTitle.textContent = "Entre para carregar a carteira";
  elements.welcomeText.textContent = "O painel mostra resumo por vendedor, clientes, titulos e andamento da cobranca.";
}

function renderLoggedIn() {
  const isFinance = state.session?.role === "financeiro";
  elements.loginPanel.classList.add("hidden");
  elements.sessionPanel.classList.remove("hidden");
  elements.filtersPanel.classList.remove("hidden");
  elements.financePanel.classList.toggle("hidden", !isFinance);
  elements.exportButton.classList.remove("hidden");
  elements.sessionInfo.textContent = `${state.session.nome} | ${labelRole(state.session.role)}`;

  populateSellerSelect();
  const hideSellerSelect = !isFinance && state.dashboard.vendedores.length <= 1;
  elements.sellerSelect.closest(".field").classList.toggle("hidden", hideSellerSelect);
}

function populateSellerSelect() {
  const sellers = state.dashboard.vendedores.map((item) => item.vendedor);
  const options = state.session?.role === "financeiro"
    ? ["todos", ...sellers]
    : sellers;

  elements.sellerSelect.innerHTML = options
    .map((seller) => `<option value="${seller}">${seller === "todos" ? "Todos" : seller}</option>`)
    .join("");
  if (state.currentSeller) {
    elements.sellerSelect.value = state.currentSeller;
  }
}

function render() {
  if (!state.dashboard || !state.currentSeller) {
    return;
  }

  const sellerData = state.currentSeller === "todos"
    ? buildCombinedSellerData()
    : state.dashboard.vendedores.find((item) => item.vendedor === state.currentSeller);
  if (!sellerData) {
    return;
  }

  elements.baseDateLabel.textContent = `Base do relatorio: ${sellerData.data_base || "-"}`;
  elements.welcomeTitle.textContent = `Painel de cobranca | ${sellerData.vendedor}`;
  elements.welcomeText.textContent = `${sellerData.resumo.clientes} clientes, ${sellerData.resumo.titulos} titulos e ${formatCurrency(sellerData.resumo.valor_total)} em carteira.`;

  renderSummaryCards(sellerData);
  renderClientList(filterClients(sellerData.clientes));
}

function renderSummaryCards(sellerData) {
  const cards = [
    { label: "Clientes", value: sellerData.resumo.clientes },
    { label: "Titulos", value: sellerData.resumo.titulos },
    { label: "Vencidos", value: formatCurrency(sellerData.resumo.vencidos) },
    { label: "A vencer", value: formatCurrency(sellerData.resumo.a_vencer) },
  ];

  elements.summaryCards.innerHTML = cards
    .map(
      (card) => `
        <article class="summary-card card">
          <span class="muted">${card.label}</span>
          <strong>${card.value}</strong>
        </article>
      `
    )
    .join("");
}

function filterClients(clients) {
  return clients.filter((client) => {
    const searchOk =
      !state.filters.search ||
      client.nome.toLowerCase().includes(state.filters.search) ||
      String(client.codigo).includes(state.filters.search);

    const progressOk = state.filters.progress === "todos" || (client.progresso?.status || "pendente") === state.filters.progress;

    let statusOk = true;
    if (state.filters.status === "vencidos") {
      statusOk = client.total_vencidos > 0;
    } else if (state.filters.status === "a_vencer") {
      statusOk = client.total_vencidos === 0 && client.total_a_vencer > 0;
    } else if (state.filters.status === "alta") {
      statusOk = client.status_prioridade === "alta";
    }

    return searchOk && progressOk && statusOk;
  });
}

function renderClientList(clients) {
  elements.clientList.innerHTML = "";

  if (!clients.length) {
    elements.clientList.innerHTML = `<div class="empty-state card">Nenhum cliente encontrado com os filtros atuais.</div>`;
    return;
  }

  const fragment = document.createDocumentFragment();

  clients.forEach((client) => {
    const node = elements.template.content.firstElementChild.cloneNode(true);
    const progress = client.progresso || { status: "pendente", note: "" };

    node.querySelector(".client-name").textContent = `${client.codigo} - ${client.nome}`;
    node.querySelector(".client-meta").textContent = `${client.condicao_pagamento} | Cliente ${client.ativo ? "ativo" : "inativo"}`;

    const priority = node.querySelector(".priority-pill");
    priority.textContent = priorityLabel(client.status_prioridade);
    priority.className = `priority-pill priority-${client.status_prioridade}`;

    const progressSelect = node.querySelector(".progress-select");
    progressSelect.value = progress.status;
    progressSelect.addEventListener("change", async (event) => {
      await saveProgress(client.codigo, {
        status: event.target.value,
        note: node.querySelector("textarea").value.trim(),
        vendedor: client.vendedor || state.currentSeller,
      });
    });

    const noteArea = node.querySelector("textarea");
    const noteStatus = node.querySelector(".note-status");
    noteArea.value = progress.note || "";
    applyNoteStatus(noteStatus, getNoteStatus(client));
    noteArea.addEventListener("input", (event) => {
      queueNoteSave(client, node, event.target.value);
      applyNoteStatus(noteStatus, "saving");
    });
    noteArea.addEventListener("blur", async (event) => {
      await flushNoteSave(client, node, event.target.value);
      applyNoteStatus(noteStatus, getNoteStatus(client));
    });

    node.querySelector(".copy-button").addEventListener("click", async () => {
      const text = buildCollectionMessage(client);
      const button = node.querySelector(".copy-button");
      const copied = await copyText(text);
      if (copied) {
        button.textContent = "Copiado";
      } else {
        downloadTextFile(`cobranca-${slugify(client.nome || String(client.codigo))}.txt`, text);
        button.textContent = "Baixado";
      }
      setTimeout(() => {
        button.textContent = "Copiar cobranca";
      }, 1800);
    });

    node.querySelector(".totals-row").innerHTML = [
      metricPill(`Vencidos: ${formatCurrency(client.total_vencidos)}`),
      metricPill(`A vencer: ${formatCurrency(client.total_a_vencer)}`),
      metricPill(`Total: ${formatCurrency(client.total_geral)}`),
      metricPill(`Titulos: ${client.qtde_titulos}`),
      metricPill(`Maior atraso: ${client.maior_atraso_dias} dias`),
      metricPill(`Andamento: ${labelProgress(progress.status)}`),
    ].join("");

    node.querySelector("tbody").innerHTML = client.titulos
      .map(
        (title) => `
          <tr>
            <td><span class="chip-${title.categoria}">${title.categoria === "vencidos" ? "Vencido" : "A vencer"}</span></td>
            <td>${title.tipo}</td>
            <td>${formatCurrency(title.valor)}</td>
            <td>${title.data_vencimento || "-"}</td>
            <td>${title.categoria === "vencidos" ? `${title.dias_diferenca ?? 0} dias` : "-"}</td>
            <td>${title.titulo || "-"}</td>
            <td>${title.numero_boleto || "-"}</td>
          </tr>
        `
      )
      .join("");

    fragment.appendChild(node);
  });

  elements.clientList.appendChild(fragment);
}

async function saveProgress(clientCode, payload) {
  try {
    const response = await fetch(`/api/progress/${clientCode}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      return false;
    }
    await loadDashboard();
    return true;
  } catch {
    return false;
  }
}

function queueNoteSave(client, node, noteValue) {
  const timerKey = buildClientTimerKey(client);
  clearTimeout(state.noteSaveTimers[timerKey]);
  state.noteSaveTimers[timerKey] = setTimeout(() => {
    flushNoteSave(client, node, noteValue);
  }, 700);
}

async function flushNoteSave(client, node, noteValue) {
  const timerKey = buildClientTimerKey(client);
  clearTimeout(state.noteSaveTimers[timerKey]);
  delete state.noteSaveTimers[timerKey];
  setNoteStatus(client, "saving");
  const saved = await saveProgress(client.codigo, {
    status: node.querySelector(".progress-select").value,
    note: String(noteValue || "").trim(),
    vendedor: client.vendedor || state.currentSeller,
  });
  setNoteStatus(client, saved ? "saved" : "error");
  const noteStatus = node.querySelector(".note-status");
  if (noteStatus) {
    applyNoteStatus(noteStatus, getNoteStatus(client));
  }
}

function buildClientTimerKey(client) {
  return `${client.vendedor || state.currentSeller || ""}:${client.codigo}`;
}

function setNoteStatus(client, status) {
  state.noteStatusMap[buildClientTimerKey(client)] = status;
}

function getNoteStatus(client) {
  return state.noteStatusMap[buildClientTimerKey(client)] || "idle";
}

function applyNoteStatus(element, status) {
  if (!element) {
    return;
  }

  element.classList.remove("is-saving", "is-saved", "is-error");
  if (status === "saving") {
    element.textContent = "Salvando...";
    element.classList.add("is-saving");
    return;
  }
  if (status === "saved") {
    element.textContent = "Salvo";
    element.classList.add("is-saved");
    return;
  }
  if (status === "error") {
    element.textContent = "Nao foi possivel salvar";
    element.classList.add("is-error");
    return;
  }
  element.textContent = "Sem alteracoes";
}

async function handleUpload(event) {
  event.preventDefault();
  const files = Array.from(elements.pdfInput.files || []);
  if (!files.length) {
    elements.uploadMessage.textContent = "Selecione os PDFs do dia para atualizar.";
    return;
  }

  elements.uploadMessage.textContent = "Processando PDFs e substituindo a base anterior...";
  try {
    const payload = {
      files: await Promise.all(
        files.map(async (file) => ({
          name: file.name,
          contentBase64: await toBase64(file),
        }))
      ),
    };

    const response = await fetch("/api/admin/upload-data", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const result = await response.json();
    if (!response.ok) {
      throw new Error(result.error || "Falha ao atualizar a base");
    }

    elements.pdfInput.value = "";
    elements.uploadMessage.textContent = result.message;
    await loadDashboard();
  } catch (error) {
    elements.uploadMessage.textContent = error.message;
  }
}

function buildCollectionMessage(client) {
  const vencidos = client.titulos.filter((item) => item.categoria === "vencidos");
  const aVencer = client.titulos.filter((item) => item.categoria === "a_vencer");
  const progress = client.progresso || { status: "pendente", note: "" };

  return [
    `Cliente: ${client.codigo} - ${client.nome}`,
    `Condicao: ${client.condicao_pagamento}`,
    `Status da cobranca: ${labelProgress(progress.status)}`,
    `Total vencido: ${formatCurrency(client.total_vencidos)}`,
    `Total a vencer: ${formatCurrency(client.total_a_vencer)}`,
    "",
    "Titulos vencidos:",
    vencidos.length
      ? vencidos.map((item) => `- ${item.tipo} ${item.titulo || "-"} | ${formatCurrency(item.valor)} | venc. ${item.data_vencimento}`).join("\n")
      : "- Sem titulos vencidos",
    "",
    "Proximos titulos:",
    aVencer.length
      ? aVencer.slice(0, 5).map((item) => `- ${item.tipo} ${item.titulo || "-"} | ${formatCurrency(item.valor)} | venc. ${item.data_vencimento}`).join("\n")
      : "- Sem titulos a vencer",
    "",
    `Observacao: ${progress.note || "Sem anotacao registrada."}`,
  ].join("\n");
}

function exportCollectionView() {
  const sellerData = state.currentSeller === "todos"
    ? buildCombinedSellerData()
    : state.dashboard.vendedores.find((item) => item.vendedor === state.currentSeller);
  const lines = filterClients(sellerData.clientes).map((client) => buildCollectionMessage(client));
  const blob = new Blob([lines.join("\n\n====================\n\n")], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `cobranca-${slugify(state.currentSeller)}.txt`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function buildCombinedSellerData() {
  const vendedores = state.dashboard.vendedores || [];
  const clientes = vendedores.flatMap((item) =>
    item.clientes.map((cliente) => ({
      ...cliente,
      vendedor: item.vendedor,
    }))
  );

  const dataBase = vendedores
    .map((item) => item.data_base)
    .filter(Boolean)
    .sort()
    .at(-1) || "-";

  return {
    vendedor: "Todos",
    data_base: dataBase,
    clientes: clientes.sort((a, b) => {
      if (b.total_vencidos !== a.total_vencidos) {
        return b.total_vencidos - a.total_vencidos;
      }
      return a.nome.localeCompare(b.nome, "pt-BR");
    }),
    resumo: vendedores.reduce(
      (acc, item) => {
        acc.clientes += Number(item.resumo.clientes || 0);
        acc.titulos += Number(item.resumo.titulos || 0);
        acc.valor_total += Number(item.resumo.valor_total || 0);
        acc.vencidos += Number(item.resumo.vencidos || 0);
        acc.a_vencer += Number(item.resumo.a_vencer || 0);
        return acc;
      },
      { clientes: 0, titulos: 0, valor_total: 0, vencidos: 0, a_vencer: 0 }
    ),
  };
}

async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // fallback abaixo
    }
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  textarea.style.pointerEvents = "none";
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  textarea.setSelectionRange(0, textarea.value.length);

  let copied = false;
  try {
    copied = document.execCommand("copy");
  } catch {
    copied = false;
  }

  textarea.remove();
  return copied;
}

function downloadTextFile(filename, text) {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function labelRole(role) {
  return role === "financeiro" ? "Financeiro" : "Vendedor";
}

function priorityLabel(priority) {
  return {
    alta: "Prioridade alta",
    media: "Cobrar hoje",
    normal: "Monitorar",
  }[priority] || "Monitorar";
}

function labelProgress(value) {
  return {
    pendente: "Pendente",
    em_contato: "Em contato",
    promessa: "Promessa",
    pago: "Pago",
  }[value] || "Pendente";
}

function metricPill(text) {
  return `<span class="metric-pill">${text}</span>`;
}

function formatCurrency(value) {
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
  }).format(Number(value || 0));
}

function slugify(value) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function toBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || "");
      resolve(result.split(",")[1]);
    };
    reader.onerror = () => reject(new Error(`Nao foi possivel ler o arquivo ${file.name}`));
    reader.readAsDataURL(file);
  });
}

bootstrap();
