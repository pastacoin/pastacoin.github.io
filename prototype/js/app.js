// Copied from local prototype
import '../polyfill.js'; // placeholder if needed

const API_BASE = window.API_BASE || ""; // same origin default

window.addEventListener("hashchange", render);
window.addEventListener("DOMContentLoaded", render);

function render() {
  const hash = window.location.hash.slice(1) || "wallet";
  const app = document.getElementById("app");
  switch (hash) {
    case "wallet":
      return renderWallet(app);
    case "create":
      return renderCreateTx(app);
    case "validateB":
      return renderValidateB(app);
    case "validateC":
      return renderValidateC(app);
    case "mempool":
      return renderMempool(app);
    case "blockchain":
      return renderBlockchain(app);
    default:
      app.textContent = "Page not found";
  }
}

function renderWallet(root) {
  root.innerHTML = `
    <h2>Wallet</h2>
    <button id="genKeyBtn">Generate Keypair</button>
    <pre id="keypair"></pre>
  `;
  document.getElementById("genKeyBtn").onclick = async () => {
    const res = await fetch(`${API_BASE}/generate_keypair`);
    const data = await res.json();
    document.getElementById("keypair").textContent = JSON.stringify(data, null, 2);
  };
}

function renderCreateTx(root) {
  root.innerHTML = `
    <h2>Create Transaction (State A)</h2>
    <form id="createForm">
      <label>Private Key:<br><input type="text" name="priv" required></label><br>
      <label>Sender Address:<br><input type="text" name="sender" required></label><br>
      <label>Receiver Address:<br><input type="text" name="receiver" required></label><br>
      <label>Amount:<br><input type="number" step="0.01" name="amount" required></label><br>
      <button type="submit">Send</button>
    </form>
    <pre id="createResult"></pre>
  `;
  document.getElementById("createForm").onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const body = {
      private_key: fd.get("priv"),
      sender: fd.get("sender"),
      receiver: fd.get("receiver"),
      amount: parseFloat(fd.get("amount")),
    };
    const res = await fetch(`${API_BASE}/create_transaction`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    document.getElementById("createResult").textContent = JSON.stringify(data, null, 2);
  };
}

function renderValidateB(root) {
  root.innerHTML = `<h2>Validate Transaction (State B)</h2>
    <button id="loadMem">Load Mempool</button>
    <select id="targetSel"></select>
    <h3>Create Validating Transaction</h3>
    <form id="validateBForm">
      <label>Private Key:<br><input type="text" name="priv" required></label><br>
      <label>Sender Address:<br><input type="text" name="sender" required></label><br>
      <label>Receiver Address:<br><input type="text" name="receiver" required></label><br>
      <label>Amount:<br><input type="number" step="0.01" name="amount" required></label><br>
      <button type="submit">Validate</button>
    </form>
    <pre id="validateBResult"></pre>`;

  const loadMem = async () => {
    const res = await fetch(`${API_BASE}/mempool`);
    const mem = await res.json();
    const sel = document.getElementById("targetSel");
    sel.innerHTML = mem
      .map((tx, i) => `<option value="${i}">${i}: ${tx.signature.substring(0, 8)}... (${tx.state})</option>`)
      .join("");
  };
  document.getElementById("loadMem").onclick = loadMem;
  loadMem();

  document.getElementById("validateBForm").onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const body = {
      private_key: fd.get("priv"),
      sender: fd.get("sender"),
      receiver: fd.get("receiver"),
      amount: parseFloat(fd.get("amount")),
      target_index: parseInt(document.getElementById("targetSel").value, 10),
    };
    const res = await fetch(`${API_BASE}/advance_b`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    document.getElementById("validateBResult").textContent = JSON.stringify(data, null, 2);
  };
}

function renderValidateC(root) {
  root.innerHTML = `<h2>Confirm Transaction (State C)</h2>
    <button id="loadMemC">Load Mempool</button>
    <select id="targetSelC"></select>
    <h3>Create Confirmation Transaction</h3>
    <form id="validateCForm">
      <label>Private Key:<br><input type="text" name="priv" required></label><br>
      <label>Sender Address:<br><input type="text" name="sender" required></label><br>
      <label>Receiver Address:<br><input type="text" name="receiver" required></label><br>
      <label>Amount:<br><input type="number" step="0.01" name="amount" required></label><br>
      <button type="submit">Confirm</button>
    </form>
    <pre id="validateCResult"></pre>`;

  const loadMem = async () => {
    const res = await fetch(`${API_BASE}/mempool`);
    const mem = await res.json();
    const sel = document.getElementById("targetSelC");
    sel.innerHTML = mem
      .map((tx, i) => `<option value="${i}">${i}: ${tx.signature.substring(0, 8)}... (${tx.state})</option>`)
      .join("");
  };
  document.getElementById("loadMemC").onclick = loadMem;
  loadMem();

  document.getElementById("validateCForm").onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const body = {
      private_key: fd.get("priv"),
      sender: fd.get("sender"),
      receiver: fd.get("receiver"),
      amount: parseFloat(fd.get("amount")),
      target_index: parseInt(document.getElementById("targetSelC").value, 10),
    };
    const res = await fetch(`${API_BASE}/advance_c`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    document.getElementById("validateCResult").textContent = JSON.stringify(data, null, 2);
  };
}

function renderMempool(root) {
  root.innerHTML = `<h2>Mempool</h2><button id="refresh">Refresh</button><pre id="mempoolData"></pre>`;
  const load = async () => {
    const res = await fetch(`${API_BASE}/mempool`);
    const data = await res.json();
    document.getElementById("mempoolData").textContent = JSON.stringify(data, null, 2);
  };
  document.getElementById("refresh").onclick = load;
  load();
}

function renderBlockchain(root) {
  root.innerHTML = `<h2>Blockchain</h2><button id="refreshBC">Refresh</button><pre id="bcData"></pre>`;
  const load = async () => {
    const res = await fetch(`${API_BASE}/blockchain`);
    const data = await res.json();
    document.getElementById("bcData").textContent = JSON.stringify(data, null, 2);
  };
  document.getElementById("refreshBC").onclick = load;
  load();
} 