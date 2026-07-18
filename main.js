/**
 * OrçaFácil — gerador de orçamentos profissionais (100% client-side)
 * Dados permanecem apenas no localStorage do navegador.
 */

(() => {
  "use strict";

  const STORAGE_KEY = "orcafacil_quotes_v1";
  const PROVIDER_KEY = "orcafacil_provider_v1";
  const MAX_LOGO_BYTES = 1024 * 1024;
  const STATUS_LABELS = {
    rascunho: "Rascunho",
    enviado: "Enviado",
    aprovado: "Aprovado",
    recusado: "Recusado",
  };

  /** @type {{ id: string|null, number: string, date: string, validity: string, status: string, provider: object, client: object, items: array, discountType: string, discountValue: number, surcharge: number, paymentTerms: string, executionDeadline: string, notes: string, createdAt: string|null, updatedAt: string|null }} */
  let state = createEmptyQuote();
  let editingItemId = null;
  let confirmCallback = null;
  let lastFocusedBeforeModal = null;
  let viewBeforePrint = null;

  function deepClone(value) {
    if (typeof structuredClone === "function") {
      try {
        return structuredClone(value);
      } catch {
        /* fall through */
      }
    }
    return JSON.parse(JSON.stringify(value));
  }

  function roundMoney(value) {
    return Math.round((Number(value) || 0) * 100) / 100;
  }

  // --------------------------------------------------------------------------
  // DOM helpers
  // --------------------------------------------------------------------------

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  function el(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    Object.entries(props).forEach(([k, v]) => {
      if (k === "className") node.className = v;
      else if (k === "text") node.textContent = v;
      else if (k === "html") node.innerHTML = v;
      else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === "dataset") Object.assign(node.dataset, v);
      else if (v !== undefined && v !== null) node.setAttribute(k, v);
    });
    children.forEach((c) => {
      if (c == null) return;
      node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    });
    return node;
  }

  // --------------------------------------------------------------------------
  // Money & format
  // --------------------------------------------------------------------------

  const currency = new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
  });

  function formatMoney(value) {
    return currency.format(Number(value) || 0);
  }

  function formatDateBR(iso) {
    if (!iso) return "—";
    const [y, m, d] = iso.split("-");
    if (!y || !m || !d) return iso;
    return `${d}/${m}/${y}`;
  }

  function todayISO() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  function addDaysISO(iso, days) {
    const d = new Date(iso + "T12:00:00");
    d.setDate(d.getDate() + days);
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  function uid() {
    return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
  }

  // --------------------------------------------------------------------------
  // State factory
  // --------------------------------------------------------------------------

  function createEmptyQuote() {
    const date = todayISO();
    return {
      id: null,
      number: generateQuoteNumber(),
      date,
      validity: addDaysISO(date, 15),
      status: "rascunho",
      provider: {
        name: "",
        doc: "",
        phone: "",
        email: "",
        address: "",
        logoDataUrl: "",
      },
      client: {
        name: "",
        doc: "",
        phone: "",
        email: "",
        address: "",
      },
      items: [],
      discountType: "none",
      discountValue: 0,
      surcharge: 0,
      paymentTerms: "",
      executionDeadline: "",
      notes: "",
      createdAt: null,
      updatedAt: null,
    };
  }

  function generateQuoteNumber() {
    const y = new Date().getFullYear();
    let maxSeq = 0;
    const quotes = loadQuotes({ silent: true });
    quotes.forEach((q) => {
      const match = String(q.number || "").match(/^ORC-(\d{4})-(\d+)$/);
      if (match && Number(match[1]) === y) {
        maxSeq = Math.max(maxSeq, Number(match[2]));
      }
    });
    return `ORC-${y}-${String(maxSeq + 1).padStart(4, "0")}`;
  }

  function ensureUniqueNumber(number, excludeId = null) {
    const quotes = loadQuotes({ silent: true });
    let candidate = number || generateQuoteNumber();
    let guard = 0;
    while (
      quotes.some((q) => q.number === candidate && q.id !== excludeId) &&
      guard < 200
    ) {
      const match = String(candidate).match(/^ORC-(\d{4})-(\d+)$/);
      if (match) {
        const next = Number(match[2]) + 1;
        candidate = `ORC-${match[1]}-${String(next).padStart(4, "0")}`;
      } else {
        candidate = generateQuoteNumber();
      }
      guard += 1;
    }
    return candidate;
  }

  // --------------------------------------------------------------------------
  // Calculations
  // --------------------------------------------------------------------------

  function itemSubtotal(item) {
    const qty = Math.max(0, Number(item.qty) || 0);
    const price = Math.max(0, Number(item.price) || 0);
    return roundMoney(qty * price);
  }

  function calcTotals(quote = state) {
    const items = Array.isArray(quote.items) ? quote.items : [];
    const subtotal = roundMoney(items.reduce((sum, item) => sum + itemSubtotal(item), 0));
    let discount = 0;
    const discountValue = Math.max(0, Number(quote.discountValue) || 0);

    if (quote.discountType === "percent") {
      const pct = Math.min(discountValue, 100);
      discount = roundMoney(subtotal * (pct / 100));
    } else if (quote.discountType === "fixed") {
      discount = roundMoney(Math.min(discountValue, subtotal));
    }

    const surcharge = roundMoney(Math.max(0, Number(quote.surcharge) || 0));
    const total = roundMoney(Math.max(0, subtotal - discount + surcharge));

    return { subtotal, discount, surcharge, total };
  }

  // --------------------------------------------------------------------------
  // Storage
  // --------------------------------------------------------------------------

  function loadQuotes({ silent = false } = {}) {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return [];
      const data = JSON.parse(raw);
      return Array.isArray(data) ? data : [];
    } catch {
      if (!silent) {
        showToast("Não foi possível ler o histórico. Os dados podem estar corrompidos.", "error");
      }
      return [];
    }
  }

  function saveQuotes(list) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  }

  function isStorageAvailable() {
    try {
      const key = "__orcafacil_probe__";
      localStorage.setItem(key, "1");
      localStorage.removeItem(key);
      return true;
    } catch {
      return false;
    }
  }

  function saveProviderDefaults(provider) {
    try {
      localStorage.setItem(PROVIDER_KEY, JSON.stringify(provider));
    } catch {
      /* quota — ignore */
    }
  }

  function loadProviderDefaults() {
    try {
      const raw = localStorage.getItem(PROVIDER_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  // --------------------------------------------------------------------------
  // Toast & confirm
  // --------------------------------------------------------------------------

  function showToast(message, type = "info", duration = 3200) {
    const container = $("#toast-container");
    const toast = el("div", {
      className: `toast toast--${type}`,
      role: "status",
    });
    toast.appendChild(el("span", { className: "toast__msg", text: message }));
    const closeBtn = el("button", {
      type: "button",
      className: "toast__close",
      "aria-label": "Fechar notificação",
      text: "×",
    });
    closeBtn.addEventListener("click", () => toast.remove());
    toast.appendChild(closeBtn);
    container.appendChild(toast);
    if (duration > 0) {
      setTimeout(() => {
        if (toast.isConnected) toast.remove();
      }, duration);
    }
  }

  function openModal(modal) {
    lastFocusedBeforeModal = document.activeElement;
    modal.hidden = false;
    document.body.style.overflow = "hidden";
    const focusable = modal.querySelector(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    );
    focusable?.focus();
  }

  function closeModal(modal) {
    modal.hidden = true;
    document.body.style.overflow = "";
    if (lastFocusedBeforeModal && typeof lastFocusedBeforeModal.focus === "function") {
      lastFocusedBeforeModal.focus();
    }
    lastFocusedBeforeModal = null;
  }

  function confirmAction({ title, message, confirmLabel = "Excluir", danger = true }) {
    return new Promise((resolve) => {
      const modal = $("#confirm-modal");
      $("#confirm-title").textContent = title;
      $("#confirm-message").textContent = message;
      const ok = $("#confirm-ok");
      ok.textContent = confirmLabel;
      ok.className = danger ? "btn btn--danger" : "btn btn--primary";

      confirmCallback = (result) => {
        confirmCallback = null;
        closeModal(modal);
        resolve(result);
      };

      openModal(modal);
    });
  }

  // --------------------------------------------------------------------------
  // Form ↔ state
  // --------------------------------------------------------------------------

  function readFormIntoState() {
    state.number = $("#quote-number").value.trim() || state.number;
    state.date = $("#quote-date").value || todayISO();
    state.validity = $("#quote-validity").value || "";
    state.status = $("#quote-status").value || "rascunho";

    state.provider.name = $("#provider-name").value.trim();
    state.provider.doc = $("#provider-doc").value.trim();
    state.provider.phone = $("#provider-phone").value.trim();
    state.provider.email = $("#provider-email").value.trim();
    state.provider.address = $("#provider-address").value.trim();
    // logoDataUrl already in state

    state.client.name = $("#client-name").value.trim();
    state.client.doc = $("#client-doc").value.trim();
    state.client.phone = $("#client-phone").value.trim();
    state.client.email = $("#client-email").value.trim();
    state.client.address = $("#client-address").value.trim();

    state.discountType = $("#discount-type").value || "none";
    state.discountValue = Math.max(0, Number($("#discount-value").value) || 0);
    if (state.discountType === "none") state.discountValue = 0;
    if (state.discountType === "percent" && state.discountValue > 100) {
      state.discountValue = 100;
    }
    state.surcharge = Math.max(0, Number($("#surcharge-value").value) || 0);
    state.paymentTerms = $("#payment-terms").value.trim();
    state.executionDeadline = $("#execution-deadline").value.trim();
    state.notes = $("#notes").value.trim();
  }

  function fillFormFromState() {
    $("#quote-number").value = state.number;
    $("#quote-date").value = state.date;
    $("#quote-validity").value = state.validity || "";
    $("#quote-status").value = state.status;

    $("#provider-name").value = state.provider.name || "";
    $("#provider-doc").value = state.provider.doc || "";
    $("#provider-phone").value = state.provider.phone || "";
    $("#provider-email").value = state.provider.email || "";
    $("#provider-address").value = state.provider.address || "";
    updateLogoUI();

    $("#client-name").value = state.client.name || "";
    $("#client-doc").value = state.client.doc || "";
    $("#client-phone").value = state.client.phone || "";
    $("#client-email").value = state.client.email || "";
    $("#client-address").value = state.client.address || "";

    $("#discount-type").value = state.discountType || "none";
    $("#discount-value").value = state.discountValue ?? 0;
    $("#surcharge-value").value = state.surcharge ?? 0;
    updateDiscountFieldState();

    $("#payment-terms").value = state.paymentTerms || "";
    $("#execution-deadline").value = state.executionDeadline || "";
    $("#notes").value = state.notes || "";

    clearFieldErrors();
    renderItems();
    updateTotalsUI();
    updateEditorChrome();
  }

  function updateLogoUI() {
    const img = $("#logo-img");
    const placeholder = $("#logo-placeholder");
    const removeBtn = $("#logo-remove");
    if (state.provider.logoDataUrl) {
      img.src = state.provider.logoDataUrl;
      img.hidden = false;
      placeholder.hidden = true;
      removeBtn.hidden = false;
    } else {
      img.removeAttribute("src");
      img.hidden = true;
      placeholder.hidden = false;
      removeBtn.hidden = true;
    }
  }

  function updateDiscountFieldState() {
    const type = $("#discount-type").value;
    const input = $("#discount-value");
    const label = $('label[for="discount-value"]');
    if (type === "none") {
      input.disabled = true;
      input.value = "0";
      input.removeAttribute("max");
      if (label) label.textContent = "Desconto";
    } else {
      input.disabled = false;
      if (type === "percent") {
        input.placeholder = "Ex.: 10";
        input.max = "100";
        if (label) label.textContent = "Desconto (%)";
      } else {
        input.placeholder = "Ex.: 50,00";
        input.removeAttribute("max");
        if (label) label.textContent = "Desconto (R$)";
      }
    }
  }

  function updateEditorChrome() {
    const isSaved = Boolean(state.id);
    $("#btn-duplicate").disabled = !isSaved;
    $("#btn-delete-current").disabled = !isSaved;

    const title = $(".page-title", $("#view-editor"));
    if (title) {
      title.textContent = isSaved ? `Editar ${state.number}` : "Novo orçamento";
    }
    const sub = $("#editor-subtitle");
    if (sub) {
      sub.textContent = isSaved
        ? "Altere os dados e salve para atualizar o histórico"
        : "Preencha os dados e gere um documento profissional";
    }
  }

  function updateTotalsUI() {
    const { subtotal, discount, surcharge, total } = calcTotals();
    $("#summary-subtotal").textContent = formatMoney(subtotal);
    $("#summary-discount").textContent = `− ${formatMoney(discount)}`;
    $("#summary-surcharge").textContent = `+ ${formatMoney(surcharge)}`;
    $("#summary-total").textContent = formatMoney(total);
  }

  // --------------------------------------------------------------------------
  // Items
  // --------------------------------------------------------------------------

  function renderItems() {
    const tbody = $("#items-tbody");
    const table = $("#items-table");
    const empty = $("#items-empty");
    const count = $("#items-count");

    tbody.innerHTML = "";
    const n = state.items.length;
    count.textContent = n === 1 ? "1 item" : `${n} itens`;

    if (n === 0) {
      table.classList.add("is-empty");
      empty.hidden = false;
      return;
    }

    table.classList.remove("is-empty");
    empty.hidden = true;

    state.items.forEach((item) => {
      const tr = el("tr", { dataset: { id: item.id } });
      tr.appendChild(el("td", { text: item.description }));
      tr.appendChild(el("td", { className: "col-num", text: formatQty(item.qty) }));
      tr.appendChild(el("td", { className: "col-num", text: formatMoney(item.price) }));
      tr.appendChild(el("td", { className: "col-num", text: formatMoney(itemSubtotal(item)) }));

      const actions = el("td", { className: "col-actions no-print" });
      const wrap = el("div", { className: "row-actions" });

      const editBtn = el("button", {
        type: "button",
        className: "btn btn--icon",
        "aria-label": `Editar item ${item.description}`,
        title: "Editar",
        html: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>`,
      });
      editBtn.addEventListener("click", () => openItemEditor(item.id));

      const delBtn = el("button", {
        type: "button",
        className: "btn btn--icon btn--delete",
        "aria-label": `Excluir item ${item.description}`,
        title: "Excluir",
        html: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>`,
      });
      delBtn.addEventListener("click", () => deleteItem(item.id));

      wrap.append(editBtn, delBtn);
      actions.appendChild(wrap);
      tr.appendChild(actions);
      tbody.appendChild(tr);
    });
  }

  function formatQty(qty) {
    const n = Number(qty);
    if (Number.isInteger(n)) return String(n);
    return n.toLocaleString("pt-BR", { maximumFractionDigits: 2 });
  }

  function addItemFromForm(e) {
    e.preventDefault();
    const desc = $("#item-desc").value.trim();
    const qty = Number($("#item-qty").value);
    const price = Number($("#item-price").value);
    const err = $("#item-form-error");

    if (!desc) {
      err.textContent = "Informe a descrição do item.";
      err.hidden = false;
      err.setAttribute("role", "alert");
      $("#item-desc").focus();
      return;
    }
    if (!qty || qty <= 0) {
      err.textContent = "A quantidade deve ser maior que zero.";
      err.hidden = false;
      $("#item-qty").focus();
      return;
    }
    const priceRaw = $("#item-price").value;
    if (priceRaw === "" || priceRaw === null) {
      err.textContent = "Informe o valor unitário.";
      err.hidden = false;
      $("#item-price").focus();
      return;
    }
    if (Number.isNaN(price) || price < 0) {
      err.textContent = "Informe um valor unitário válido (0 ou mais).";
      err.hidden = false;
      $("#item-price").focus();
      return;
    }

    err.hidden = true;
    err.removeAttribute("role");
    state.items.push({
      id: uid(),
      description: desc,
      qty: Number(qty),
      price: roundMoney(price),
    });

    $("#item-desc").value = "";
    $("#item-qty").value = "1";
    $("#item-price").value = "";
    $("#item-desc").focus();

    renderItems();
    updateTotalsUI();
    showToast("Item adicionado.", "success", 1800);
  }

  function openItemEditor(id) {
    const item = state.items.find((i) => i.id === id);
    if (!item) return;
    editingItemId = id;
    $("#item-modal-title").textContent = "Editar item";
    $("#edit-item-desc").value = item.description;
    $("#edit-item-qty").value = item.qty;
    $("#edit-item-price").value = item.price;
    clearEditItemErrors();
    openModal($("#item-modal"));
  }

  function clearEditItemErrors() {
    ["edit-item-desc", "edit-item-qty", "edit-item-price"].forEach((id) => {
      const input = $(`#${id}`);
      const field = input?.closest(".field");
      field?.classList.remove("has-error");
      input?.removeAttribute("aria-invalid");
      input?.removeAttribute("aria-describedby");
      const err = $(`#${id}-error`);
      if (err) {
        err.hidden = true;
        err.textContent = "";
        err.removeAttribute("role");
      }
    });
  }

  function saveItemEdit(e) {
    e.preventDefault();
    clearEditItemErrors();
    const desc = $("#edit-item-desc").value.trim();
    const qty = Number($("#edit-item-qty").value);
    const price = Number($("#edit-item-price").value);
    let valid = true;

    if (!desc) {
      setFieldError("edit-item-desc", "Descrição obrigatória.");
      valid = false;
    }
    if (!qty || qty <= 0) {
      setFieldError("edit-item-qty", "Quantidade inválida.");
      valid = false;
    }
    if (Number.isNaN(price) || price < 0) {
      setFieldError("edit-item-price", "Valor inválido.");
      valid = false;
    }
    if (!valid) return;

    const idx = state.items.findIndex((i) => i.id === editingItemId);
    if (idx === -1) return;

    state.items[idx] = {
      ...state.items[idx],
      description: desc,
      qty: Number(qty),
      price: roundMoney(price),
    };

    closeModal($("#item-modal"));
    editingItemId = null;
    renderItems();
    updateTotalsUI();
    showToast("Item atualizado.", "success", 1800);
  }

  function setFieldError(inputId, message) {
    const input = $(`#${inputId}`);
    const field = input?.closest(".field");
    field?.classList.add("has-error");
    if (input) {
      input.setAttribute("aria-invalid", "true");
      const errId = `${inputId}-error`;
      if ($(`#${errId}`)) {
        input.setAttribute("aria-describedby", errId);
      }
    }
    const err = $(`#${inputId}-error`);
    if (err) {
      err.textContent = message;
      err.hidden = false;
      err.setAttribute("role", "alert");
    }
  }

  async function deleteItem(id) {
    const item = state.items.find((i) => i.id === id);
    if (!item) return;
    const ok = await confirmAction({
      title: "Excluir item",
      message: `Remover “${item.description}” deste orçamento?`,
      confirmLabel: "Excluir item",
    });
    if (!ok) return;
    state.items = state.items.filter((i) => i.id !== id);
    renderItems();
    updateTotalsUI();
    showToast("Item excluído.", "info", 1800);
  }

  // --------------------------------------------------------------------------
  // Validation
  // --------------------------------------------------------------------------

  function clearFieldErrors() {
    $$(".field.has-error").forEach((f) => f.classList.remove("has-error"));
    $$("[aria-invalid='true']").forEach((input) => {
      input.removeAttribute("aria-invalid");
      if (input.getAttribute("aria-describedby")?.endsWith("-error")) {
        input.removeAttribute("aria-describedby");
      }
    });
    $$(".field-error").forEach((e) => {
      e.hidden = true;
      e.textContent = "";
      e.removeAttribute("role");
    });
  }

  function isValidEmail(email) {
    if (!email) return true;
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  }

  function validateQuote() {
    clearFieldErrors();
    readFormIntoState();
    let valid = true;
    let firstError = null;

    if (!state.provider.name) {
      setFieldError("provider-name", "Informe o nome ou empresa do prestador.");
      valid = false;
      firstError = firstError || $("#provider-name");
    }
    if (!isValidEmail(state.provider.email)) {
      setFieldError("provider-email", "E-mail do prestador inválido.");
      valid = false;
      firstError = firstError || $("#provider-email");
    }
    if (!state.client.name) {
      setFieldError("client-name", "Informe o nome do cliente.");
      valid = false;
      firstError = firstError || $("#client-name");
    }
    if (!isValidEmail(state.client.email)) {
      setFieldError("client-email", "E-mail do cliente inválido.");
      valid = false;
      firstError = firstError || $("#client-email");
    }
    if (!state.date) {
      showToast("Informe a data do orçamento.", "error");
      valid = false;
      firstError = firstError || $("#quote-date");
    }
    if (state.validity && state.date && state.validity < state.date) {
      showToast("A validade não pode ser anterior à data do orçamento.", "error");
      valid = false;
      firstError = firstError || $("#quote-validity");
    }
    if (state.discountType === "percent" && Number($("#discount-value").value) > 100) {
      setFieldError("discount-value", "O desconto percentual não pode ser maior que 100%.");
      valid = false;
      firstError = firstError || $("#discount-value");
    }
    if (state.discountType !== "none" && Number($("#discount-value").value) < 0) {
      setFieldError("discount-value", "O desconto não pode ser negativo.");
      valid = false;
      firstError = firstError || $("#discount-value");
    }
    if (Number($("#surcharge-value").value) < 0) {
      setFieldError("surcharge-value", "O acréscimo não pode ser negativo.");
      valid = false;
      firstError = firstError || $("#surcharge-value");
    }

    if (!valid) {
      showToast("Corrija os campos destacados antes de continuar.", "error");
      firstError?.focus();
    }
    return valid;
  }

  // --------------------------------------------------------------------------
  // Save / load / CRUD quotes
  // --------------------------------------------------------------------------

  function persistCurrentQuote() {
    if (!validateQuote()) return false;

    if (!isStorageAvailable()) {
      showToast("O armazenamento local está indisponível neste navegador.", "error");
      return false;
    }

    const now = new Date().toISOString();
    const list = loadQuotes();
    const wasNew = !state.id;
    const rollback = {
      id: state.id,
      createdAt: state.createdAt,
      updatedAt: state.updatedAt,
      number: state.number,
    };

    state.number = ensureUniqueNumber(state.number, state.id);
    state.updatedAt = now;

    if (wasNew) {
      state.id = uid();
      state.createdAt = now;
      list.unshift(deepClone(state));
    } else {
      const idx = list.findIndex((q) => q.id === state.id);
      const snapshot = deepClone(state);
      if (idx >= 0) {
        list.splice(idx, 1);
        list.unshift(snapshot);
      } else {
        list.unshift(snapshot);
      }
    }

    try {
      saveQuotes(list);
      saveProviderDefaults(state.provider);
    } catch (err) {
      state.id = rollback.id;
      state.createdAt = rollback.createdAt;
      state.updatedAt = rollback.updatedAt;
      state.number = rollback.number;
      showToast(
        "Não foi possível salvar. O armazenamento do navegador pode estar cheio (logo grande?).",
        "error"
      );
      return false;
    }

    $("#quote-number").value = state.number;
    updateEditorChrome();
    showToast(`Orçamento ${state.number} salvo com sucesso.`, "success");
    return true;
  }

  function loadQuoteIntoEditor(id, { toast = true, view = "editor" } = {}) {
    const list = loadQuotes();
    const found = list.find((q) => q.id === id);
    if (!found) {
      showToast("Orçamento não encontrado.", "error");
      return false;
    }
    state = deepClone(found);
    if (!STATUS_LABELS[state.status]) state.status = "rascunho";
    state.items = (state.items || []).map((it) => ({
      ...it,
      id: it.id || uid(),
      qty: Number(it.qty) || 0,
      price: Number(it.price) || 0,
    }));
    state.provider = state.provider || createEmptyQuote().provider;
    state.client = state.client || createEmptyQuote().client;
    fillFormFromState();
    if (view) switchView(view);
    if (toast) showToast(`Orçamento ${state.number} carregado.`, "info");
    return true;
  }

  async function deleteQuoteById(id, { fromEditor = false } = {}) {
    const list = loadQuotes();
    const found = list.find((q) => q.id === id);
    if (!found) return;

    const ok = await confirmAction({
      title: "Excluir orçamento",
      message: `Excluir permanentemente o orçamento ${found.number} de “${found.client?.name || "sem cliente"}”? Esta ação não pode ser desfeita.`,
      confirmLabel: "Excluir orçamento",
    });
    if (!ok) return;

    saveQuotes(list.filter((q) => q.id !== id));
    showToast("Orçamento excluído.", "info");

    if (fromEditor || state.id === id) {
      startNewQuote({ keepProvider: true });
    }
    if ($("#view-history").classList.contains("is-active")) {
      renderHistory();
    }
  }

  function startNewQuote({ keepProvider = true, toast = true } = {}) {
    let provider = createEmptyQuote().provider;
    if (keepProvider) {
      readFormIntoState();
      if (state.provider && (state.provider.name || state.provider.logoDataUrl)) {
        provider = deepClone(state.provider);
      } else {
        const defaults = loadProviderDefaults();
        if (defaults) provider = defaults;
      }
    }

    state = createEmptyQuote();
    state.number = ensureUniqueNumber(state.number);
    state.provider = {
      name: provider.name || "",
      doc: provider.doc || "",
      phone: provider.phone || "",
      email: provider.email || "",
      address: provider.address || "",
      logoDataUrl: provider.logoDataUrl || "",
    };
    fillFormFromState();
    if (toast) showToast("Novo orçamento iniciado.", "info", 2000);
  }

  function duplicateCurrentQuote() {
    if (!state.id) {
      showToast("Salve o orçamento antes de duplicar.", "error");
      return;
    }
    readFormIntoState();
    const copy = deepClone(state);
    copy.id = null;
    copy.number = ensureUniqueNumber(generateQuoteNumber());
    copy.status = "rascunho";
    copy.date = todayISO();
    copy.validity = addDaysISO(copy.date, 15);
    copy.createdAt = null;
    copy.updatedAt = null;
    copy.items = (copy.items || []).map((it) => ({ ...it, id: uid() }));
    state = copy;
    fillFormFromState();
    showToast(`Cópia criada como ${state.number}. Salve para gravar no histórico.`, "success");
  }

  function formHasUnsavedWork() {
    readFormIntoState();
    return Boolean(
      state.client.name ||
        state.client.email ||
        state.client.phone ||
        state.items.length > 0 ||
        state.notes ||
        state.paymentTerms ||
        state.executionDeadline ||
        (state.discountType && state.discountType !== "none" && state.discountValue > 0) ||
        state.surcharge > 0
    );
  }

  // --------------------------------------------------------------------------
  // History
  // --------------------------------------------------------------------------

  function renderHistory() {
    const listEl = $("#history-list");
    const empty = $("#history-empty");
    const emptyTitle = empty?.querySelector(".empty-state__title");
    const emptyText = empty?.querySelector(".empty-state__text");
    const emptyActions = empty?.querySelector(".empty-state__actions");
    const search = ($("#history-search").value || "").trim().toLowerCase();
    const statusFilter = $("#history-status").value;
    const allQuotes = loadQuotes();
    const hasAny = allQuotes.length > 0;

    let quotes = allQuotes;

    if (statusFilter !== "all") {
      quotes = quotes.filter((q) => q.status === statusFilter);
    }
    if (search) {
      quotes = quotes.filter((q) => {
        const client = (q.client?.name || "").toLowerCase();
        const number = (q.number || "").toLowerCase();
        return client.includes(search) || number.includes(search);
      });
    }

    listEl.innerHTML = "";

    if (quotes.length === 0) {
      empty.hidden = false;
      listEl.hidden = true;
      if (emptyTitle && emptyText) {
        if (hasAny) {
          emptyTitle.textContent = "Nenhum resultado";
          emptyText.textContent = "Nenhum orçamento corresponde à busca ou ao filtro de status.";
          if (emptyActions) emptyActions.hidden = true;
        } else {
          emptyTitle.textContent = "Nenhum orçamento encontrado";
          emptyText.textContent =
            "Salve um orçamento no editor ou carregue a demonstração para começar.";
          if (emptyActions) emptyActions.hidden = false;
        }
      }
      return;
    }

    empty.hidden = true;
    listEl.hidden = false;

    quotes.forEach((q) => {
      const totals = calcTotals(q);
      const card = el("article", {
        className: "history-card",
        role: "listitem",
      });

      const main = el("div", { className: "history-card__main" });
      const top = el("div", { className: "history-card__top" });
      top.appendChild(el("span", { className: "history-card__number", text: q.number }));
      top.appendChild(
        el("span", {
          className: `badge badge--${q.status || "rascunho"}`,
          text: STATUS_LABELS[q.status] || q.status || "Rascunho",
        })
      );
      main.appendChild(top);
      main.appendChild(
        el("p", {
          className: "history-card__client",
          text: q.client?.name || "Cliente não informado",
        })
      );
      main.appendChild(
        el("p", {
          className: "history-card__meta",
          html: `<span>Data: ${formatDateBR(q.date)}</span><span>Atualizado: ${
            q.updatedAt ? formatDateBR(q.updatedAt.slice(0, 10)) : "—"
          }</span>`,
        })
      );

      const side = el("div", { className: "history-card__side" });
      side.appendChild(el("div", { className: "history-card__total", text: formatMoney(totals.total) }));

      const actions = el("div", { className: "history-card__actions" });
      const openBtn = el("button", {
        type: "button",
        className: "btn btn--primary btn--sm",
        text: "Abrir",
      });
      openBtn.addEventListener("click", () => loadQuoteIntoEditor(q.id));

      const previewBtn = el("button", {
        type: "button",
        className: "btn btn--secondary btn--sm",
        text: "Visualizar",
      });
      previewBtn.addEventListener("click", () => {
        loadQuoteIntoEditor(q.id, { toast: true, view: "preview" });
      });

      const dupBtn = el("button", {
        type: "button",
        className: "btn btn--ghost btn--sm",
        text: "Duplicar",
      });
      dupBtn.addEventListener("click", () => {
        if (loadQuoteIntoEditor(q.id, { toast: false, view: "editor" })) {
          duplicateCurrentQuote();
        }
      });

      const delBtn = el("button", {
        type: "button",
        className: "btn btn--ghost btn--sm text-danger",
        text: "Excluir",
      });
      delBtn.addEventListener("click", () => deleteQuoteById(q.id));

      actions.append(openBtn, previewBtn, dupBtn, delBtn);
      side.appendChild(actions);

      card.append(main, side);
      listEl.appendChild(card);
    });
  }

  // --------------------------------------------------------------------------
  // Preview document
  // --------------------------------------------------------------------------

  function escapeHtml(str) {
    return String(str ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function lines(...parts) {
    return parts.filter(Boolean).map(escapeHtml).join("<br>");
  }

  function renderQuoteDocument() {
    readFormIntoState();
    const { subtotal, discount, surcharge, total } = calcTotals();
    const p = state.provider;
    const c = state.client;
    const doc = $("#quote-document");

    const safeLogo =
      p.logoDataUrl &&
      (p.logoDataUrl.startsWith("data:image/") || p.logoDataUrl.startsWith("blob:"))
        ? p.logoDataUrl
        : "";
    const logoHtml = safeLogo
      ? `<img class="quote-doc__logo" src="${safeLogo}" alt="Logo ${escapeHtml(p.name)}" />`
      : "";

    const itemsRows =
      state.items.length === 0
        ? ""
        : state.items
            .map(
              (item, i) => `
        <tr>
          <td>${i + 1}. ${escapeHtml(item.description)}</td>
          <td class="num">${escapeHtml(formatQty(item.qty))}</td>
          <td class="num">${escapeHtml(formatMoney(item.price))}</td>
          <td class="num">${escapeHtml(formatMoney(itemSubtotal(item)))}</td>
        </tr>`
            )
            .join("");

    const discountRow =
      discount > 0
        ? `<div class="quote-doc__totals-row"><span>Desconto${
            state.discountType === "percent" ? ` (${state.discountValue}%)` : ""
          }</span><span>− ${escapeHtml(formatMoney(discount))}</span></div>`
        : "";

    const surchargeRow =
      surcharge > 0
        ? `<div class="quote-doc__totals-row"><span>Acréscimo</span><span>+ ${escapeHtml(
            formatMoney(surcharge)
          )}</span></div>`
        : "";

    doc.innerHTML = `
      <header class="quote-doc__header">
        <div class="quote-doc__brand">
          ${logoHtml}
          <div class="quote-doc__company">
            <h1 class="quote-doc__company-name">${escapeHtml(p.name || "Prestador de serviços")}</h1>
            <p class="quote-doc__company-meta">
              ${lines(
                p.doc ? `CPF/CNPJ: ${p.doc}` : "",
                p.phone,
                p.email,
                p.address
              )}
            </p>
          </div>
        </div>
        <div class="quote-doc__meta-box">
          <span class="quote-doc__label">Orçamento</span>
          <p class="quote-doc__number">${escapeHtml(state.number)}</p>
          <p class="quote-doc__dates">
            <strong>Data:</strong> ${escapeHtml(formatDateBR(state.date))}<br>
            ${state.validity ? `<strong>Validade:</strong> ${escapeHtml(formatDateBR(state.validity))}` : ""}
          </p>
        </div>
      </header>

      <div class="quote-doc__title-bar">
        <h2 class="quote-doc__doc-title">Proposta comercial</h2>
        <span class="quote-doc__status badge badge--${escapeHtml(state.status)}">${escapeHtml(
          STATUS_LABELS[state.status] || state.status
        )}</span>
      </div>

      <div class="quote-doc__parties">
        <div class="quote-doc__party">
          <h3>Prestador</h3>
          <p class="quote-doc__party-name">${escapeHtml(p.name || "—")}</p>
          <p class="quote-doc__party-lines">${lines(p.doc, p.phone, p.email, p.address)}</p>
        </div>
        <div class="quote-doc__party">
          <h3>Cliente</h3>
          <p class="quote-doc__party-name">${escapeHtml(c.name || "—")}</p>
          <p class="quote-doc__party-lines">${lines(c.doc, c.phone, c.email, c.address)}</p>
        </div>
      </div>

      ${
        state.items.length
          ? `<table class="quote-doc__table">
        <thead>
          <tr>
            <th>Descrição</th>
            <th class="num">Qtd.</th>
            <th class="num">Unitário</th>
            <th class="num">Subtotal</th>
          </tr>
        </thead>
        <tbody>${itemsRows}</tbody>
      </table>`
          : `<div class="quote-doc__empty-items">Nenhum item incluído neste orçamento.</div>`
      }

      <div class="quote-doc__totals">
        <div class="quote-doc__totals-box">
          <div class="quote-doc__totals-row"><span>Subtotal</span><span>${escapeHtml(
            formatMoney(subtotal)
          )}</span></div>
          ${discountRow}
          ${surchargeRow}
          <div class="quote-doc__totals-row quote-doc__totals-row--total"><span>Total</span><span>${escapeHtml(
            formatMoney(total)
          )}</span></div>
        </div>
      </div>

      ${
        state.paymentTerms
          ? `<section class="quote-doc__section"><h3>Condições de pagamento</h3><p>${escapeHtml(
              state.paymentTerms
            )}</p></section>`
          : ""
      }
      ${
        state.executionDeadline
          ? `<section class="quote-doc__section"><h3>Prazo de execução</h3><p>${escapeHtml(
              state.executionDeadline
            )}</p></section>`
          : ""
      }
      ${
        state.notes
          ? `<section class="quote-doc__section"><h3>Observações</h3><p>${escapeHtml(
              state.notes
            )}</p></section>`
          : ""
      }

      <footer class="quote-doc__footer">
        <div class="quote-doc__sign">
          <div class="quote-doc__sign-line"></div>
          <p>${escapeHtml(p.name || "Prestador")}<br>Assinatura / carimbo</p>
        </div>
        <div class="quote-doc__sign">
          <div class="quote-doc__sign-line"></div>
          <p>${escapeHtml(c.name || "Cliente")}<br>Aceite do cliente</p>
        </div>
      </footer>

      <p class="quote-doc__disclaimer no-print">
        Documento gerado com OrçaFácil (projeto demonstrativo). Os dados não são enviados a servidores.
      </p>
    `;
  }

  // --------------------------------------------------------------------------
  // PDF & print
  // --------------------------------------------------------------------------

  function restorePdfButton(btn) {
    btn.disabled = false;
    btn.innerHTML = `
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
        Gerar PDF`;
  }

  async function generatePdf() {
    if (typeof html2pdf === "undefined") {
      showToast("Biblioteca de PDF não carregou. Verifique sua conexão e tente de novo.", "error");
      return;
    }

    if (!validateQuote()) return;

    renderQuoteDocument();
    switchView("preview", { silent: true });

    const element = $("#quote-document");
    const safeClient = (state.client.name || "cliente")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^\w\s-]/g, "")
      .trim()
      .replace(/\s+/g, "_")
      .slice(0, 40) || "cliente";
    const filename = `${state.number || "orcamento"}_${safeClient}.pdf`;

    const btn = $("#btn-pdf");
    btn.disabled = true;
    btn.textContent = "Gerando…";

    const opt = {
      margin: [10, 10, 10, 10],
      filename,
      image: { type: "jpeg", quality: 0.98 },
      html2canvas: {
        scale: 2,
        useCORS: true,
        logging: false,
        letterRendering: true,
        backgroundColor: "#ffffff",
      },
      jsPDF: { unit: "mm", format: "a4", orientation: "portrait" },
      pagebreak: { mode: ["css", "legacy"] },
    };

    const disclaimer = element.querySelector(".quote-doc__disclaimer");
    const statusEl = element.querySelector(".quote-doc__status");
    try {
      if (disclaimer) disclaimer.style.display = "none";
      if (statusEl) statusEl.style.display = "none";

      await html2pdf().set(opt).from(element).save();
      showToast("PDF gerado com sucesso.", "success");
    } catch (err) {
      console.error(err);
      showToast("Falha ao gerar o PDF. Tente imprimir e salvar como PDF no navegador.", "error");
    } finally {
      if (disclaimer) disclaimer.style.display = "";
      if (statusEl) statusEl.style.display = "";
      restorePdfButton(btn);
    }
  }

  function printQuote() {
    if (!validateQuote()) {
      switchView("editor");
      return;
    }
    renderQuoteDocument();
    viewBeforePrint = getActiveView();
    switchView("preview", { silent: true });
    window.setTimeout(() => window.print(), 120);
  }

  function getActiveView() {
    if ($("#view-preview").classList.contains("is-active")) return "preview";
    if ($("#view-history").classList.contains("is-active")) return "history";
    return "editor";
  }

  function preparePrintDocument() {
    readFormIntoState();
    renderQuoteDocument();
    if (viewBeforePrint == null) viewBeforePrint = getActiveView();
    switchView("preview", { silent: true });
  }

  // --------------------------------------------------------------------------
  // Demo data
  // --------------------------------------------------------------------------

  async function loadDemo() {
    if (formHasUnsavedWork() || state.id) {
      const ok = await confirmAction({
        title: "Carregar demonstração?",
        message: state.id
          ? "Isso substitui o orçamento atual no editor (o histórico salvo não é apagado). Continuar?"
          : "Há dados no formulário. Carregar a demonstração descarta o que não foi salvo. Continuar?",
        confirmLabel: "Carregar demo",
        danger: false,
      });
      if (!ok) return;
    }

    const date = todayISO();
    state = {
      id: null,
      number: ensureUniqueNumber(generateQuoteNumber()),
      date,
      validity: addDaysISO(date, 20),
      status: "enviado",
      provider: {
        name: "Horizon Serviços & Reformas Ltda.",
        doc: "12.345.678/0001-90",
        phone: "(11) 3456-7890",
        email: "contato@horizonreformas.demo",
        address: "Av. Paulista, 1000 — Bela Vista, São Paulo — SP, 01310-100",
        logoDataUrl: createDemoLogo(),
      },
      client: {
        name: "Ana Beatriz Mendes",
        doc: "123.456.789-00",
        phone: "(11) 98765-4321",
        email: "ana.mendes@email.demo",
        address: "Rua das Flores, 250 — Jardim América, São Paulo — SP",
      },
      items: [
        {
          id: uid(),
          description: "Pintura interna completa (salas e corredores)",
          qty: 80,
          price: 28.5,
        },
        {
          id: uid(),
          description: "Instalação de luminárias LED embutidas",
          qty: 12,
          price: 95,
        },
        {
          id: uid(),
          description: "Reparo e nivelamento de gesso no teto",
          qty: 1,
          price: 850,
        },
        {
          id: uid(),
          description: "Mão de obra especializada (diária)",
          qty: 5,
          price: 320,
        },
      ],
      discountType: "percent",
      discountValue: 5,
      surcharge: 150,
      paymentTerms:
        "40% na aprovação do orçamento e 60% na conclusão dos serviços, via PIX ou transferência.",
      executionDeadline: "12 dias úteis após a aprovação e liberação do local.",
      notes:
        "Materiais de pintura inclusos (tinta acrílica premium). Não inclui remoção de móveis pesados. Garantia de 6 meses sobre a mão de obra. Valores válidos para o endereço informado.",
      createdAt: null,
      updatedAt: null,
    };

    fillFormFromState();
    switchView("editor");
    showToast("Demonstração carregada. Você pode salvar, editar ou exportar.", "success");
  }

  function createDemoLogo() {
    // PNG via canvas — mais compatível com html2canvas/PDF do que SVG data-URL
    const canvas = document.createElement("canvas");
    canvas.width = 120;
    canvas.height = 120;
    const ctx = canvas.getContext("2d");
    if (!ctx) return "";

    const grad = ctx.createLinearGradient(0, 0, 120, 120);
    grad.addColorStop(0, "#0f766e");
    grad.addColorStop(1, "#0d9488");
    roundRect(ctx, 0, 0, 120, 120, 24);
    ctx.fillStyle = grad;
    ctx.fill();

    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 42px DM Sans, Arial, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("HS", 60, 62);
    return canvas.toDataURL("image/png");
  }

  function roundRect(ctx, x, y, w, h, r) {
    const radius = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.arcTo(x + w, y, x + w, y + h, radius);
    ctx.arcTo(x + w, y + h, x, y + h, radius);
    ctx.arcTo(x, y + h, x, y, radius);
    ctx.arcTo(x, y, x + w, y, radius);
    ctx.closePath();
  }

  // --------------------------------------------------------------------------
  // Navigation
  // --------------------------------------------------------------------------

  function switchView(name, { silent = false } = {}) {
    const views = {
      editor: $("#view-editor"),
      preview: $("#view-preview"),
      history: $("#view-history"),
    };

    Object.entries(views).forEach(([key, node]) => {
      const active = key === name;
      node.classList.toggle("is-active", active);
      node.hidden = !active;
    });

    $$(".nav-btn").forEach((btn) => {
      const active = btn.dataset.view === name;
      btn.classList.toggle("is-active", active);
      if (active) btn.setAttribute("aria-current", "page");
      else btn.removeAttribute("aria-current");
    });

    if (name === "preview") {
      renderQuoteDocument();
    }
    if (name === "history") {
      renderHistory();
    }

    if (!silent) {
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  }

  // --------------------------------------------------------------------------
  // Logo upload
  // --------------------------------------------------------------------------

  function handleLogoUpload(file) {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      showToast("Selecione um arquivo de imagem (PNG, JPG, WebP ou SVG).", "error");
      return;
    }
    if (file.size > MAX_LOGO_BYTES) {
      showToast("A logo deve ter no máximo 1 MB.", "error");
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      state.provider.logoDataUrl = String(reader.result);
      updateLogoUI();
      showToast("Logotipo carregado.", "success", 1800);
    };
    reader.onerror = () => showToast("Não foi possível ler a imagem.", "error");
    reader.readAsDataURL(file);
  }

  // --------------------------------------------------------------------------
  // Event wiring
  // --------------------------------------------------------------------------

  function wireEvents() {
    // Navigation
    $$(".nav-btn").forEach((btn) => {
      btn.addEventListener("click", () => switchView(btn.dataset.view));
    });

    $("#btn-preview-go").addEventListener("click", () => {
      if (!validateQuote()) return;
      switchView("preview");
    });
    $("#btn-back-editor").addEventListener("click", () => switchView("editor"));
    $("#btn-history-new").addEventListener("click", () => {
      startNewQuote({ keepProvider: true });
      switchView("editor");
    });
    $("#btn-empty-new").addEventListener("click", () => {
      startNewQuote({ keepProvider: true });
      switchView("editor");
    });
    $("#btn-empty-demo").addEventListener("click", loadDemo);

    // Save actions
    const save = () => persistCurrentQuote();
    $("#btn-save").addEventListener("click", save);
    $("#btn-save-header").addEventListener("click", save);
    $("#btn-save-preview").addEventListener("click", () => {
      if (persistCurrentQuote()) switchView("preview");
    });

    $("#btn-new").addEventListener("click", async () => {
      if (formHasUnsavedWork() && !state.id) {
        const ok = await confirmAction({
          title: "Começar novo orçamento?",
          message: "Há dados não salvos neste formulário. Deseja descartá-los e começar um novo?",
          confirmLabel: "Descartar e criar novo",
          danger: true,
        });
        if (!ok) return;
      }
      startNewQuote({ keepProvider: true });
    });

    $("#btn-duplicate").addEventListener("click", duplicateCurrentQuote);
    $("#btn-delete-current").addEventListener("click", () => {
      if (state.id) deleteQuoteById(state.id, { fromEditor: true });
    });

    $("#btn-demo").addEventListener("click", () => {
      loadDemo();
    });
    $("#btn-print").addEventListener("click", printQuote);
    $("#btn-pdf").addEventListener("click", generatePdf);

    window.addEventListener("beforeprint", () => {
      preparePrintDocument();
    });
    window.addEventListener("afterprint", () => {
      if (viewBeforePrint && viewBeforePrint !== "preview") {
        switchView(viewBeforePrint, { silent: true });
      }
      viewBeforePrint = null;
    });

    // Items
    $("#item-add-form").addEventListener("submit", addItemFromForm);
    $("#item-edit-form").addEventListener("submit", saveItemEdit);

    // Live totals
    ["discount-type", "discount-value", "surcharge-value"].forEach((id) => {
      $(`#${id}`).addEventListener("input", () => {
        if (id === "discount-type") updateDiscountFieldState();
        readFormIntoState();
        updateTotalsUI();
      });
      $(`#${id}`).addEventListener("change", () => {
        if (id === "discount-type") updateDiscountFieldState();
        readFormIntoState();
        updateTotalsUI();
      });
    });

    // Logo
    $("#logo-input").addEventListener("change", (e) => {
      const file = e.target.files?.[0];
      handleLogoUpload(file);
      e.target.value = "";
    });
    $("#logo-remove").addEventListener("click", () => {
      state.provider.logoDataUrl = "";
      updateLogoUI();
      showToast("Logotipo removido.", "info", 1600);
    });

    // History filters
    $("#history-search").addEventListener("input", () => renderHistory());
    $("#history-status").addEventListener("change", () => renderHistory());

    // Modals
    $$("[data-close-modal]").forEach((node) => {
      node.addEventListener("click", () => {
        const modal = node.closest(".modal");
        if (modal?.id === "confirm-modal" && confirmCallback) {
          confirmCallback(false);
        } else if (modal) {
          if (modal.id === "item-modal") editingItemId = null;
          closeModal(modal);
        }
      });
    });

    $("#confirm-ok").addEventListener("click", () => {
      if (confirmCallback) confirmCallback(true);
    });

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        const open = $$(".modal").find((m) => !m.hidden);
        if (open) {
          if (open.id === "confirm-modal" && confirmCallback) confirmCallback(false);
          else {
            if (open.id === "item-modal") editingItemId = null;
            closeModal(open);
          }
        }
      }
      // Ctrl/Cmd + S to save
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if ($("#view-editor").classList.contains("is-active")) {
          persistCurrentQuote();
        }
      }
    });

    // Trap focus in modals lightly
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Tab") return;
      const modal = $$(".modal").find((m) => !m.hidden);
      if (!modal) return;
      const focusables = [
        ...modal.querySelectorAll(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        ),
      ].filter((node) => {
        if (node.closest("[hidden]")) return false;
        const style = window.getComputedStyle(node);
        return style.display !== "none" && style.visibility !== "hidden";
      });
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    });
  }

  // --------------------------------------------------------------------------
  // Init
  // --------------------------------------------------------------------------

  function init() {
    wireEvents();

    // Restore last provider defaults on first empty form
    const defaults = loadProviderDefaults();
    state = createEmptyQuote();
    if (defaults) {
      state.provider = {
        name: defaults.name || "",
        doc: defaults.doc || "",
        phone: defaults.phone || "",
        email: defaults.email || "",
        address: defaults.address || "",
        logoDataUrl: defaults.logoDataUrl || "",
      };
    }
    fillFormFromState();
    switchView("editor", { silent: true });

    // API mínima para testes manuais em demo de portfólio
    window.OrcaFacil = {
      getState: () => deepClone(state),
      calcTotals: () => calcTotals(),
      loadDemo,
      loadQuotes: () => loadQuotes({ silent: true }),
    };
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
