// PaSta prototype wallet. Talks to one PaSta node over its REST API (docs/SPEC.md section 10
// in pastacoin/pastacoin). Keys are made and kept in this browser; the node only ever sees
// signed transactions.

import {
  formatUnits, generateKeypair, isAddress, parseJsonExact, publicKeyFor, signTransaction, toUnits,
} from "./pasta-crypto.js";

// The node this page talks to unless the visitor chooses another (?node=... or "Change node").
// Change this one line to https://seed.pastacoin.org once the public seed node exists.
const DEFAULT_NODE = "https://seed.pastacoin.org";

const POLL_MS = 3000;
const FEED_ROWS = 30;
const GENESIS = "GENESIS";

// ------------------------------------------------------------------ storage ----
const store = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch { /* private window or storage blocked: the page still works for this visit */ }
  },
};

function cleanNodeUrl(text) {
  const url = new URL(String(text).trim());
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("the address must start with http:// or https://");
  return url.origin + url.pathname.replace(/\/+$/, "");
}

function initialNode() {
  const fromQuery = new URLSearchParams(location.search).get("node");
  if (fromQuery) {
    try {
      const url = cleanNodeUrl(fromQuery);
      store.set("pasta.node", url);
      return url;
    } catch { /* fall through to the remembered or default node */ }
  }
  return store.get("pasta.node", DEFAULT_NODE);
}

const state = {
  node: initialNode(),
  wallets: store.get("pasta.wallets", []),      // [{name, private_key, public_key}]
  active: store.get("pasta.active", null),      // public key of the wallet in use
  online: null,                                 // null = not tried yet
  status: null,
  mempool: [],
  chain: [],
  balance: null,                                // BigInt base units
  pendingOut: null,
  sent: [],                                     // payments sent in this visit: {tx_id, to, amount}
  refreshing: false,
  acting: false,                                // a send / confirm / auto-validate is in flight
  epoch: 0,                                     // bumped by every action, so a poll that straddled one is discarded
};

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const activeWallet = () => state.wallets.find((w) => w.public_key === state.active) || null;
const units = () => BigInt(state.status ? state.status.units_per_pasta : 100000000);
const fmt = (u, places) => formatUnits(u, units(), places);

function saveWallets() {
  store.set("pasta.wallets", state.wallets);
  store.set("pasta.active", state.active);
}

// --------------------------------------------------------------------- node ----
async function api(path, body) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), body ? 120000 : 10000);   // validating mines proof-of-work on the node
  let res, text;
  try {
    res = await fetch(state.node + path, body
      ? { method: "POST", headers: { "Content-Type": "application/json" }, body, signal: ctl.signal }
      : { signal: ctl.signal });
    text = await res.text();
  } catch {
    const err = new Error(`no answer from ${state.node}`);
    err.unreachable = true;
    throw err;
  } finally {
    clearTimeout(timer);
  }
  let data = null;
  try { data = parseJsonExact(text); } catch { /* not JSON */ }
  if (!res.ok) {
    const err = new Error((data && data.error) || `the node answered ${res.status}`);
    err.type = data && data.type;
    throw err;
  }
  return data;
}

function nextTimestamp() {
  // tx_id covers (sender, receiver, amount, timestamp) at one-second resolution, so never reuse a second
  const now = Math.floor(Date.now() / 1000);
  const ts = Math.max(now, store.get("pasta.lastTs", 0) + 1);
  store.set("pasta.lastTs", ts);
  return ts;
}

async function submitTransaction(wallet, receiver, amount) {
  const ts = nextTimestamp();
  const sig = await signTransaction(wallet.private_key, wallet.public_key, receiver, amount, ts);
  // built by hand so the amount stays an exact integer whatever its size
  const body = `{"sender":${JSON.stringify(wallet.public_key)},"receiver":${JSON.stringify(receiver)},` +
               `"amount":${amount},"timestamp":${ts},"signature":${JSON.stringify(sig)}}`;
  return (await api("/create_transaction", body)).tx;
}

const validate = (myTxId, targetTxId) =>
  api("/validate", JSON.stringify({ my_tx_id: myTxId, target_tx_id: targetTxId }));

async function refresh() {
  if (state.refreshing) return;
  state.refreshing = true;
  const epoch = state.epoch;
  try {
    const status = await api("/status");
    const mempool = await api("/mempool");
    if (status.height !== state.chain.length) state.chain = await api("/blockchain");
    state.status = status;
    state.mempool = mempool;
    const w = activeWallet();
    if (w) {
      const b = await api("/balance/" + encodeURIComponent(w.public_key));
      if (state.active === w.public_key) {
        state.balance = BigInt(b.balance);
        state.pendingOut = BigInt(b.pending_outgoing);
      }
    }
    state.online = true;
  } catch (err) {
    if (err.unreachable) state.online = false;
    else say("conn-msg", `The node answered with an error: ${err.message}`, "err");
  } finally {
    state.refreshing = false;
  }
  render();
  if (epoch !== state.epoch) return refresh();     // something changed while we were reading: read again
  if (state.online) autoValidate();
}

// Step 2 of a payment: one of my State-A transactions validates someone else's State-B one.
async function autoValidate() {
  if (state.acting) return;
  const mine = new Set(state.wallets.map((w) => w.public_key));
  for (const tx of state.mempool) {
    if (tx.state !== "A" || !mine.has(tx.sender_address)) continue;
    const target = state.mempool.find((t) => t.state === "B" && t.sender_address !== tx.sender_address);
    if (!target) continue;
    state.acting = true;
    try {
      await validate(tx.tx_id, target.tx_id);
    } catch (err) {
      // NotFound / InvalidTransition mean our view of the mempool was a moment old: the next poll retries
      const stale = err.type === "NotFound" || err.type === "InvalidTransition";
      if (!err.unreachable && !stale) say("send-msg", `Could not validate yet: ${err.message}`, "err");
    } finally {
      state.acting = false;
      state.epoch++;
    }
    refresh();
    return;
  }
}

// ----------------------------------------------------------------- messages ----
function say(id, text, kind) {
  const el = $(id);
  el.textContent = text || "";
  el.className = "msg" + (kind ? " " + kind : "");
}

function setHtml(el, html) {
  if (el._html !== html) {
    el.innerHTML = html;
    el._html = html;
  }
}

function who(address) {
  if (address === GENESIS) return '<span class="who">chain start</span>';
  const w = state.wallets.find((x) => x.public_key === address);
  if (w) return `<span class="who me" title="${esc(address)}">${esc(w.name)}${address === state.active ? " (you)" : ""}</span>`;
  const a = String(address || "");
  return `<span class="who" title="${esc(a)}">${esc(a.slice(0, 6))}…${esc(a.slice(-4))}</span>`;
}

// ------------------------------------------------------------------- render ----
function render() {
  renderConnection();
  renderWallet();
  renderMine();
  renderHelp();
  renderFeed();
  renderNetwork();
}

function renderConnection() {
  $("conn-url").textContent = state.node;
  const dot = $("conn-dot");
  if (state.online === null) {
    dot.className = "dot";
    $("conn-text").textContent = "Connecting…";
  } else if (state.online) {
    dot.className = "dot ok";
    const s = state.status;
    const waiting = state.mempool.length;
    $("conn-text").textContent = `Connected · ${s.height} block${s.height === 1 ? "" : "s"} · ${waiting} waiting`;
  } else {
    dot.className = "dot down";
    $("conn-text").textContent = "Not connected";
  }
  $("offline-help").hidden = state.online !== false;
  $("btn-verify").disabled = !state.online;
}

function renderWallet() {
  const w = activeWallet();
  $("wallet-empty").hidden = !!w;
  $("wallet-full").hidden = !w;
  const sel = $("wallet-select");
  setHtml(sel, state.wallets.map((x) => `<option value="${esc(x.public_key)}">${esc(x.name)}</option>`).join(""));
  if (w) {
    sel.value = w.public_key;
    $("address").textContent = w.public_key;
    if (state.online && state.balance !== null) {
      $("balance").textContent = fmt(state.balance);
      const pend = state.pendingOut || 0n;
      $("balance-note").textContent = pend > 0n ? `${fmt(pend)} of it is committed to payments still waiting.` : "";
      $("send-available").textContent = `Available: ${fmt(state.balance - pend)} PASTA`;
    } else {
      $("balance").textContent = "–";
      $("balance-note").textContent = state.online === false ? "Balance unknown while the node is unreachable." : "";
      $("send-available").textContent = "";
    }
  } else {
    $("send-available").textContent = "";
  }
  $("btn-send").disabled = !w || !state.online;
}

function stepBar(n, done) {
  return `<span class="steps${done ? " done" : ""}" aria-hidden="true">` +
    [1, 2, 3].map((i) => `<i class="${i <= n ? "on" : ""}"></i>`).join("") + "</span>";
}

function describe(tx) {
  return BigInt(tx.amount) === 0n ? "Validation-only transaction" : `${fmt(tx.amount)} PASTA`;
}

function renderMine() {
  const w = activeWallet();
  const el = $("mine-list");
  if (!w) return setHtml(el, '<li class="empty">Create or import a wallet to begin.</li>');
  if (!state.online) return setHtml(el, '<li class="empty">Waiting for the node.</li>');
  const me = w.public_key;
  const rows = [];
  const inMempool = new Set(state.mempool.map((t) => t.tx_id));
  const onChain = new Map(state.chain.map((b, i) => [b.tx_id, i]));

  for (const tx of state.mempool) {
    if (tx.sender_address === me) {
      const zero = BigInt(tx.amount) === 0n;
      const what = zero ? "Validation-only transaction" : `${fmt(tx.amount)} PASTA to ${who(tx.receiver_address)}`;
      const step = tx.state === "A"
        ? `${stepBar(1)}Step 1 of 3 · sent, looking for a payment to validate`
        : `${stepBar(2)}Step 2 of 3 · waiting for another user to confirm it`;
      rows.push(`<li><div class="grow"><div class="what">${what}</div><div class="meta">${step}</div></div></li>`);
    } else if (tx.receiver_address === me && BigInt(tx.amount) > 0n) {
      rows.push(`<li><div class="grow"><div class="what">Incoming ${fmt(tx.amount)} PASTA from ${who(tx.sender_address)}</div>` +
        `<div class="meta">${stepBar(tx.state === "A" ? 1 : 2)}Not final yet · it is yours once someone other than the sender confirms it</div></div></li>`);
    }
  }
  for (const s of state.sent) {
    if (s.from === me && !inMempool.has(s.tx_id) && !onChain.has(s.tx_id)) {
      rows.push(`<li><div class="grow"><div class="what">${fmt(s.amount)} PASTA to ${who(s.to)}</div>` +
        `<div class="meta">Dropped by the node: the balance was not there when it came up for confirmation.</div></div></li>`);
    }
  }
  let shown = 0;
  for (let i = state.chain.length - 1; i >= 1 && shown < 6; i--) {
    const b = state.chain[i];
    const amount = BigInt(b.amount);
    if (amount === 0n || (b.sender_address !== me && b.receiver_address !== me)) continue;
    const mint = BigInt(b.mint_amount || 0);
    const out = b.sender_address === me;
    let what = out ? `Sent ${fmt(amount)} PASTA to ${who(b.receiver_address)}` : `Received ${fmt(amount)} PASTA from ${who(b.sender_address)}`;
    if (!out) what += " " + mintTag(mint, mint > 0n ? " minted" : " burned");
    rows.push(`<li><div class="grow"><div class="what">${what}</div>` +
      `<div class="meta">${stepBar(3, true)}Final · block ${i} · confirmed by ${who(b.validator_address)}</div></div></li>`);
    shown++;
  }
  setHtml(el, rows.join("") || '<li class="empty">Nothing yet. Send a payment, or give someone your address.</li>');
}

function renderHelp() {
  const el = $("help-list");
  const w = activeWallet();
  if (!state.online) return setHtml(el, '<li class="empty">Waiting for the node.</li>');
  const waiting = state.mempool.filter((t) => t.state === "B");
  if (!waiting.length) return setHtml(el, '<li class="empty">Nothing is waiting to be confirmed.</li>');
  const rows = waiting.map((t) => {
    const own = w && t.sender_address === w.public_key;
    const what = t.sender_address === GENESIS
      ? "Chain bootstrap <span class=\"meta\">(the first thing anyone confirms)</span>"
      : `${describe(t)} <span class="meta">from</span> ${who(t.sender_address)}` +
        (BigInt(t.amount) > 0n ? ` <span class="meta">to</span> ${who(t.receiver_address)}` : "");
    const action = own
      ? '<span class="meta">yours: someone else must confirm it</span>'
      : `<button class="small" type="button" data-confirm="${esc(t.tx_id)}"${w ? "" : " disabled"}>Confirm</button>`;
    return `<li><div class="grow what">${what}</div>${action}</li>`;
  });
  setHtml(el, rows.join(""));
}

// a mint or burn, short enough for a table cell; the exact figure is in the tooltip
function mintTag(mint, suffix) {
  if (mint === 0n) return "";
  const size = mint < 0n ? -mint : mint;
  const short = size * 10000n >= units() ? fmt(size, 4) : fmt(size);
  return `<span class="tag ${mint > 0n ? "mint" : "burn"}" title="${fmt(size)} PASTA ${mint > 0n ? "minted" : "burned"}">` +
    `${mint > 0n ? "+" : "−"}${short}${suffix || ""}</span>`;
}

function renderFeed() {
  const body = $("feed-body");
  const chain = state.chain;
  const all = $("feed-all").checked;
  $("feed-empty").hidden = chain.length > 0;
  const rows = [];
  let hidden = 0;
  for (let i = chain.length - 1; i >= 0 && rows.length < FEED_ROWS; i--) {
    const b = chain[i];
    const amount = BigInt(b.amount);
    const zero = amount === 0n;
    if (zero && !all) { hidden++; continue; }
    const bootstrap = zero && b.sender_address === GENESIS;
    const amountCell = i === 0 ? `${fmt(amount)} <span class="stack"><span class="tag">first coins</span></span>` : zero ? (bootstrap ? "chain bootstrap" : "validation only") : fmt(amount);
    rows.push(`<tr class="${zero ? "quiet" : ""}"><td>${i}</td><td class="l">${who(b.sender_address)}</td>` +
      `<td class="l">${zero ? "" : who(b.receiver_address)}</td>` +
      `<td>${amountCell}<span class="narrow-only">${mintTag(BigInt(b.mint_amount || 0))}</span></td>` +
      `<td class="wide-only">${mintTag(BigInt(b.mint_amount || 0))}</td>` +
      `<td class="l wide-only">${i === 0 ? "" : who(b.validator_address)}</td></tr>`);
  }
  setHtml(body, rows.join(""));
  const notes = [];
  if (hidden) notes.push(`${hidden} validation-only block${hidden === 1 ? "" : "s"} not shown.`);
  if (rows.length >= FEED_ROWS) notes.push(`Showing the newest ${FEED_ROWS} rows of ${chain.length} blocks.`);
  $("feed-more").textContent = notes.join(" ");
}

function kpi(label, value, note, extra) {
  return `<div class="kpi"><div class="label">${label}</div><div class="value">${value}</div><div class="note">${note}</div>${extra || ""}</div>`;
}

function renderNetwork() {
  const el = $("kpis");
  if (!state.online || !state.status) {
    setHtml(el, "");
    $("net-note").textContent = state.online === false ? "Network figures appear once a node is connected." : "";
    return;
  }
  const s = state.status.stability;
  const started = s.period > 0;
  const pct = (x, d) => (x * 100).toFixed(d) + " %";
  let signalNote = "Measured after the first " + s.period_payments + " payments.";
  if (started) {
    signalNote = s.signal < -0.02 ? "Payments are smaller than the target, so the rule mints."
      : s.signal > 0.02 ? "Payments are larger than the target, so the rule burns."
      : "On target: the rule leaves the supply alone.";
  }
  const budget = BigInt(s.period_budget);
  const remaining = BigInt(s.period_remaining);
  const abs = (x) => (x < 0n ? -x : x);
  const budgetValue = budget === 0n ? "none" : `${budget > 0n ? "+" : "−"}${fmt(abs(budget))}`;
  const budgetNote = budget === 0n ? "Nothing to mint or burn until the next adjustment."
    : `${fmt(abs(remaining))} PASTA still to be ${budget > 0n ? "minted into" : "burned from"} this period's payments, shared by size.`;
  const progress = Math.round((100 * s.payments_in_period) / s.period_payments);
  setHtml(el, [
    kpi("Supply", `${fmt(s.supply)}`, `PASTA in existence. ${fmt(s.genesis_supply)} came from the first block.`),
    kpi("Minted / burned", `+${fmt(s.minted)} / −${fmt(s.burned)}`, "Created and destroyed by the rule so far."),
    kpi("Target payment", `${fmt(s.target_median)}`, "PASTA: the size of a typical payment the rule aims for."),
    kpi("Typical payment now", started ? fmt(s.smoothed_median, 4) : "–", started ? "PASTA: smoothed median of recent payments." : "Measured after the first " + s.period_payments + " payments."),
    kpi("Signal", started ? (s.signal > 0 ? "+" : "") + pct(s.signal, 0) : "–", signalNote),
    kpi("Next adjustment", `${s.payments_in_period} of ${s.period_payments}`, `payments counted. ${s.period} adjustment${s.period === 1 ? "" : "s"} so far.`,
      `<div class="bar"><i style="width:${progress}%"></i></div>`),
    kpi("This period's budget", budgetValue, budgetNote),
    kpi("Cap", pct(s.cap_rate, 1), "of supply: the most one adjustment may mint or burn."),
  ].join(""));
  $("net-note").textContent = "Zero-amount transactions are not counted as payments and receive no mint.";
}

// ------------------------------------------------------------------ actions ----
async function onSend(ev) {
  ev.preventDefault();
  const w = activeWallet();
  if (!w) return say("send-msg", "Create or import a wallet first.", "err");
  if (!state.online) return say("send-msg", "The node is not reachable, so nothing can be sent.", "err");
  const to = $("send-to").value.trim();
  if (!isAddress(to)) return say("send-msg", "That is not a PaSta address. An address is the long code shown in the receiver's wallet.", "err");
  if (to === w.public_key) return say("send-msg", "That is your own address. Pick someone else's.", "err");
  let amount;
  try {
    amount = toUnits($("send-amount").value, units());
  } catch (err) {
    return say("send-msg", `Amount: ${err.message}.`, "err");
  }
  if (amount <= 0n) return say("send-msg", "Enter an amount above zero.", "err");
  const available = (state.balance ?? 0n) - (state.pendingOut ?? 0n);
  if (amount > available) return say("send-msg", `You have ${fmt(available)} PASTA available; that is not enough for ${fmt(amount)}.`, "err");

  $("btn-send").disabled = true;
  state.acting = true;
  say("send-msg", "Signing and sending…");
  try {
    const tx = await submitTransaction(w, to, amount);
    state.sent.push({ tx_id: tx.tx_id, from: w.public_key, to, amount: amount.toString() });
    $("send-amount").value = "";
    say("send-msg", `Sent ${fmt(amount)} PASTA. It becomes final when another user confirms it; follow it under “Your payments”.`, "ok");
  } catch (err) {
    say("send-msg", err.unreachable ? "The node did not answer. Nothing was sent." : `The node refused it: ${err.message}`, "err");
  } finally {
    state.acting = false;
    state.epoch++;
  }
  await refresh();
}

async function onConfirm(targetId) {
  const w = activeWallet();
  if (!w) return say("help-msg", "Create or import a wallet first.", "err");
  const target = state.mempool.find((t) => t.tx_id === targetId);
  if (!target) return say("help-msg", "That one has already been confirmed.", "err");
  if (state.acting) return;
  state.acting = true;
  say("help-msg", "Confirming…");
  try {
    // use a transaction of mine that still needs to validate something, or make a zero-amount one
    let mine = state.mempool.find((t) => t.state === "A" && t.sender_address === w.public_key);
    if (!mine) mine = await submitTransaction(w, w.public_key, 0n);
    await validate(mine.tx_id, targetId);
    say("help-msg", "Confirmed: that transaction is now on the chain. Your own validation transaction waits for someone else in turn.", "ok");
  } catch (err) {
    say("help-msg", err.unreachable ? "The node did not answer." : `The node refused: ${err.message}`, "err");
  } finally {
    state.acting = false;
    state.epoch++;
  }
  await refresh();
}

async function onVerify() {
  say("conn-msg", "Checking every block…");
  try {
    const r = await api("/verify");
    if (r.ok) say("conn-msg", `All ${state.status.height} blocks check out: links, signatures, proof-of-work, balances and every mint.`, "ok");
    else say("conn-msg", `The node reports ${r.problems.length} problem(s): ${r.problems.slice(0, 4).join("; ")}`, "err");
  } catch (err) {
    say("conn-msg", `Could not check: ${err.message}`, "err");
  }
}

function setActive(publicKey) {
  if (publicKey !== state.active) ["wallet-msg", "send-msg", "help-msg"].forEach((id) => say(id, ""));
  state.active = publicKey;
  state.balance = null;
  state.pendingOut = null;
  saveWallets();
  render();
  refresh();
}

function addWallet(name, keypair) {
  const existing = state.wallets.find((w) => w.public_key === keypair.public_key);
  if (!existing) {
    state.wallets.push({ name: name || `Wallet ${state.wallets.length + 1}`, private_key: keypair.private_key, public_key: keypair.public_key });
  }
  setActive(keypair.public_key);
  return !existing;
}

function openDialog(id) {
  const d = $(id);
  if (typeof d.showModal === "function") d.showModal();
  else d.setAttribute("open", "");
}
const closeDialog = (id) => $(id).close();

function onImport() {
  const raw = $("import-text").value.trim();
  if (!raw) return say("import-msg", "Paste a private key or choose a wallet file.", "err");
  let priv = raw, claimedPub = null;
  if (raw.startsWith("{")) {
    try {
      const j = JSON.parse(raw);
      priv = String(j.private_key || "");
      claimedPub = j.public_key || null;
    } catch {
      return say("import-msg", "That file is not valid JSON.", "err");
    }
  }
  let pub;
  try {
    pub = publicKeyFor(priv);
  } catch {
    return say("import-msg", "That is not a PaSta private key.", "err");
  }
  if (claimedPub && claimedPub !== pub) return say("import-msg", "The file's address does not belong to its private key.", "err");
  const added = addWallet($("import-name").value.trim(), { private_key: priv.trim(), public_key: pub });
  $("import-text").value = "";
  $("import-name").value = "";
  $("import-file").value = "";
  say("import-msg", "");
  closeDialog("dlg-import");
  say("wallet-msg", added ? "Wallet imported. It is stored in this browser only." : "That wallet was already here; switched to it.", "ok");
}

function openManage() {
  const w = activeWallet();
  if (!w) return;
  $("manage-name").textContent = w.name;
  $("manage-address").textContent = w.public_key;
  $("manage-key").textContent = "••••••••••••••••";
  $("manage-show").textContent = "Show";
  $("manage-remove").textContent = "Remove from this browser";
  $("manage-remove").dataset.armed = "";
  say("manage-msg", "");
  openDialog("dlg-manage");
}

function onDownload() {
  const w = activeWallet();
  const blob = new Blob([JSON.stringify({ private_key: w.private_key, public_key: w.public_key }, null, 1)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `pasta-wallet-${w.name.replace(/[^\w-]+/g, "_") || "backup"}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  say("manage-msg", "Backup file downloaded. Keep it private: it is the key itself.", "ok");
}

function onRemove() {
  const btn = $("manage-remove");
  if (!btn.dataset.armed) {
    btn.dataset.armed = "1";
    btn.textContent = "Click again to remove for good";
    return say("manage-msg", "Without a backup, removing the wallet loses its coins permanently.", "err");
  }
  state.wallets = state.wallets.filter((w) => w.public_key !== state.active);
  closeDialog("dlg-manage");
  setActive(state.wallets.length ? state.wallets[0].public_key : null);
  say("wallet-msg", "Wallet removed from this browser.", "ok");
}

async function copyAddress() {
  const w = activeWallet();
  if (!w) return;
  try {
    await navigator.clipboard.writeText(w.public_key);
  } catch {
    const range = document.createRange();
    range.selectNodeContents($("address"));
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    try { document.execCommand("copy"); } catch { /* the address is selected; the visitor can copy by hand */ }
  }
  $("btn-copy").textContent = "Copied";
  setTimeout(() => { $("btn-copy").textContent = "Copy"; }, 1500);
}

function connectTo(url) {
  state.node = url;
  store.set("pasta.node", url);
  Object.assign(state, { online: null, status: null, mempool: [], chain: [], balance: null, pendingOut: null, sent: [] });
  say("conn-msg", "");
  render();
  refresh();
}

// ------------------------------------------------------------------- wiring ----
function wire() {
  document.querySelectorAll("dialog [data-close]").forEach((b) => b.addEventListener("click", () => b.closest("dialog").close()));

  const openNew = () => { $("new-name").value = ""; openDialog("dlg-new"); };
  const openImport = () => { say("import-msg", ""); openDialog("dlg-import"); };
  $("btn-new-first").addEventListener("click", openNew);
  $("btn-new").addEventListener("click", openNew);
  $("btn-import-first").addEventListener("click", openImport);
  $("btn-import").addEventListener("click", openImport);
  $("new-ok").addEventListener("click", () => {
    addWallet($("new-name").value.trim(), generateKeypair());
    closeDialog("dlg-new");
    say("wallet-msg", "Wallet created. It lives in this browser only: use “Back up” before you rely on it.", "ok");
  });
  $("import-ok").addEventListener("click", onImport);
  $("import-file").addEventListener("change", async (ev) => {
    const file = ev.target.files && ev.target.files[0];
    if (file) $("import-text").value = (await file.text()).trim();
  });

  $("wallet-select").addEventListener("change", (ev) => setActive(ev.target.value));
  $("btn-copy").addEventListener("click", copyAddress);
  $("btn-manage").addEventListener("click", openManage);
  $("manage-show").addEventListener("click", () => {
    const w = activeWallet();
    const hidden = $("manage-show").textContent === "Show";
    $("manage-key").textContent = hidden ? w.private_key : "••••••••••••••••";
    $("manage-show").textContent = hidden ? "Hide" : "Show";
  });
  $("manage-download").addEventListener("click", onDownload);
  $("manage-remove").addEventListener("click", onRemove);

  $("send-form").addEventListener("submit", onSend);
  $("help-list").addEventListener("click", (ev) => {
    const btn = ev.target.closest("[data-confirm]");
    if (btn) onConfirm(btn.dataset.confirm);
  });

  $("feed-all").addEventListener("change", renderFeed);
  $("btn-verify").addEventListener("click", onVerify);
  $("btn-node").addEventListener("click", () => { $("node-url").value = state.node; openDialog("dlg-node"); });
  $("node-default").addEventListener("click", () => { $("node-url").value = DEFAULT_NODE; });
  $("node-ok").addEventListener("click", () => {
    try {
      const url = cleanNodeUrl($("node-url").value);
      closeDialog("dlg-node");
      connectTo(url);
    } catch (err) {
      say("conn-msg", `That is not a usable address: ${err.message}`, "err");
      closeDialog("dlg-node");
    }
  });

  document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });
  setInterval(() => { if (!document.hidden) refresh(); }, POLL_MS);
}

if (state.active && !activeWallet()) state.active = state.wallets.length ? state.wallets[0].public_key : null;
wire();
render();
refresh();
