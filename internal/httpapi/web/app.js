"use strict";

const form = document.getElementById("auth-form");
const email = document.getElementById("email");
const password = document.getElementById("password");
const loginMode = document.getElementById("login-mode");
const registerMode = document.getElementById("register-mode");
const submitButton = document.getElementById("submit-button");
const submitLabel = document.getElementById("submit-label");
const togglePassword = document.getElementById("toggle-password");
const result = document.getElementById("result");
const resultTitle = document.getElementById("result-title");
const resultMessage = document.getElementById("result-message");
const userIDRow = document.getElementById("user-id-row");
const userID = document.getElementById("user-id");
const connectionStatus = document.getElementById("connection-status");
const checkConnection = document.getElementById("check-connection");
let mode = "login";
let pending = false;

function clearResult() {
  result.hidden = true;
  resultTitle.textContent = "";
  resultMessage.textContent = "";
  userID.textContent = "";
  userIDRow.hidden = true;
}

function hidePassword() {
  password.type = "password";
  togglePassword.textContent = "表示";
  togglePassword.setAttribute("aria-pressed", "false");
  togglePassword.setAttribute("aria-label", "パスワードを表示");
}

function setMode(nextMode) {
  if (pending) return;
  mode = nextMode;
  const registering = mode === "register";
  loginMode.setAttribute("aria-pressed", String(!registering));
  registerMode.setAttribute("aria-pressed", String(registering));
  document.getElementById("form-eyebrow").textContent = registering ? "CREATE YOUR ACCOUNT" : "WELCOME BACK";
  document.getElementById("form-title").textContent = registering ? "ユーザーを登録する" : "ログインを試す";
  document.getElementById("form-description").textContent = registering
    ? "初めての方は、ここからユーザーを作成できます。"
    : "登録したメールアドレスとパスワードを入力してください。";
  document.getElementById("password-help").textContent = registering
    ? "全角などの表記を正規化した後で、12〜128文字。"
    : "登録時に使ったパスワードを入力してください。";
  submitLabel.textContent = registering ? "ユーザーを登録する" : "ログインする";
  password.autocomplete = registering ? "new-password" : "current-password";
  form.action = registering ? "/v1/users" : "/v1/sessions";
  password.value = "";
  hidePassword();
  clearResult();
}

function showResult(kind, title, message, id) {
  result.dataset.kind = kind;
  resultTitle.textContent = title;
  resultMessage.textContent = message;
  if (id) {
    userID.textContent = id;
    userIDRow.hidden = false;
  }
  result.hidden = false;
}

async function checkHealth() {
  checkConnection.disabled = true;
  connectionStatus.dataset.state = "checking";
  connectionStatus.textContent = "接続を確認中";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch("/healthz", { cache: "no-store", credentials: "omit", signal: controller.signal });
    if (!response.ok) throw new Error("Health check failed");
    connectionStatus.dataset.state = "connected";
    connectionStatus.textContent = "サーバーに接続済み";
  } catch {
    connectionStatus.dataset.state = "disconnected";
    connectionStatus.textContent = "サーバーに接続できません";
  } finally {
    clearTimeout(timer);
    checkConnection.disabled = false;
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (pending) return;
  pending = true;
  clearResult();
  const registering = mode === "register";
  const body = JSON.stringify({ email: email.value, password: password.value });
  for (const control of [email, password, loginMode, registerMode, togglePassword, submitButton]) control.disabled = true;
  form.setAttribute("aria-busy", "true");
  submitLabel.textContent = registering ? "登録しています…" : "照合しています…";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 35000);
  try {
    const response = await fetch(registering ? "/v1/users" : "/v1/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      credentials: "omit",
      cache: "no-store",
      signal: controller.signal,
    });
    const data = await response.json();
    if (!response.ok) {
      showResult("error", registering ? "登録できませんでした" : "ログインできませんでした",
        typeof data.detail === "string" ? data.detail : "処理に失敗しました。時間をおいて、もう一度お試しください。");
      return;
    }
    if (typeof data.user_id !== "string" || !data.user_id) throw new Error("Invalid response");
    showResult("success", registering ? "ユーザーを登録しました" : "ログインを確認しました",
      registering ? "「ログイン」に切り替えて、同じ情報で試してください。" : "登録したユーザーと一致しました。", data.user_id);
  } catch {
    showResult("error", "応答を確認できませんでした", "サーバーの起動と接続を確認してください。登録された可能性もあるため、ログインで確認できます。");
  } finally {
    clearTimeout(timer);
    password.value = "";
    hidePassword();
    pending = false;
    for (const control of [email, password, loginMode, registerMode, togglePassword, submitButton]) control.disabled = false;
    form.setAttribute("aria-busy", "false");
    submitLabel.textContent = registering ? "ユーザーを登録する" : "ログインする";
  }
});

loginMode.addEventListener("click", () => setMode("login"));
registerMode.addEventListener("click", () => setMode("register"));
togglePassword.addEventListener("click", () => {
  const visible = password.type === "password";
  password.type = visible ? "text" : "password";
  togglePassword.textContent = visible ? "隠す" : "表示";
  togglePassword.setAttribute("aria-pressed", String(visible));
  togglePassword.setAttribute("aria-label", visible ? "パスワードを隠す" : "パスワードを表示");
});
checkConnection.addEventListener("click", checkHealth);
window.addEventListener("pageshow", () => { password.value = ""; hidePassword(); });
form.hidden = false;
loginMode.disabled = false;
registerMode.disabled = false;
checkHealth();
